// Typed reads and writes over the database. Every write calls `changed()` so
// in-process listeners (the TUI) re-read; writes from other processes surface
// through `dataVersion()`.

import type { SQLQueryBindings } from "bun:sqlite";
import { db, now } from "./db";
import {
  ActionState,
  AgentState,
  GoalStatus,
  MoveStatus,
  ProjectStatus,
  TaskStatus,
  TurnRole,
  TurnStatus,
  type Channel,
  type IdeaStatus,
  type CorrectionRow,
  type DraftAction,
  type GoalRow,
  type KnowledgeRow,
  type IdeaRow,
  type Kind,
  type MessageRow,
  type MoveRow,
  type NoteLabel,
  type NoteRow,
  type Priority,
  type ProjectLinkRow,
  type ProjectRow,
  type SessionKind,
  type SessionRow,
  type TaskLinkRow,
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

// UPDATE the columns in `patch` on one row; `touch` is a timestamp column
// set alongside. An empty patch writes nothing.
function patchRow<Row extends object>(
  table: string,
  id: number | string,
  patch: Partial<Row>,
  touch?: string,
): void {
  const keys = Object.keys(patch) as (keyof Row & string)[];
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => patch[k] ?? null) as SQLQueryBindings[];
  if (touch)
    run(`UPDATE ${table} SET ${sets}, ${touch} = ? WHERE id = ?`, ...values, now(), id);
  else run(`UPDATE ${table} SET ${sets} WHERE id = ?`, ...values, id);
}

export function taskRef(id: number): string {
  return `AUG-${String(id).padStart(4, "0")}`;
}

export function parseTaskRef(ref: string): number | null {
  const m = ref.trim().match(/^@?(?:aug-)?0*(\d+)$/i);
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
  projectId?: number | null;
  branch?: string | null;
  fromTaskId?: number | null;
  goalId?: number | null;
}

export function createTask(t: NewTask): TaskRow {
  const at = t.createdAt ?? now();
  const id = run(
    `INSERT INTO tasks (title, summary, kind, priority, watching, repo, thread_key, channel, url, triage_reason, created_at, updated_at, project_id, branch, from_task_id, goal_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    t.projectId ?? null,
    t.branch ?? null,
    t.fromTaskId ?? null,
    t.goalId ?? null,
  );
  return getTask(id)!;
}

export function getTask(id: number): TaskRow | null {
  return one<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
}

// Work only: Home is not a task, and nothing that lists work sees it.
export function listTasks(): TaskRow[] {
  return all<TaskRow>(
    "SELECT * FROM tasks WHERE status != 'dropped' AND kind != 'home' ORDER BY created_at, id",
  );
}

export function homeTask(): TaskRow {
  const found = one<TaskRow>(
    "SELECT * FROM tasks WHERE kind = 'home' ORDER BY id LIMIT 1",
  );
  return found ?? createTask({ title: "Home", kind: "home", channel: "owner" });
}

// A task owns its own thread plus any linked to it (task_threads).
const ON_THREAD =
  "(thread_key = ? OR id IN (SELECT task_id FROM task_threads WHERE thread_key = ?))";

export function openTaskForThread(threadKey: string): TaskRow | null {
  return one<TaskRow>(
    `SELECT * FROM tasks WHERE ${ON_THREAD} AND status IN ('open','later') ORDER BY id DESC LIMIT 1`,
    threadKey,
    threadKey,
  );
}

export function lastTaskForThread(threadKey: string): TaskRow | null {
  return one<TaskRow>(
    `SELECT * FROM tasks WHERE ${ON_THREAD} ORDER BY id DESC LIMIT 1`,
    threadKey,
    threadKey,
  );
}

export function linkThread(taskId: number, threadKey: string): void {
  run(
    "INSERT OR IGNORE INTO task_threads (task_id, thread_key, linked_at) VALUES (?, ?, ?)",
    taskId,
    threadKey,
    now(),
  );
}

export function threadsForTask(taskId: number): string[] {
  const task = getTask(taskId);
  const linked = all<{ thread_key: string }>(
    "SELECT thread_key FROM task_threads WHERE task_id = ? ORDER BY linked_at",
    taskId,
  ).map((r) => r.thread_key);
  return task?.thread_key ? [task.thread_key, ...linked] : linked;
}

// Adding a URL the task already has keeps its place and takes the new title.
export function addTaskLink(
  taskId: number,
  url: string,
  title: string | null,
  addedBy: string,
): TaskLinkRow {
  run(
    `INSERT INTO task_links (task_id, url, title, added_by, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (task_id, url) DO UPDATE SET title = COALESCE(excluded.title, title)`,
    taskId,
    url,
    title,
    addedBy,
    now(),
  );
  return one<TaskLinkRow>(
    "SELECT * FROM task_links WHERE task_id = ? AND url = ?",
    taskId,
    url,
  )!;
}

export function linksForTask(taskId: number): TaskLinkRow[] {
  return all<TaskLinkRow>(
    "SELECT * FROM task_links WHERE task_id = ? ORDER BY id",
    taskId,
  );
}

export function removeTaskLink(taskId: number, url: string): boolean {
  const had = one<{ id: number }>(
    "SELECT id FROM task_links WHERE task_id = ? AND url = ?",
    taskId,
    url,
  );
  if (!had) return false;
  run("DELETE FROM task_links WHERE id = ?", had.id);
  return true;
}

export function hasBranchTasks(repo: string): boolean {
  return (
    one<{ n: number }>(
      "SELECT 1 AS n FROM tasks WHERE repo = ? AND branch IS NOT NULL LIMIT 1",
      repo,
    ) !== null
  );
}

type TaskPatch = Partial<Omit<TaskRow, "id" | "created_at">>;

export function updateTask(id: number, patch: TaskPatch): void {
  patchRow<TaskRow>("tasks", id, patch, "updated_at");
}

export function tasksForProject(projectId: number): TaskRow[] {
  return all<TaskRow>(
    "SELECT * FROM tasks WHERE project_id = ? AND status != 'dropped' ORDER BY created_at, id",
    projectId,
  );
}

// A PR's head branch finds the task whose worktree pushed it.
export function taskForBranch(repo: string, branch: string): TaskRow | null {
  return one<TaskRow>(
    "SELECT * FROM tasks WHERE repo = ? AND branch = ? ORDER BY id DESC LIMIT 1",
    repo,
    branch,
  );
}

// ── projects ─────────────────────────────────────────────────────────────

export interface NewProject {
  name: string;
  tmuxSession: string;
  repos?: string[];
  solo?: boolean;
}

export function createProject(p: NewProject): ProjectRow {
  const at = now();
  const id = run(
    `INSERT INTO projects (name, tmux_session, repos, solo, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    p.name,
    p.tmuxSession,
    JSON.stringify(p.repos ?? []),
    p.solo ? 1 : 0,
    at,
    at,
  );
  return getProject(id)!;
}

export function getProject(id: number): ProjectRow | null {
  return one<ProjectRow>("SELECT * FROM projects WHERE id = ?", id);
}

export function listProjects(): ProjectRow[] {
  return all<ProjectRow>(
    "SELECT * FROM projects WHERE status = 'active' ORDER BY created_at, id",
  );
}

export function projectRepos(project: ProjectRow): string[] {
  return JSON.parse(project.repos) as string[];
}

type ProjectPatch = Partial<Omit<ProjectRow, "id" | "created_at">>;

export function updateProject(id: number, patch: ProjectPatch): void {
  patchRow<ProjectRow>("projects", id, patch, "updated_at");
}

export function addProjectRepo(id: number, repo: string): void {
  const project = getProject(id);
  if (!project) return;
  const repos = projectRepos(project);
  if (repos.includes(repo)) return;
  updateProject(id, { repos: JSON.stringify([...repos, repo]) });
}

// Only for a project that never got its tmux tag: nothing points at it yet.
export function deleteProject(id: number): void {
  run("DELETE FROM projects WHERE id = ?", id);
}

export function archiveProject(id: number): void {
  updateProject(id, { status: ProjectStatus.archived, archived_at: now() });
}

// Adding a URL the project already has keeps its place and takes the new title.
export function addProjectLink(
  projectId: number,
  url: string,
  title: string | null,
  addedBy: string,
): ProjectLinkRow {
  run(
    `INSERT INTO project_links (project_id, url, title, added_by, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (project_id, url) DO UPDATE SET title = COALESCE(excluded.title, title)`,
    projectId,
    url,
    title,
    addedBy,
    now(),
  );
  return one<ProjectLinkRow>(
    "SELECT * FROM project_links WHERE project_id = ? AND url = ?",
    projectId,
    url,
  )!;
}

export function linksForProject(projectId: number): ProjectLinkRow[] {
  return all<ProjectLinkRow>(
    "SELECT * FROM project_links WHERE project_id = ? ORDER BY id",
    projectId,
  );
}

export function removeProjectLink(projectId: number, url: string): boolean {
  const had = one<{ id: number }>(
    "SELECT id FROM project_links WHERE project_id = ? AND url = ?",
    projectId,
    url,
  );
  if (!had) return false;
  run("DELETE FROM project_links WHERE id = ?", had.id);
  return true;
}

// ── project goals ────────────────────────────────────────────────────────

export function goalRef(id: number): string {
  return `G${id}`;
}

export function parseGoalRef(ref: string): number | null {
  const m = ref.trim().match(/^g?0*(\d+)$/i);
  return m ? Number(m[1]) : null;
}

export function addGoal(projectId: number, title: string): GoalRow {
  const at = now();
  const id = run(
    "INSERT INTO project_goals (project_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    projectId,
    title,
    at,
    at,
  );
  return getGoal(id)!;
}

export function getGoal(id: number): GoalRow | null {
  return one<GoalRow>("SELECT * FROM project_goals WHERE id = ?", id);
}

export function goalsForProject(projectId: number): GoalRow[] {
  return all<GoalRow>(
    "SELECT * FROM project_goals WHERE project_id = ? ORDER BY id",
    projectId,
  );
}

export function updateGoal(
  id: number,
  patch: Partial<Pick<GoalRow, "title" | "status">>,
): void {
  const next: Partial<GoalRow> = {};
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.status !== undefined) {
    next.status = patch.status;
    next.met_at = patch.status === GoalStatus.met ? now() : null;
  }
  patchRow<GoalRow>("project_goals", id, next, "updated_at");
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

// Every rail task's messages in one query, for search.
export function messagesForTasks(taskIds: number[]): Map<number, MessageRow[]> {
  const out = new Map<number, MessageRow[]>();
  const rows = all<MessageRow>(
    "SELECT * FROM messages WHERE task_id IN (SELECT value FROM json_each(?)) ORDER BY received_at, id",
    JSON.stringify(taskIds),
  );
  for (const m of rows) {
    if (m.task_id === null) continue;
    const list = out.get(m.task_id);
    if (list) list.push(m);
    else out.set(m.task_id, [m]);
  }
  return out;
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
  pending?: boolean;
}

export function addTurn(t: NewTurn): TurnRow {
  const id = run(
    `INSERT INTO turns (task_id, role, message_id, author, body, status, session_id, started_at, finished_at, pending)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    t.taskId,
    t.role,
    t.messageId ?? null,
    t.author ?? "",
    t.body ?? "",
    t.status ?? "done",
    t.sessionId ?? null,
    t.startedAt ?? now(),
    t.status === TurnStatus.running ? null : (t.startedAt ?? now()),
    t.pending ? 1 : 0,
  );
  return getTurn(id)!;
}

export function pendingTurns(taskId: number): TurnRow[] {
  return all<TurnRow>(
    "SELECT * FROM turns WHERE task_id = ? AND pending = 1 ORDER BY id",
    taskId,
  );
}

export function setPending(turnIds: number[], pending: boolean): void {
  if (turnIds.length === 0) return;
  run(
    `UPDATE turns SET pending = ? WHERE id IN (${turnIds.map(() => "?").join(", ")})`,
    pending ? 1 : 0,
    ...turnIds,
  );
}

// What search reads of the rail tasks' chats: what you typed and what the
// agents answered. Incoming turns repeat their messages; aug's own notes are
// noise.
export type SearchTurn = Pick<
  TurnRow,
  "task_id" | "role" | "body" | "about" | "did" | "next"
>;

export function turnsForTasks(taskIds: number[]): Map<number, SearchTurn[]> {
  const out = new Map<number, SearchTurn[]>();
  const rows = all<SearchTurn>(
    "SELECT task_id, role, body, about, did, next FROM turns WHERE task_id IN (SELECT value FROM json_each(?)) AND role IN (?, ?) ORDER BY started_at, id",
    JSON.stringify(taskIds),
    TurnRole.you,
    TurnRole.agent,
  );
  for (const t of rows) {
    const list = out.get(t.task_id);
    if (list) list.push(t);
    else out.set(t.task_id, [t]);
  }
  return out;
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
  patchRow<TurnRow>("turns", id, patch);
}

// JSON array of one-line tool steps, live while the turn runs.
export function turnSteps(turn: TurnRow): string[] {
  return JSON.parse(turn.steps || "[]") as string[];
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
  tmuxWindow?: string | null;
}

export function createSession(s: NewSession): SessionRow {
  const at = now();
  run(
    `INSERT INTO sessions (id, task_id, kind, cwd, state, started_by, started_at, last_event_at, tmux_window)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    s.id,
    s.taskId,
    s.kind,
    s.cwd,
    AgentState.working,
    s.startedBy,
    at,
    at,
    s.tmuxWindow ?? null,
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

export function sessionForWindow(windowId: string): SessionRow | null {
  return one<SessionRow>(
    "SELECT * FROM sessions WHERE tmux_window = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1",
    windowId,
  );
}

type SessionPatch = Partial<Omit<SessionRow, "id" | "task_id">>;

export function updateSession(id: string, patch: SessionPatch): void {
  patchRow<SessionRow>("sessions", id, patch, "last_event_at");
}

// ── notes, knowledge, ideas ──────────────────────────────────────────────

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

// Who has read a note, as the JSON column holds it.
export function noteReadBy(note: NoteRow): string[] {
  return JSON.parse(note.read_by) as string[];
}

export function markNotesRead(reader: string): void {
  const notes = listNotes(200);
  batch(() => {
    for (const note of notes) {
      const readBy = noteReadBy(note);
      if (note.author === reader || readBy.includes(reader)) continue;
      run(
        "UPDATE notes SET read_by = ? WHERE id = ?",
        JSON.stringify([...readBy, reader]),
        note.id,
      );
    }
  });
}

export function addKnowledge(
  topic: string,
  title: string,
  body: string,
  author: string,
  parentId: number | null = null,
): KnowledgeRow {
  const id = run(
    "INSERT INTO hub (topic, title, body, author, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    topic.trim().toLowerCase(),
    title,
    body,
    author,
    parentId,
    now(),
  );
  return one<KnowledgeRow>("SELECT * FROM hub WHERE id = ?", id)!;
}

export function listKnowledge(): KnowledgeRow[] {
  return all<KnowledgeRow>("SELECT * FROM hub ORDER BY topic, created_at, id");
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

export function setIdeaStatus(id: number, status: IdeaStatus): void {
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

// Cursors and markers are bookkeeping, not a change the TUI redraws for, so
// kvSet skips `changed()` on purpose.

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

// ── task status (the row-level half; lifecycle.ts owns the agent's side) ─

// A task made --from another reports back to it when it ends, so whoever
// made it (a project lead, an agent) can see the result and decide what next.
export function tellFromTask(
  task: TaskRow,
  what: string,
  result: string | null,
): void {
  if (!task.from_task_id || !getTask(task.from_task_id)) return;
  addTurn({
    taskId: task.from_task_id,
    role: TurnRole.trigger,
    body: `${taskRef(task.id)} ${what}: ${task.title}${result ? `\nResult: ${result}` : ""}`,
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

// ── moves ────────────────────────────────────────────────────────────────

export function enqueueMove(
  verb: string,
  args: Record<string, string>,
  askedBy: string,
): MoveRow {
  const id = run(
    "INSERT INTO moves (verb, args, asked_by, created_at) VALUES (?, ?, ?, ?)",
    verb,
    JSON.stringify(args),
    askedBy,
    now(),
  );
  return getMove(id)!;
}

export function getMove(id: number): MoveRow | null {
  return one<MoveRow>("SELECT * FROM moves WHERE id = ?", id);
}

export function pendingMoves(): MoveRow[] {
  return all<MoveRow>(
    "SELECT * FROM moves WHERE status = 'pending' ORDER BY id",
  );
}

// Only one claimer wins, so a move never runs twice.
export function claimMove(id: number): boolean {
  const result = db()
    .query(
      "UPDATE moves SET status = 'running' WHERE id = ? AND status = 'pending'",
    )
    .run(id);
  changed();
  return result.changes === 1;
}

export function finishMove(id: number, ok: boolean, result: string): void {
  run(
    "UPDATE moves SET status = ?, result = ?, finished_at = ? WHERE id = ?",
    ok ? MoveStatus.done : MoveStatus.failed,
    result,
    now(),
    id,
  );
}

// A move nobody picked up is failed, not left to run whenever aug next starts.
export function abandonMove(id: number, why: string): boolean {
  const result = db()
    .query(
      "UPDATE moves SET status = 'failed', result = ?, finished_at = ? WHERE id = ? AND status = 'pending'",
    )
    .run(why, now(), id);
  changed();
  return result.changes === 1;
}
