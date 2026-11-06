// Typed reads and writes over the database. Every write calls `changed()` so
// in-process listeners (the TUI) re-read; writes from other processes surface
// through `dataVersion()`.

import type { SQLQueryBindings } from "bun:sqlite";
import { db, now } from "./db";
import {
  ActionState,
  AgentState,
  TaskStatus,
  TurnRole,
  type Channel,
  type CorrectionRow,
  type DraftAction,
  type HubRow,
  type IdeaRow,
  type Kind,
  type MessageRow,
  type NoteLabel,
  type NoteRow,
  type Priority,
  type SessionKind,
  type SessionRow,
  type TaskRow,
  type TurnRow,
  type Verdict,
} from "./types";

type Listener = () => void;
const listeners = new Set<Listener>();

export function onChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

let batching = 0;
let pending = false;

export function changed(): void {
  if (batching > 0) {
    pending = true;
    return;
  }
  for (const listener of listeners) listener();
}

// Many writes, one notification: a poll that files ten messages redraws once.
export function batch<T>(fn: () => T): T {
  batching++;
  try {
    return db().transaction(fn)();
  } finally {
    batching--;
    if (batching === 0 && pending) {
      pending = false;
      changed();
    }
  }
}

function all<T>(sql: string, ...params: SQLQueryBindings[]): T[] {
  return db()
    .query(sql)
    .all(...params) as T[];
}

function one<T>(sql: string, ...params: SQLQueryBindings[]): T | null {
  return (db()
    .query(sql)
    .get(...params) ?? null) as T | null;
}

function run(sql: string, ...params: SQLQueryBindings[]): number {
  const result = db()
    .query(sql)
    .run(...params);
  changed();
  return Number(result.lastInsertRowid);
}

export function taskRef(id: number): string {
  return `AUG-${String(id).padStart(4, "0")}`;
}

export function parseTaskRef(ref: string): number | null {
  const m = ref.trim().match(/^(?:aug-)?0*(\d+)$/i);
  return m ? Number(m[1]) : null;
}

// ── tasks ────────────────────────────────────────────────────────────────

export interface NewTask {
  title: string;
  summary?: string;
  kind: Kind;
  priority?: Priority;
  watching?: boolean;
  repo?: string | null;
  threadKey?: string | null;
  channel: Channel;
  url?: string | null;
  triageReason?: string | null;
  createdAt?: string;
}

export function createTask(t: NewTask): TaskRow {
  const at = t.createdAt ?? now();
  const id = run(
    `INSERT INTO tasks (title, summary, kind, priority, watching, repo, thread_key, channel, url, triage_reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    t.title,
    t.summary ?? "",
    t.kind,
    t.priority ?? "regular",
    t.watching ? 1 : 0,
    t.repo ?? null,
    t.threadKey ?? null,
    t.channel,
    t.url ?? null,
    t.triageReason ?? null,
    at,
    at,
  );
  return getTask(id)!;
}

export function getTask(id: number): TaskRow | null {
  return one<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
}

export function listTasks(): TaskRow[] {
  return all<TaskRow>(
    "SELECT * FROM tasks WHERE status != 'dropped' ORDER BY created_at, id",
  );
}

export function openTaskForThread(threadKey: string): TaskRow | null {
  return one<TaskRow>(
    "SELECT * FROM tasks WHERE thread_key = ? AND status IN ('open','later') ORDER BY id DESC LIMIT 1",
    threadKey,
  );
}

export function lastTaskForThread(threadKey: string): TaskRow | null {
  return one<TaskRow>(
    "SELECT * FROM tasks WHERE thread_key = ? ORDER BY id DESC LIMIT 1",
    threadKey,
  );
}

type TaskPatch = Partial<Omit<TaskRow, "id" | "created_at">>;

export function updateTask(id: number, patch: TaskPatch): void {
  const keys = Object.keys(patch) as (keyof TaskPatch)[];
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => patch[k] ?? null) as SQLQueryBindings[];
  run(
    `UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`,
    ...values,
    now(),
    id,
  );
}

// ── messages ─────────────────────────────────────────────────────────────

export interface NewMessage {
  channel: Channel;
  externalId: string;
  threadKey: string;
  author: string;
  authorName: string;
  title: string;
  body: string;
  url?: string | null;
  receivedAt: string;
  fromMe?: boolean;
  meta?: Record<string, unknown>;
}

// Returns null when the message was already stored: dedupe is the first gate.
export function insertMessage(m: NewMessage): MessageRow | null {
  const exists = one<{ id: number }>(
    "SELECT id FROM messages WHERE external_id = ?",
    m.externalId,
  );
  if (exists) return null;
  const id = run(
    `INSERT INTO messages (channel, external_id, thread_key, author, author_name, title, body, url, received_at, from_me, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    m.channel,
    m.externalId,
    m.threadKey,
    m.author,
    m.authorName,
    m.title,
    m.body,
    m.url ?? null,
    m.receivedAt,
    m.fromMe ? 1 : 0,
    JSON.stringify(m.meta ?? {}),
  );
  return getMessage(id);
}

export function getMessage(id: number): MessageRow | null {
  return one<MessageRow>("SELECT * FROM messages WHERE id = ?", id);
}

export function messagesForTask(taskId: number): MessageRow[] {
  return all<MessageRow>(
    "SELECT * FROM messages WHERE task_id = ? ORDER BY received_at, id",
    taskId,
  );
}

export function messagesForThread(threadKey: string): MessageRow[] {
  return all<MessageRow>(
    "SELECT * FROM messages WHERE thread_key = ? ORDER BY received_at, id",
    threadKey,
  );
}

export function fyiMessages(sinceIso: string): MessageRow[] {
  return all<MessageRow>(
    "SELECT * FROM messages WHERE verdict = 'fyi' AND read_at IS NULL AND received_at >= ? ORDER BY received_at, id",
    sinceIso,
  );
}

export function fileMessage(
  id: number,
  verdict: Verdict | null,
  reason: string | null,
  taskId: number | null,
): void {
  run(
    "UPDATE messages SET verdict = ?, reason = ?, task_id = ? WHERE id = ?",
    verdict,
    reason,
    taskId,
    id,
  );
}

export function markMessageRead(id: number): void {
  run("UPDATE messages SET read_at = ? WHERE id = ?", now(), id);
}

// ── turns (a task's chat) ────────────────────────────────────────────────

export interface NewTurn {
  taskId: number;
  role: TurnRole;
  author?: string;
  body?: string;
  messageId?: number | null;
  status?: TurnRow["status"];
  sessionId?: string | null;
  startedAt?: string;
}

export function addTurn(t: NewTurn): TurnRow {
  const id = run(
    `INSERT INTO turns (task_id, role, message_id, author, body, status, session_id, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    t.taskId,
    t.role,
    t.messageId ?? null,
    t.author ?? "",
    t.body ?? "",
    t.status ?? "done",
    t.sessionId ?? null,
    t.startedAt ?? now(),
    t.status === "running" ? null : (t.startedAt ?? now()),
  );
  return getTurn(id)!;
}

export function getTurn(id: number): TurnRow | null {
  return one<TurnRow>("SELECT * FROM turns WHERE id = ?", id);
}

export function turnsForTask(taskId: number): TurnRow[] {
  return all<TurnRow>(
    "SELECT * FROM turns WHERE task_id = ? ORDER BY started_at, id",
    taskId,
  );
}

type TurnPatch = Partial<Omit<TurnRow, "id" | "task_id">>;

export function updateTurn(id: number, patch: TurnPatch): void {
  const keys = Object.keys(patch) as (keyof TurnPatch)[];
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => patch[k] ?? null) as SQLQueryBindings[];
  run(`UPDATE turns SET ${sets} WHERE id = ?`, ...values, id);
}

// A turn keeps its own draft; only the newest one can be sent, so a new draft
// retires the older pending ones.
export function setTurnAction(turnId: number, action: DraftAction): void {
  const turn = getTurn(turnId);
  if (!turn) return;
  batch(() => {
    run(
      "UPDATE turns SET action_state = ? WHERE task_id = ? AND action_state = ? AND id != ?",
      ActionState.retired,
      turn.task_id,
      ActionState.pending,
      turnId,
    );
    updateTurn(turnId, {
      action: JSON.stringify(action),
      action_state: ActionState.pending,
    });
  });
}

export function pendingAction(
  taskId: number,
): { turn: TurnRow; action: DraftAction } | null {
  const turn = one<TurnRow>(
    "SELECT * FROM turns WHERE task_id = ? AND action_state = 'pending' ORDER BY id DESC LIMIT 1",
    taskId,
  );
  if (!turn?.action) return null;
  return { turn, action: JSON.parse(turn.action) as DraftAction };
}

export function tasksWithPendingAction(): Set<number> {
  return new Set(
    all<{ task_id: number }>(
      "SELECT DISTINCT task_id FROM turns WHERE action_state = 'pending'",
    ).map((r) => r.task_id),
  );
}

export function retirePendingActions(taskId: number): void {
  run(
    "UPDATE turns SET action_state = ? WHERE task_id = ? AND action_state = ?",
    ActionState.retired,
    taskId,
    ActionState.pending,
  );
}

// ── sessions ─────────────────────────────────────────────────────────────

export interface NewSession {
  id: string;
  taskId: number;
  kind: SessionKind;
  cwd: string;
  startedBy: SessionRow["started_by"];
}

export function createSession(s: NewSession): SessionRow {
  const at = now();
  run(
    `INSERT INTO sessions (id, task_id, kind, cwd, state, started_by, started_at, last_event_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    s.id,
    s.taskId,
    s.kind,
    s.cwd,
    AgentState.working,
    s.startedBy,
    at,
    at,
  );
  return getSession(s.id)!;
}

export function getSession(id: string): SessionRow | null {
  return one<SessionRow>("SELECT * FROM sessions WHERE id = ?", id);
}

export function latestSession(taskId: number): SessionRow | null {
  return one<SessionRow>(
    "SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at DESC LIMIT 1",
    taskId,
  );
}

export function sessionsForTask(taskId: number): SessionRow[] {
  return all<SessionRow>(
    "SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at DESC",
    taskId,
  );
}

export function liveSessions(): SessionRow[] {
  return all<SessionRow>(
    "SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at",
  );
}

type SessionPatch = Partial<Omit<SessionRow, "id" | "task_id">>;

export function updateSession(id: string, patch: SessionPatch): void {
  const keys = Object.keys(patch) as (keyof SessionPatch)[];
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => patch[k] ?? null) as SQLQueryBindings[];
  run(
    `UPDATE sessions SET ${sets}, last_event_at = ? WHERE id = ?`,
    ...values,
    now(),
    id,
  );
}

// ── notes, hub, ideas ────────────────────────────────────────────────────

export function addNote(
  author: string,
  label: NoteLabel,
  body: string,
  taskId: number | null = null,
): NoteRow {
  const id = run(
    "INSERT INTO notes (author, label, body, task_id, created_at) VALUES (?, ?, ?, ?, ?)",
    author,
    label,
    body,
    taskId,
    now(),
  );
  return one<NoteRow>("SELECT * FROM notes WHERE id = ?", id)!;
}

export function listNotes(limit = 100): NoteRow[] {
  return all<NoteRow>(
    "SELECT * FROM notes ORDER BY created_at DESC, id DESC LIMIT ?",
    limit,
  );
}

export function markNotesRead(reader: string): void {
  const notes = listNotes(200);
  batch(() => {
    for (const note of notes) {
      const readBy = JSON.parse(note.read_by) as string[];
      if (note.author === reader || readBy.includes(reader)) continue;
      run(
        "UPDATE notes SET read_by = ? WHERE id = ?",
        JSON.stringify([...readBy, reader]),
        note.id,
      );
    }
  });
}

export function addHub(
  topic: string,
  title: string,
  body: string,
  author: string,
  parentId: number | null = null,
): HubRow {
  const id = run(
    "INSERT INTO hub (topic, title, body, author, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    topic.trim().toLowerCase(),
    title,
    body,
    author,
    parentId,
    now(),
  );
  return one<HubRow>("SELECT * FROM hub WHERE id = ?", id)!;
}

export function listHub(): HubRow[] {
  return all<HubRow>("SELECT * FROM hub ORDER BY topic, created_at, id");
}

export function addIdea(
  title: string,
  body: string,
  taskId: number | null,
): IdeaRow {
  const id = run(
    "INSERT INTO ideas (title, body, task_id, created_at) VALUES (?, ?, ?, ?)",
    title,
    body,
    taskId,
    now(),
  );
  return one<IdeaRow>("SELECT * FROM ideas WHERE id = ?", id)!;
}

export function openIdeas(): IdeaRow[] {
  return all<IdeaRow>(
    "SELECT * FROM ideas WHERE status = 'open' ORDER BY created_at, id",
  );
}

export function setIdeaStatus(id: number, status: IdeaRow["status"]): void {
  run("UPDATE ideas SET status = ? WHERE id = ?", status, id);
}

// ── corrections (what LEARNED.md is taught from) ─────────────────────────

export function addCorrection(c: {
  taskId?: number | null;
  messageId?: number | null;
  what: string;
  before?: string | null;
  after?: string | null;
  note?: string | null;
}): CorrectionRow {
  const id = run(
    "INSERT INTO corrections (task_id, message_id, what, before, after, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    c.taskId ?? null,
    c.messageId ?? null,
    c.what,
    c.before ?? null,
    c.after ?? null,
    c.note ?? null,
    now(),
  );
  return one<CorrectionRow>("SELECT * FROM corrections WHERE id = ?", id)!;
}

export function recentCorrections(limit = 40): CorrectionRow[] {
  return all<CorrectionRow>(
    "SELECT * FROM corrections ORDER BY id DESC LIMIT ?",
    limit,
  );
}

export function setCorrectionLearned(id: number, line: string): void {
  run("UPDATE corrections SET learned = ? WHERE id = ?", line, id);
}

// ── kv (ingest cursors, daily markers) ───────────────────────────────────

export function kvGet(key: string): string | null {
  return (
    one<{ value: string }>("SELECT value FROM kv WHERE key = ?", key)?.value ??
    null
  );
}

export function kvSet(key: string, value: string): void {
  db()
    .query(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

// ── task lifecycle moves (the owner's buttons) ───────────────────────────

// Mark done always does the same things: closed, unsent draft retired, any
// live agent stopped (the caller kills the process), off the rail.
export function markDone(taskId: number, by = "you"): void {
  batch(() => {
    retirePendingActions(taskId);
    const task = getTask(taskId);
    const agentLive =
      task &&
      (task.agent_state === AgentState.working ||
        task.agent_state === AgentState.blocked ||
        task.agent_state === AgentState.queued);
    updateTask(taskId, {
      status: TaskStatus.done,
      closed_at: now(),
      closed_by: by,
      unread_result: 0,
      watching: 0,
      remind_at: null,
      ...(agentLive ? { agent_state: AgentState.saved } : {}),
    });
    for (const session of liveSessions().filter((s) => s.task_id === taskId)) {
      updateSession(session.id, { ended_at: now(), state: AgentState.saved });
    }
  });
}

export function reopen(taskId: number): void {
  updateTask(taskId, {
    status: TaskStatus.open,
    closed_at: null,
    closed_by: null,
    remind_at: null,
  });
}

export function remindAt(taskId: number, at: string): void {
  updateTask(taskId, { status: TaskStatus.later, remind_at: at });
}

export function setWatching(taskId: number, on: boolean): void {
  updateTask(taskId, { watching: on ? 1 : 0 });
}

// Tasks whose reminder day came: back on the rail with a line saying why.
export function wakeReminders(at = now()): number {
  const due = all<TaskRow>(
    "SELECT * FROM tasks WHERE status = 'later' AND remind_at IS NOT NULL AND remind_at <= ?",
    at,
  );
  if (due.length === 0) return 0;
  batch(() => {
    for (const task of due) {
      updateTask(task.id, { status: TaskStatus.open, remind_at: null });
      addTurn({
        taskId: task.id,
        role: TurnRole.trigger,
        body: "You asked to be reminded about this today",
      });
    }
  });
  return due.length;
}
