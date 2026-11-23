// ctrl+z: the moves made this session, newest first, each with what it
// changed. A move on a task keeps the task as it was before and after; undo
// puts back only what the move changed, and only while the task still has
// what the move left (anything newer is never overwritten). A move with
// effects outside Riker's own rows (an agent started, a draft sent, a project
// archived) is kept as one that cannot be undone, so ctrl+z says so instead
// of reaching past it to an older one. In memory: a restart starts empty.

import { AsyncLocalStorage } from "node:async_hooks";
import type { RikerConfig } from "./config";
import { holdForStart, holdReleased, HELD_FOR_START } from "./lifecycle";
import * as projects from "./projects";
import { briefEditable } from "./read-model";
import { isClosed } from "./rows";
import { MAX_WINS } from "./rail";
import * as store from "./store";
import {
  AgentState,
  Kind,
  SessionKind,
  TaskStatus,
  TurnRole,
  type MessageRow,
  type TaskRow,
} from "./types";

const FIELDS = [
  "status",
  "closed_at",
  "closed_by",
  "remind_at",
  "priority",
  "priority_pinned",
  "project_id",
  "goal_id",
  "title",
  "summary",
  "kind",
  "waiting_on",
  "watching",
  "story",
] as const;
type Field = (typeof FIELDS)[number];

interface Link {
  url: string;
  title: string | null;
  added_by: string;
}

// A message filed under the task, as triage left it (ignore refiles them).
type Filed = Pick<MessageRow, "id" | "verdict" | "reason" | "task_id">;

// What a move can change about a task, all of it.
export interface TaskSnap {
  fields: Pick<TaskRow, Field>;
  // Held for the owner's Start (a kind change to coding puts it on).
  held: boolean;
  blockers: number[];
  // The tasks blocked by this one (marking it done frees them).
  dependents: number[];
  win: boolean;
  links: Link[];
  messages: Filed[];
}

type Part = Field | Exclude<keyof TaskSnap, "fields">;

const PART_WORDS: Partial<Record<Part, string>> = {
  closed_at: "status",
  closed_by: "status",
  remind_at: "reminder",
  priority_pinned: "priority",
  project_id: "project",
  goal_id: "goal",
  summary: "brief",
  waiting_on: "waiting",
  watching: "watching",
  story: "story switch",
  held: "start hold",
  dependents: "blocked tasks",
};

export function snapshot(taskId: number, day: string): TaskSnap | null {
  const task = store.getTask(taskId);
  if (!task) return null;
  const fields = Object.fromEntries(FIELDS.map((f) => [f, task[f]])) as Pick<TaskRow, Field>;
  return {
    fields,
    held: task.agent_state === AgentState.queued && task.queue_reason === HELD_FOR_START,
    blockers: store.blockersOf(taskId),
    dependents: store.dependentsOf(taskId),
    win: store.winsOn(day).includes(taskId),
    links: store
      .linksForTask(taskId)
      .map((l) => ({ url: l.url, title: l.title, added_by: l.added_by })),
    messages: store
      .messagesForTask(taskId)
      .map((m) => ({ id: m.id, verdict: m.verdict, reason: m.reason, task_id: m.task_id })),
  };
}

function partOf(snap: TaskSnap, part: Part): unknown {
  return part in snap.fields ? snap.fields[part as Field] : snap[part as keyof TaskSnap];
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const PARTS: Part[] = [...FIELDS, "held", "blockers", "dependents", "win", "links", "messages"];

function changed(before: TaskSnap, after: TaskSnap): Part[] {
  return PARTS.filter((p) => !same(partOf(before, p), partOf(after, p)));
}

export type UndoEntry =
  | {
      type: "task";
      // The move as the toast names it: "done", "priority".
      what: string;
      taskId: number;
      // Wins are by day: the day the move pinned or unpinned on.
      day: string;
      before: TaskSnap;
      after: TaskSnap;
      parts: Part[];
      by: string;
    }
  | { type: "cannot"; what: string; why: string; by: string };

export type UndoDraft =
  | Omit<Extract<UndoEntry, { type: "task" }>, "by">
  | Omit<Extract<UndoEntry, { type: "cannot" }>, "by">;

// A task move's entry, or none when it changed nothing.
export function taskDraft(
  what: string,
  taskId: number,
  day: string,
  before: TaskSnap | null,
): UndoDraft | null {
  const after = snapshot(taskId, day);
  if (!before || !after) return null;
  const parts = changed(before, after);
  return parts.length ? { type: "task", what, taskId, day, before, after, parts } : null;
}

export function label(entry: UndoEntry | UndoDraft): string {
  return entry.type === "task" ? `${entry.what} ${store.taskRef(entry.taskId)}` : entry.what;
}

interface Frame {
  by: string;
  // A desk method recorded this move (either kind of entry).
  recorded: boolean;
  // Inside a recorded desk method: what it calls is part of the same move.
  inside: boolean;
}

export const UNDO_DEPTH = 50;

export class UndoStack {
  private entries: UndoEntry[] = [];
  private scope = new AsyncLocalStorage<Frame>();

  constructor(private depth = UNDO_DEPTH) {}

  get size(): number {
    return this.entries.length;
  }

  peek(): UndoEntry | undefined {
    return this.entries.at(-1);
  }

  pop(): UndoEntry | undefined {
    return this.entries.pop();
  }

  // A move asked through the move bus: who asked, and whether a desk method
  // recorded it. A task's own agent moves in the background; ctrl+z is the
  // owner's and the Assistant's moves, so an agent's are never kept.
  async asMove<T>(by: string, fn: () => Promise<T>): Promise<{ value: T; recorded: boolean }> {
    const frame: Frame = { by, recorded: false, inside: false };
    const value = await this.scope.run(frame, fn);
    return { value, recorded: frame.recorded };
  }

  // One desk method's change, recorded once however many others it calls.
  // The scope rides through awaits, so two moves at once never mix.
  track<T>(fn: () => T, draft: (value: T) => UndoDraft | null): T {
    const outer = this.scope.getStore();
    if (outer?.inside) return fn();
    const frame: Frame = { by: outer?.by ?? "you", recorded: false, inside: true };
    const value = this.scope.run(frame, fn);
    if (outer) outer.recorded = true;
    this.keep(frame.by, draft(value));
    return value;
  }

  async trackAsync<T>(fn: () => Promise<T>, draft: (value: T) => UndoDraft | null): Promise<T> {
    const outer = this.scope.getStore();
    if (outer?.inside) return fn();
    const frame: Frame = { by: outer?.by ?? "you", recorded: false, inside: true };
    const value = await this.scope.run(frame, fn);
    if (outer) outer.recorded = true;
    this.keep(frame.by, draft(value));
    return value;
  }

  // Who is making the move under way: the move bus's asker, else the owner.
  by(): string {
    return this.scope.getStore()?.by ?? "you";
  }

  // A move that went through no desk method: it cannot be undone.
  cannot(what: string, why: string, by = this.scope.getStore()?.by ?? "you"): void {
    this.keep(by, { type: "cannot", what, why });
  }

  private keep(by: string, draft: UndoDraft | null): void {
    if (!draft || by.startsWith("agent ")) return;
    this.entries.push({ ...draft, by } as UndoEntry);
    if (this.entries.length > this.depth) this.entries.shift();
  }
}

export interface UndoResult {
  ok: boolean;
  text: string;
}

function whose(entry: UndoEntry): string {
  return entry.by === "you" ? "" : ` (${entry.by}'s move)`;
}

function words(parts: Part[]): string {
  return [...new Set(parts.map((p) => PART_WORDS[p] ?? p))].join(", ");
}

// Puts back what the newest move changed. Refused, with why, when it cannot
// be undone or the task changed since; either way it leaves the stack, so
// the next ctrl+z reaches the move before it.
export async function revert(config: RikerConfig, entry: UndoEntry): Promise<UndoResult> {
  const name = label(entry);
  if (entry.type === "cannot")
    return { ok: false, text: `Can't undo ${name}${whose(entry)}: ${entry.why}` };
  const ref = store.taskRef(entry.taskId);
  const now = snapshot(entry.taskId, entry.day);
  if (!now) return { ok: false, text: `Can't undo ${name}: ${ref} is gone` };
  const stale = entry.parts.filter((p) => !same(partOf(now, p), partOf(entry.after, p)));
  if (stale.length)
    return {
      ok: false,
      text: `Can't undo ${name}: ${ref}'s ${words(stale)} changed since`,
    };
  const { before } = entry;
  const has = (p: Part) => entry.parts.includes(p);
  if (has("summary") && !briefEditable(entry.taskId))
    return { ok: false, text: `Can't undo ${name}: its agent already started from that brief` };
  if (has("win") && before.win && store.winsOn(entry.day).length >= MAX_WINS)
    return { ok: false, text: `Can't undo ${name}: that day has ${MAX_WINS} Wins` };

  // A window follows its project: moved back the way it came.
  const task = store.getTask(entry.taskId)!;
  if (
    has("project_id") &&
    before.fields.project_id !== null &&
    store.latestSession(task.id)?.kind === SessionKind.tmux
  )
    await projects.moveTask(config, task.id, before.fields.project_id);

  store.batch(() => {
    const fields = FIELDS.filter((f) => has(f));
    if (fields.length)
      store.updateTask(
        task.id,
        Object.fromEntries(fields.map((f) => [f, before.fields[f]])) as Partial<TaskRow>,
      );
    if (has("held")) {
      if (before.held) holdForStart(task.id);
      else holdReleased(task.id);
    }
    if (has("blockers")) {
      for (const id of now.blockers)
        if (!before.blockers.includes(id)) store.removeBlocker(task.id, id);
      for (const id of before.blockers)
        if (!now.blockers.includes(id) && store.getTask(id)) store.addBlocker(task.id, id, entry.by);
    }
    if (has("dependents")) {
      for (const id of now.dependents)
        if (!before.dependents.includes(id)) store.removeBlocker(id, task.id);
      for (const id of before.dependents) {
        const dependent = store.getTask(id);
        if (now.dependents.includes(id) || !dependent || isClosed(dependent)) continue;
        store.addBlocker(id, task.id, entry.by);
        store.addTurn({
          taskId: id,
          role: TurnRole.trigger,
          body: `${ref} is open again (undone): blocked by it again`,
        });
      }
    }
    if (has("win")) {
      if (before.win) store.addWin(entry.day, task.id);
      else store.removeWin(entry.day, task.id);
    }
    if (has("links")) {
      const kept = new Set(before.links.map((l) => l.url));
      for (const l of now.links) if (!kept.has(l.url)) store.removeTaskLink(task.id, l.url);
      const had = new Set(now.links.map((l) => l.url));
      for (const l of before.links)
        if (!had.has(l.url)) store.addTaskLink(task.id, l.url, l.title, l.added_by);
    }
    // Ignore refiled its messages as FYI: each goes back under the task, as
    // triage filed it, unless something filed it again since.
    if (has("messages")) {
      const kept = new Set(now.messages.map((m) => m.id));
      for (const m of before.messages) {
        if (kept.has(m.id)) continue;
        const row = store.getMessage(m.id);
        if (row && row.task_id === null) store.fileMessage(m.id, m.verdict, m.reason, m.task_id);
      }
    }
    store.addTurn({ taskId: task.id, role: TurnRole.trigger, body: `Undone: ${entry.what}` });
  });

  // Marking done closed a coding agent's window; reopening does not bring it
  // back, Start does.
  const reopened =
    has("status") &&
    isClosed(entry.after.fields) &&
    !isClosed(before.fields) &&
    task.kind === Kind.coding;
  return {
    ok: true,
    text: `undid: ${name}${whose(entry)}${reopened ? "; s starts its agent again" : ""}`,
  };
}
