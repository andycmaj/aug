// The Board's Wins tab: a day's Wins and how each came out, then what else
// got done that day. A day is the owner's local date, as Wins are pinned
// (localDay). Everything reads newest first. History comes from task_events (triggers in db.ts), turns
// and moves, so a past day reads the same after its tasks move on.

import { laneOf, type Lane } from "./lanes";
import { localDay } from "./rail";
import { parseTaskRef } from "./rows";
import { taskPrStatus } from "./pr";
import * as store from "./store";
import {
  Kind,
  TaskEventKind,
  TaskStatus,
  TurnRole,
  type MoveRow,
  type PrStatusRow,
  type SpendTotal,
  type TaskEventRow,
  type TaskRow,
  type TurnRow,
} from "./types";
import type { PrRef } from "./pr";

// How a task stood when the day ended (today: now).
export const Outcome = {
  done: "done",
  merged: "merged",
  dropped: "dropped",
  later: "later",
  open: "open",
} as const;
export type Outcome = (typeof Outcome)[keyof typeof Outcome];

export interface DayRow {
  task: TaskRow;
  win: boolean;
  outcome: Outcome;
  // Today only: its lane now, how far it has come.
  lane: Lane | null;
  // That day's events, newest first.
  events: TaskEventRow[];
  // Turns that day: the owner's lines and the agent's answers.
  you: number;
  agent: number;
  // The latest event or turn that day: rows sort on it, newest first.
  last: string | null;
}

export interface WinsDay {
  day: string;
  isToday: boolean;
  wins: DayRow[];
  // Not a Win, but something happened to it that day: closed, merged, its
  // agent finished, or turns from you or its agent.
  also: DayRow[];
  // Tasks made that day, and moves asked through the bus.
  made: number;
  moves: number;
}

export interface WinDetail {
  task: TaskRow;
  events: TaskEventRow[];
  // The day's turns, the newest few, newest first.
  turns: TurnRow[];
  moreTurns: number;
  moves: MoveRow[];
  pr: { pr: PrRef; status: PrStatusRow | null } | null;
  // How long its agent's sessions ran within the day.
  agentMs: number;
  spend: SpendTotal;
}

const DETAIL_TURNS = 6;

// The local day's span as ISO instants, for comparing with stored times.
export function dayBounds(day: string): { from: string; to: string } {
  const [y, m, d] = day.split("-").map(Number);
  return {
    from: new Date(y, m - 1, d).toISOString(),
    to: new Date(y, m - 1, d + 1).toISOString(),
  };
}

export function shiftDay(day: string, by: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return localDay(new Date(y, m - 1, d + by));
}

// Replays a task's events: where it stood after the last of them.
export function outcomeOf(events: TaskEventRow[]): Outcome {
  let status: Outcome = Outcome.open;
  let merged = false;
  for (const e of events) {
    if (e.kind === TaskEventKind.done) {
      status = Outcome.done;
    } else if (e.kind === TaskEventKind.dropped) {
      status = Outcome.dropped;
    } else if (e.kind === TaskEventKind.later) {
      status = Outcome.later;
    } else if (e.kind === TaskEventKind.reopened) {
      status = Outcome.open;
    } else if (e.kind === TaskEventKind.merged) {
      merged = true;
    } else if (e.kind === TaskEventKind.unmerged) {
      merged = false;
    }
  }
  if (status !== Outcome.open && status !== Outcome.later) {
    return status;
  }
  return merged ? Outcome.merged : status;
}

// Today the task's own columns say it best.
function outcomeNow(task: TaskRow): Outcome {
  if (task.status === TaskStatus.done) {
    return Outcome.done;
  }
  if (task.status === TaskStatus.dropped) {
    return Outcome.dropped;
  }
  if (task.merged_at) {
    return Outcome.merged;
  }
  if (task.status === TaskStatus.later) {
    return Outcome.later;
  }
  return Outcome.open;
}

// What lifts a non-Win into "also done": a close, a merge, a finish.
const LANDED: ReadonlySet<string> = new Set([
  TaskEventKind.done,
  TaskEventKind.dropped,
  TaskEventKind.merged,
  TaskEventKind.finished,
]);

export function winsDay(day: string, now: Date): WinsDay {
  const isToday = day === localDay(now);
  const { from, to } = dayBounds(day);
  const events = store.eventsBetween(from, to);
  const counts = store.turnCountsBetween(from, to);
  const pending = isToday ? store.tasksWithPendingAction() : new Set<number>();
  const prStates = isToday ? store.prStates() : new Map<number, string>();
  const blockers = isToday ? store.allBlockers() : new Map<number, number[]>();

  const tasks = new Map<number, TaskRow | null>();
  const taskOf = (id: number): TaskRow | null => {
    if (!tasks.has(id)) {
      const t = store.getTask(id);
      tasks.set(id, t && t.kind !== Kind.home ? t : null);
    }
    return tasks.get(id) ?? null;
  };

  const row = (task: TaskRow, win: boolean): DayRow => {
    const own = events.filter((e) => e.task_id === task.id).reverse();
    const turns = counts.filter((c) => c.task_id === task.id);
    const last =
      [...own.map((e) => e.at), ...turns.map((c) => c.last)].sort().pop() ??
      null;
    return {
      task,
      win,
      outcome: isToday
        ? outcomeNow(task)
        : outcomeOf(store.eventsForTask(task.id, to)),
      lane: isToday
        ? laneOf(task, {
            hasPendingAction: pending.has(task.id),
            prState: prStates.get(task.id) ?? null,
            blockers: blockers.get(task.id)?.length ?? 0,
          })
        : null,
      events: own,
      you: turns.find((c) => c.role === TurnRole.you)?.n ?? 0,
      agent: turns.find((c) => c.role === TurnRole.agent)?.n ?? 0,
      last,
    };
  };
  // Newest activity first; then the later pinned (or higher id) first.
  const newest = (order: (r: DayRow) => number) => (a: DayRow, b: DayRow) =>
    (b.last ?? "").localeCompare(a.last ?? "") || order(b) - order(a);

  const winIds = store.winsOn(day);
  const wins = winIds
    .flatMap((id) => {
      const t = taskOf(id);
      return t ? [row(t, true)] : [];
    })
    .sort(newest((r) => winIds.indexOf(r.task.id)));

  const touched = new Set<number>();
  for (const e of events) {
    if (LANDED.has(e.kind)) {
      touched.add(e.task_id);
    }
  }
  for (const c of counts) {
    touched.add(c.task_id);
  }
  const also = [...touched]
    .filter((id) => !winIds.includes(id))
    .flatMap((id) => {
      const t = taskOf(id);
      return t ? [row(t, false)] : [];
    })
    .sort(newest((r) => r.task.id));

  return {
    day,
    isToday,
    wins,
    also,
    made: events.filter(
      (e) => e.kind === TaskEventKind.created && taskOf(e.task_id),
    ).length,
    moves: store.movesBetween(from, to).length,
  };
}

function movesFor(taskId: number, from: string, to: string): MoveRow[] {
  return store.movesBetween(from, to).filter((m) => {
    try {
      const args = JSON.parse(m.args) as Record<string, unknown>;
      return (
        typeof args.task === "string" && parseTaskRef(args.task) === taskId
      );
    } catch {
      return false;
    }
  });
}

// How long a task's agent sessions ran inside [from, to). A session still
// open counts to its last hook event.
function agentMs(taskId: number, from: string, to: string): number {
  const lo = Date.parse(from);
  const hi = Date.parse(to);
  let ms = 0;
  for (const s of store.sessionsForTask(taskId)) {
    const start = Math.max(lo, Date.parse(s.started_at));
    const end = Math.min(hi, Date.parse(s.ended_at ?? s.last_event_at));
    if (end > start) {
      ms += end - start;
    }
  }
  return ms;
}

export function winDetail(taskId: number, day: string): WinDetail | null {
  const task = store.getTask(taskId);
  if (!task) {
    return null;
  }
  const { from, to } = dayBounds(day);
  const turns = store.turnsForTaskBetween(taskId, from, to);
  return {
    task,
    events: store
      .eventsBetween(from, to)
      .filter((e) => e.task_id === taskId)
      .reverse(),
    turns: turns.slice(-DETAIL_TURNS).reverse(),
    moreTurns: Math.max(0, turns.length - DETAIL_TURNS),
    moves: movesFor(taskId, from, to).reverse(),
    pr: taskPrStatus(task),
    agentMs: agentMs(taskId, from, to),
    spend: store.taskSpendOn(taskId, day),
  };
}

// One phrase per event, for a row's line and the detail.
export function eventWords(e: TaskEventRow): string {
  switch (e.kind) {
    case TaskEventKind.created:
      return "made";
    case TaskEventKind.done:
      return e.detail ? `done by ${e.detail}` : "done";
    case TaskEventKind.dropped:
      return "dropped";
    case TaskEventKind.later:
      return "for later";
    case TaskEventKind.reopened:
      return "reopened";
    case TaskEventKind.merged:
      return "merged";
    case TaskEventKind.unmerged:
      return "unmerged";
    case TaskEventKind.finished:
      return "agent finished";
    case TaskEventKind.ended:
      return "session ended";
  }
}
