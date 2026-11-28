// Typed reads and writes over the database. Every write calls `changed()` so
// in-process listeners (the TUI) re-read; writes from other processes surface
// through `dataVersion()`.

import type { SQLQueryBindings } from "bun:sqlite";
import { db, now } from "./db";
import { noteReadBy, projectRepos, taskRef } from "./rows";
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
  type SpendByDay,
  type SpendByRole,
  type SpendByTask,
  type SpendRole,
  type SpendTotal,
  type TaskEventRow,
  type CorrectionRow,
  type ProjectMove,
  PROJECT_MOVE,
  type DigestRow,
  type DocProposalRow,
  type StoryRow,
  type ProposalSource,
  type ProposalStatus,
  type DraftAction,
  type GoalRow,
  type KnowledgeRow,
  type IdeaRow,
  type Kind,
  type MessageRow,
  type MessageState,
  type MoveRow,
  type NoteLabel,
  type NoteRow,
  type Priority,
  type ProjectLinkRow,
  type ProjectRow,
  type PrStatusRow,
  type SessionKind,
  type SessionRow,
  type TaskLinkRow,
  TimerKind,
  TimerState,
  type TimerRow,
  type StepDecision,
  type TaskRow,
  type TriageRunRow,
  type TriageStepRow,
  type TriageVerdict,
  type TurnRow,
  type Verdict,
} from "./types";

export {
  goalRef,
  noteReadBy,
  parseGoalRef,
  parseTaskRef,
  projectRepos,
  taskRef,
  turnSteps,
} from "./rows";

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
  for (const listener of listeners) {
    listener();
  }
}

// Many writes, one notification: a poll that files ten messages redraws once.
// IMMEDIATE takes the write lock up front, waiting out busy_timeout. A
// deferred one that reads first cannot wait: SQLite answers "database is
// locked" at once when its read has to become a write while another process
// (a hook, riker-tools) writes. Nested batches are savepoints either way.
export function batch<T>(fn: () => T): T {
  batching++;
  try {
    return db().transaction(fn).immediate();
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
  if (keys.length === 0) {
    return;
  }
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const values = keys.map((k) => patch[k] ?? null) as SQLQueryBindings[];
  if (touch) {
    run(
      `UPDATE ${table} SET ${sets}, ${touch} = ? WHERE id = ?`,
      ...values,
      now(),
      id,
    );
  } else {
    run(`UPDATE ${table} SET ${sets} WHERE id = ?`, ...values, id);
  }
}

// ── tasks ────────────────────────────────────────────────────────────────

export interface NewTask {
  title: string;
  summary?: string;
  kind: Kind;
  priority?: Priority;
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
    `INSERT INTO tasks (title, summary, kind, priority, repo, thread_key, channel, url, triage_reason, created_at, updated_at, project_id, branch, from_task_id, goal_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    t.title,
    t.summary ?? "",
    t.kind,
    t.priority ?? "regular",
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

// Home and the projects' managers are conversations, not work: nothing that
// lists work sees them.
const WORK = "kind NOT IN ('home', 'manager')";

// Work only.
export function listTasks(): TaskRow[] {
  return all<TaskRow>(
    `SELECT * FROM tasks WHERE status != 'dropped' AND ${WORK} ORDER BY created_at, id`,
  );
}

// Each open task's agent state, for the engine's turn-end watch: one narrow
// read whenever tasks changed, not every row.
export function agentStates(): { id: number; agent_state: AgentState }[] {
  return all<{ id: number; agent_state: AgentState }>(
    `SELECT id, agent_state FROM tasks WHERE status IN ('open', 'later') AND ${WORK}`,
  );
}

// Done and dropped work, last closed first: the go-to list shows them when
// asked, since the rail no longer lists them.
export function closedTasks(limit = 500): TaskRow[] {
  return all<TaskRow>(
    `SELECT * FROM tasks WHERE status IN ('done', 'dropped') AND ${WORK} ORDER BY closed_at DESC, id DESC LIMIT ?`,
    limit,
  );
}

// Tasks whose agent is at work right now, Home's included: what counts
// against Agents at once.
export function workingTaskIds(): number[] {
  return all<{ id: number }>(
    "SELECT id FROM tasks WHERE agent_state = 'working' AND status NOT IN ('done', 'dropped')",
  ).map((r) => r.id);
}

export function homeTask(): TaskRow {
  const found = one<TaskRow>(
    "SELECT * FROM tasks WHERE kind = 'home' ORDER BY id LIMIT 1",
  );
  return found ?? createTask({ title: "Home", kind: "home", channel: "owner" });
}

// A project's manager, if the owner has talked to the project yet.
export function managerOf(projectId: number): TaskRow | null {
  return one<TaskRow>(
    "SELECT * FROM tasks WHERE kind = 'manager' AND project_id = ? ORDER BY id LIMIT 1",
    projectId,
  );
}

// Made the first time the owner talks to the project.
export function ensureManager(projectId: number): TaskRow {
  const found = managerOf(projectId);
  if (found) {
    return found;
  }
  const project = getProject(projectId);
  return createTask({
    title: `${project?.name ?? "Project"} manager`,
    kind: "manager",
    channel: "owner",
    projectId,
  });
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
  if (!had) {
    return false;
  }
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

export function tasksWithRepo(repo: string): TaskRow[] {
  return all<TaskRow>("SELECT * FROM tasks WHERE repo = ? ORDER BY id", repo);
}

export function tasksForProject(projectId: number): TaskRow[] {
  return all<TaskRow>(
    `SELECT * FROM tasks WHERE project_id = ? AND status != 'dropped' AND ${WORK} ORDER BY created_at, id`,
    projectId,
  );
}

// ── PR status (core/pr.ts reads GitHub; this keeps the last answer) ─────

export function prStatus(taskId: number): PrStatusRow | null {
  return one<PrStatusRow>("SELECT * FROM pr_status WHERE task_id = ?", taskId);
}

// A read that changed nothing only moves fetched_at, without a redraw. The
// base shows nowhere, so its change alone redraws nothing either.
export function setPrStatus(row: PrStatusRow): void {
  const had = prStatus(row.task_id);
  const same =
    had !== null &&
    (
      [
        "repo",
        "number",
        "url",
        "state",
        "checks",
        "review",
        "mergeable",
        "queue",
        "queue_position",
        "queue_reason",
        "error",
      ] as const
    ).every((k) => had[k] === row[k]);
  const sql = `INSERT INTO pr_status (task_id, repo, number, url, state, checks, review, mergeable,
       queue, queue_position, queue_reason, fetched_at, error, base)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (task_id) DO UPDATE SET repo = excluded.repo, number = excluded.number,
       url = excluded.url, state = excluded.state, checks = excluded.checks,
       review = excluded.review, mergeable = excluded.mergeable, queue = excluded.queue,
       queue_position = excluded.queue_position, queue_reason = excluded.queue_reason,
       fetched_at = excluded.fetched_at, error = excluded.error, base = excluded.base`;
  const params = [
    row.task_id,
    row.repo,
    row.number,
    row.url,
    row.state,
    row.checks,
    row.review,
    row.mergeable,
    row.queue,
    row.queue_position,
    row.queue_reason,
    row.fetched_at,
    row.error,
    row.base ?? null,
  ];
  if (same) {
    db()
      .query(sql)
      .run(...params);
  } else {
    run(sql, ...params);
  }
}

// The last read failed: what the row says is kept, and marked stale. A row
// already stale for the same reason is left alone, so a failing PR does not
// wake the TUI every poll.
export function markPrStale(taskId: number, error: string): void {
  run(
    "UPDATE pr_status SET error = ? WHERE task_id = ? AND error IS NOT ?",
    error,
    taskId,
    error,
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

// Every place a link or doc is kept, whole, for the Documents view
// (core/documents.ts): read in one go so the view is one read. Archived
// projects and closed tasks count; Home does not.
export interface DocumentSources {
  taskLinks: TaskLinkRow[];
  projectLinks: ProjectLinkRow[];
  projects: { id: number; name: string; status: string }[];
  tasks: {
    id: number;
    title: string;
    url: string | null;
    project_id: number | null;
    created_at: string;
  }[];
  threads: { task_id: number; thread_key: string; linked_at: string }[];
  made: { task_id: number; files: string; started_at: string }[];
  notes: {
    task_id: number | null;
    author: string;
    body: string;
    created_at: string;
  }[];
  messages: {
    task_id: number;
    author_name: string;
    body: string;
    received_at: string;
  }[];
}

export function documentSources(): DocumentSources {
  return {
    taskLinks: all<TaskLinkRow>("SELECT * FROM task_links ORDER BY id"),
    projectLinks: all<ProjectLinkRow>(
      "SELECT * FROM project_links ORDER BY id",
    ),
    projects: all("SELECT id, name, status FROM projects ORDER BY id"),
    tasks: all(
      `SELECT id, title, url, project_id, created_at FROM tasks WHERE ${WORK} ORDER BY id`,
    ),
    threads: all(
      "SELECT task_id, thread_key, linked_at FROM task_threads ORDER BY linked_at",
    ),
    made: all(
      "SELECT task_id, files, started_at FROM turns WHERE files != '[]' ORDER BY id",
    ),
    notes: all(
      "SELECT task_id, author, body, created_at FROM notes WHERE body LIKE '%http%' OR body LIKE '%file:%' ORDER BY id",
    ),
    messages: all(
      "SELECT task_id, author_name, body, received_at FROM messages WHERE task_id IS NOT NULL AND body LIKE '%http%' ORDER BY id",
    ),
  };
}

export function listProjects(): ProjectRow[] {
  return all<ProjectRow>(
    "SELECT * FROM projects WHERE status = 'active' ORDER BY created_at, id",
  );
}

type ProjectPatch = Partial<Omit<ProjectRow, "id" | "created_at">>;

export function updateProject(id: number, patch: ProjectPatch): void {
  patchRow<ProjectRow>("projects", id, patch, "updated_at");
}

export function addProjectRepo(id: number, repo: string): void {
  const project = getProject(id);
  if (!project) {
    return;
  }
  const repos = projectRepos(project);
  if (repos.includes(repo)) {
    return;
  }
  updateProject(id, { repos: JSON.stringify([...repos, repo]) });
}

export function removeProjectRepo(id: number, repo: string): void {
  const project = getProject(id);
  if (!project) {
    return;
  }
  const repos = projectRepos(project);
  if (!repos.includes(repo)) {
    return;
  }
  updateProject(id, { repos: JSON.stringify(repos.filter((r) => r !== repo)) });
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
  if (!had) {
    return false;
  }
  run("DELETE FROM project_links WHERE id = ?", had.id);
  return true;
}

// ── project goals ────────────────────────────────────────────────────────

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
  if (patch.title !== undefined) {
    next.title = patch.title;
  }
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
  if (exists) {
    return null;
  }
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
    if (m.task_id === null) {
      continue;
    }
    const list = out.get(m.task_id);
    if (list) {
      list.push(m);
    } else {
      out.set(m.task_id, [m]);
    }
  }
  return out;
}

export function firstMessageOnThread(threadKey: string): MessageRow | null {
  return one<MessageRow>(
    "SELECT * FROM messages WHERE thread_key = ? ORDER BY received_at, id LIMIT 1",
    threadKey,
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

// The Inbox's messages, newest first.
export function recentMessages(limit: number): MessageRow[] {
  return all<MessageRow>(
    "SELECT * FROM messages ORDER BY received_at DESC, id DESC LIMIT ?",
    limit,
  );
}

// Messages on the owner: one triage held for them, or one it gave up on
// (failed, no retry left). One the worker has yet to reach is not theirs.
// Keep in step with inbox.ts messageResult and needsAttention.
export function unplacedMessages(): number {
  return (
    one<{ n: number }>(
      `SELECT COUNT(*) AS n FROM messages
       WHERE from_me = 0 AND task_id IS NULL AND read_at IS NULL
         AND (
           (state = 'failed' AND next_at IS NULL)
           OR (state = 'done' AND COALESCE(verdict, '') != 'fyi'
               AND COALESCE(reason, '') NOT LIKE 'a greeting%')
         )`,
    )?.n ?? 0
  );
}

export function fileMessage(
  id: number,
  verdict: Verdict | null,
  reason: string | null,
  taskId: number | null,
): void {
  // Filed is placed: the worker never takes it again (the chain settles
  // its own runs after this, failed included).
  run(
    "UPDATE messages SET verdict = ?, reason = ?, task_id = ?, state = 'done', next_at = NULL WHERE id = ?",
    verdict,
    reason,
    taskId,
    id,
  );
}

export function markMessageRead(id: number): void {
  run("UPDATE messages SET read_at = ? WHERE id = ?", now(), id);
}

// ── the inbox (messages as triage's work queue) ──────────────────────────

// What the triage worker may take now, oldest first: new ones, and failed
// ones whose retry is due. One the owner has read is theirs.
export function dueMessages(atIso: string): MessageRow[] {
  return all<MessageRow>(
    `SELECT * FROM messages
     WHERE read_at IS NULL
       AND (state = 'new' OR (state = 'failed' AND next_at IS NOT NULL))
       AND COALESCE(next_at, '') <= ?
     ORDER BY received_at, id`,
    atIso,
  );
}

// The moves claim: only one taker wins a row, and each take is a try.
export function claimMessage(id: number): boolean {
  const won = db()
    .query(
      "UPDATE messages SET state = 'triaging', attempts = attempts + 1 WHERE id = ? AND state != 'triaging' RETURNING id",
    )
    .get(id);
  changed();
  return won != null;
}

// The chain's last word on a message; nextAt is when a failed one is tried
// again, null for never.
export function settleMessage(
  id: number,
  state: MessageState,
  nextAt: string | null = null,
): void {
  run(
    "UPDATE messages SET state = ?, next_at = ? WHERE id = ?",
    state,
    nextAt,
    id,
  );
}

// At start: a message claimed by a Riker that died is new again. One Riker
// runs per home, so every claim left is stale.
export function resetTriaging(): number {
  const rows = db()
    .query(
      "UPDATE messages SET state = 'new' WHERE state = 'triaging' RETURNING id",
    )
    .all();
  if (rows.length) {
    changed();
  }
  return rows.length;
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
  if (turnIds.length === 0) {
    return;
  }
  run(
    `UPDATE turns SET pending = ? WHERE id IN (${turnIds.map(() => "?").join(", ")})`,
    pending ? 1 : 0,
    ...turnIds,
  );
}

// What search reads of the rail tasks' chats: what you typed and what the
// agents answered. Incoming turns repeat their messages; Riker's own notes are
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
    if (list) {
      list.push(t);
    } else {
      out.set(t.task_id, [t]);
    }
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
// A turn keeps its own draft; only the newest one can be sent, so a new draft
// retires the older pending ones.
export function setTurnAction(turnId: number, action: DraftAction): void {
  const turn = getTurn(turnId);
  if (!turn) {
    return;
  }
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
  if (!turn?.action) {
    return null;
  }
  return { turn, action: JSON.parse(turn.action) as DraftAction };
}

// Tasks a GitHub review request filed: the rail keeps them under Code Reviews.
// Tasks a review ask filed: GitHub's review request, or the PR link triage
// marks a review with (`markedBy`, core/pr.ts), so a tag or a Slack ask
// counts too.
export function tasksFromReviewRequests(markedBy?: string): Set<number> {
  return new Set(
    all<{ task_id: number }>(
      `SELECT DISTINCT task_id FROM messages WHERE task_id IS NOT NULL AND channel = 'github' AND json_extract(meta, '$.reason') = 'review_requested'
       UNION SELECT task_id FROM task_links WHERE added_by = ?`,
      markedBy ?? "",
    ).map((r) => r.task_id),
  );
}

export function tasksWithPendingAction(): Set<number> {
  return new Set(
    all<{ task_id: number }>(
      "SELECT DISTINCT task_id FROM turns WHERE action_state = 'pending'",
    ).map((r) => r.task_id),
  );
}

// Each task's latest action turn, running or not: the rail says where a
// running one is, and for a while that it finished or failed.
export function latestActionTurns(): Map<number, TurnRow> {
  return new Map(
    all<TurnRow>(
      `SELECT t.* FROM turns t
       JOIN (SELECT MAX(id) AS id FROM turns WHERE role = ? GROUP BY task_id) m ON m.id = t.id`,
      TurnRole.action,
    ).map((t) => [t.task_id, t]),
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
  // rowid breaks a tie: two sessions can start in the same millisecond.
  return one<SessionRow>(
    "SELECT * FROM sessions WHERE task_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1",
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

// The board keeps only the latest few notes per task: the rest were what
// later notes corrected or moved past.
export const NOTES_PER_TASK = 3;

const NOTE_COLUMNS = "id, author, label, body, task_id, read_by, created_at";

// The board, newest first: a task's notes leave it when the task is done or
// dropped (they stay on the task: notesForTask), and an open task shows its
// latest NOTES_PER_TASK. A note on no task stays until it falls off the
// limit.
export function listNotes(limit = 100): NoteRow[] {
  return all<NoteRow>(
    `SELECT ${NOTE_COLUMNS} FROM (
       SELECT n.*, ROW_NUMBER() OVER (
         PARTITION BY COALESCE(n.task_id, -n.id)
         ORDER BY n.created_at DESC, n.id DESC
       ) AS nth
       FROM notes n LEFT JOIN tasks t ON t.id = n.task_id
       WHERE t.id IS NULL OR t.status NOT IN ('done', 'dropped')
     )
     WHERE nth <= ?
     ORDER BY created_at DESC, id DESC LIMIT ?`,
    NOTES_PER_TASK,
    limit,
  );
}

// Every note an agent left on the task, oldest first.
export function notesForTask(taskId: number): NoteRow[] {
  return all<NoteRow>(
    "SELECT * FROM notes WHERE task_id = ? ORDER BY created_at, id",
    taskId,
  );
}

// Who has read a note, as the JSON column holds it.
export function markNotesRead(reader: string): void {
  const notes = listNotes(200);
  batch(() => {
    for (const note of notes) {
      const readBy = noteReadBy(note);
      if (note.author === reader || readBy.includes(reader)) {
        continue;
      }
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

// What agents read: entries the owner has not retired or merged away.
export function listKnowledge(): KnowledgeRow[] {
  return all<KnowledgeRow>(
    "SELECT * FROM hub WHERE retired_at IS NULL ORDER BY topic, created_at, id",
  );
}

export function getKnowledge(id: number): KnowledgeRow | null {
  return one<KnowledgeRow>("SELECT * FROM hub WHERE id = ?", id);
}

// Out of what agents read, kept with why (and the entry it was merged into).
export function retireKnowledge(
  id: number,
  why: string,
  supersededBy: number | null = null,
): void {
  run(
    "UPDATE hub SET retired_at = ?, retired_why = ?, superseded_by = ? WHERE id = ? AND retired_at IS NULL",
    now(),
    why,
    supersededBy,
    id,
  );
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

export function allIdeas(): IdeaRow[] {
  return all<IdeaRow>("SELECT * FROM ideas ORDER BY created_at, id");
}

export function openIdeas(): IdeaRow[] {
  return all<IdeaRow>(
    "SELECT * FROM ideas WHERE status = 'open' ORDER BY created_at, id",
  );
}

// Ideas made since `since` (an ISO time), whatever the owner did with them:
// the Advisor's record of what it already said.
export function ideasSince(since: string): IdeaRow[] {
  return all<IdeaRow>(
    "SELECT * FROM ideas WHERE created_at >= ? ORDER BY created_at, id",
    since,
  );
}

export function ideaTasked(id: number, taskId: number): void {
  run(
    "UPDATE ideas SET status = 'tasked', made_task_id = ? WHERE id = ?",
    taskId,
    id,
  );
}

export function setIdeaStatus(id: number, status: IdeaStatus): void {
  run("UPDATE ideas SET status = ? WHERE id = ?", status, id);
}

// ── doc proposals (a SYSTEM task's new text for a brain doc) ─────────────

export function addProposal(p: {
  taskId: number;
  doc: string;
  source: ProposalSource;
  base: string;
  proposed: string;
  reason?: string;
  absorbs?: string[];
}): DocProposalRow {
  const at = now();
  const id = run(
    "INSERT INTO doc_proposals (task_id, doc, source, base, proposed, reason, absorbs, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    p.taskId,
    p.doc,
    p.source,
    p.base,
    p.proposed,
    p.reason ?? "",
    JSON.stringify(p.absorbs ?? []),
    at,
    at,
  );
  return getProposal(id)!;
}

export function getProposal(id: number): DocProposalRow | null {
  return one<DocProposalRow>("SELECT * FROM doc_proposals WHERE id = ?", id);
}

export function proposalsForTask(taskId: number): DocProposalRow[] {
  return all<DocProposalRow>(
    "SELECT * FROM doc_proposals WHERE task_id = ? ORDER BY id",
    taskId,
  );
}

export function openProposalFor(
  doc: string,
  source: ProposalSource,
): DocProposalRow | null {
  return one<DocProposalRow>(
    "SELECT * FROM doc_proposals WHERE doc = ? AND source = ? AND status = 'open' AND task_id IN (SELECT id FROM tasks WHERE status IN ('open', 'later')) ORDER BY id DESC LIMIT 1",
    doc,
    source,
  );
}

export function openProposals(): DocProposalRow[] {
  return all<DocProposalRow>(
    "SELECT * FROM doc_proposals WHERE status = 'open' AND task_id IN (SELECT id FROM tasks WHERE status IN ('open', 'later')) ORDER BY id",
  );
}

export function reviseProposal(
  id: number,
  fields: {
    proposed: string;
    reason?: string;
    absorbs?: string[];
    base?: string;
  },
): void {
  const current = getProposal(id);
  if (!current) {
    return;
  }
  run(
    "UPDATE doc_proposals SET proposed = ?, reason = ?, absorbs = ?, base = ?, updated_at = ? WHERE id = ?",
    fields.proposed,
    fields.reason ?? current.reason,
    fields.absorbs ? JSON.stringify(fields.absorbs) : current.absorbs,
    fields.base ?? current.base,
    now(),
    id,
  );
}

export function setProposalStatus(id: number, status: ProposalStatus): void {
  run(
    "UPDATE doc_proposals SET status = ?, updated_at = ? WHERE id = ?",
    status,
    now(),
    id,
  );
}

// ── triage runs (the chain, as it ran on each message) ───────────────────

export interface NewTriageRun {
  messageId: number;
  input: Record<string, unknown>;
  verdict: unknown;
  rule: string;
  outcome: TriageVerdict | null;
  taskId: number | null;
  projectId: number | null;
  reason: string;
  steps: { rule: string; decision: StepDecision; reason: string; at: string }[];
}

export function addTriageRun(r: NewTriageRun): TriageRunRow {
  return batch(() => {
    const at = now();
    const id = run(
      "INSERT INTO triage_runs (message_id, input, verdict, rule, outcome, task_id, project_id, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      r.messageId,
      JSON.stringify(r.input),
      r.verdict === null || r.verdict === undefined
        ? null
        : JSON.stringify(r.verdict),
      r.rule,
      r.outcome,
      r.taskId,
      r.projectId,
      r.reason,
      at,
    );
    r.steps.forEach((step, seq) =>
      run(
        "INSERT INTO triage_steps (run_id, seq, rule, decision, reason, at) VALUES (?, ?, ?, ?, ?, ?)",
        id,
        seq,
        step.rule,
        step.decision,
        step.reason,
        step.at,
      ),
    );
    return one<TriageRunRow>("SELECT * FROM triage_runs WHERE id = ?", id)!;
  });
}

// Newest run first.
export function triageRunsFor(messageId: number): TriageRunRow[] {
  return all<TriageRunRow>(
    "SELECT * FROM triage_runs WHERE message_id = ? ORDER BY id DESC",
    messageId,
  );
}

export function triageSteps(runId: number): TriageStepRow[] {
  return all<TriageStepRow>(
    "SELECT * FROM triage_steps WHERE run_id = ? ORDER BY seq",
    runId,
  );
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

// The owner's latest move of each triaged task, newest first.
export function recentProjectMoves(limit = 8): ProjectMove[] {
  return all<ProjectMove>(
    `SELECT t.title AS title, COALESCE(c.before, 'no project') AS before, COALESCE(c.after, '') AS after
     FROM corrections c JOIN tasks t ON t.id = c.task_id
     WHERE c.id IN (SELECT MAX(id) FROM corrections WHERE what = ? GROUP BY task_id)
     ORDER BY c.id DESC LIMIT ?`,
    PROJECT_MOVE,
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

// ── task actions an event ran ───────────────────────────────────────────

// True for the first claim of (task, action, event); false ever after.
export function claimActionRun(
  taskId: number,
  action: string,
  event: string,
): boolean {
  const won = db()
    .query(
      "INSERT OR IGNORE INTO action_runs (task_id, action, event, at) VALUES (?, ?, ?, ?) RETURNING task_id",
    )
    .get(taskId, action, event, now());
  return won != null;
}

// A claimed run that never ran (the spend cap, a skill not found): the
// event may run it again.
export function releaseActionRun(
  taskId: number,
  action: string,
  event: string,
): void {
  db()
    .query(
      "DELETE FROM action_runs WHERE task_id = ? AND action = ? AND event = ?",
    )
    .run(taskId, action, event);
}

// Task events after an id, oldest first: what the engine turns into
// action triggers.
export function taskEventsAfter(id: number): TaskEventRow[] {
  return db()
    .query<TaskEventRow, [number]>(
      "SELECT * FROM task_events WHERE id > ? ORDER BY id LIMIT 200",
    )
    .all(id);
}

export function lastTaskEventId(): number {
  return (
    one<{ id: number | null }>("SELECT MAX(id) AS id FROM task_events")?.id ?? 0
  );
}

// ── spend (core/spend.ts decides; this keeps the rows) ───────────────────

export interface SpendInput {
  day: string;
  taskId: number | null;
  role: SpendRole;
  model: string | null;
  costUsd: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  // The persisted session the call ran in and claude's total for it then.
  sessionId?: string | null;
  sessionTotal?: number | null;
}

export function addSpend(row: SpendInput): void {
  run(
    "INSERT INTO spend (day, task_id, role, model, cost_usd, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, session_id, session_total, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    row.day,
    row.taskId,
    row.role,
    row.model,
    row.costUsd,
    row.input,
    row.output,
    row.cacheRead,
    row.cacheWrite,
    row.sessionId ?? null,
    row.sessionTotal ?? null,
    now(),
  );
}

// What claude last said a session had cost in all, or null if Riker never
// recorded it.
export function lastSessionTotal(sessionId: string): number | null {
  return (
    one<{ total: number }>(
      "SELECT session_total AS total FROM spend WHERE session_id = ? AND session_total IS NOT NULL ORDER BY id DESC LIMIT 1",
      sessionId,
    )?.total ?? null
  );
}

const SPEND_SUMS =
  "COALESCE(SUM(cost_usd), 0) AS cost, COUNT(*) AS calls, COALESCE(SUM(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens), 0) AS tokens";

export function spendOn(day: string): SpendTotal {
  return (
    one<SpendTotal>(`SELECT ${SPEND_SUMS} FROM spend WHERE day = ?`, day) ?? {
      cost: 0,
      calls: 0,
      tokens: 0,
    }
  );
}

export function spendByRole(day: string): SpendByRole[] {
  return all<SpendByRole>(
    `SELECT role, ${SPEND_SUMS} FROM spend WHERE day = ? GROUP BY role ORDER BY cost DESC, role`,
    day,
  );
}

// Days on or after `from`, newest first.
export function spendByDay(from: string): SpendByDay[] {
  return all<SpendByDay>(
    `SELECT day, ${SPEND_SUMS} FROM spend WHERE day >= ? GROUP BY day ORDER BY day DESC`,
    from,
  );
}

// The tasks that cost most on or after `from`.
export function spendByTask(from: string, limit = 10): SpendByTask[] {
  return all<SpendByTask>(
    `SELECT task_id, ${SPEND_SUMS} FROM spend WHERE day >= ? AND task_id IS NOT NULL GROUP BY task_id ORDER BY cost DESC LIMIT ?`,
    from,
    limit,
  );
}

export function taskSpend(taskId: number): SpendTotal {
  return (
    one<SpendTotal>(
      `SELECT ${SPEND_SUMS} FROM spend WHERE task_id = ?`,
      taskId,
    ) ?? {
      cost: 0,
      calls: 0,
      tokens: 0,
    }
  );
}

// ── blockers and wins ────────────────────────────────────────────────────

export function addBlocker(
  taskId: number,
  blockerId: number,
  by: string,
): void {
  run(
    "INSERT OR IGNORE INTO task_blockers (task_id, blocker_id, by, created_at) VALUES (?, ?, ?, ?)",
    taskId,
    blockerId,
    by,
    now(),
  );
}

// No blocker: all of them.
export function removeBlocker(taskId: number, blockerId?: number): void {
  if (blockerId === undefined) {
    run("DELETE FROM task_blockers WHERE task_id = ?", taskId);
  } else {
    run(
      "DELETE FROM task_blockers WHERE task_id = ? AND blocker_id = ?",
      taskId,
      blockerId,
    );
  }
}

export function blockersOf(taskId: number): number[] {
  return all<{ blocker_id: number }>(
    "SELECT blocker_id FROM task_blockers WHERE task_id = ? ORDER BY created_at, blocker_id",
    taskId,
  ).map((r) => r.blocker_id);
}

export function dependentsOf(blockerId: number): number[] {
  return all<{ task_id: number }>(
    "SELECT task_id FROM task_blockers WHERE blocker_id = ? ORDER BY created_at, task_id",
    blockerId,
  ).map((r) => r.task_id);
}

// Task id -> the tasks it waits on, for every task that waits on one.
export function allBlockers(): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const r of all<{ task_id: number; blocker_id: number }>(
    "SELECT task_id, blocker_id FROM task_blockers ORDER BY created_at, blocker_id",
  )) {
    out.set(r.task_id, [...(out.get(r.task_id) ?? []), r.blocker_id]);
  }
  return out;
}

export function winsOn(day: string): number[] {
  return all<{ task_id: number }>(
    "SELECT task_id FROM wins WHERE day = ? ORDER BY pinned_at, task_id",
    day,
  ).map((r) => r.task_id);
}

export function addWin(day: string, taskId: number): void {
  run(
    "INSERT OR IGNORE INTO wins (day, task_id, pinned_at) VALUES (?, ?, ?)",
    day,
    taskId,
    now(),
  );
}

export function removeWin(day: string, taskId: number): void {
  run("DELETE FROM wins WHERE day = ? AND task_id = ?", day, taskId);
}

// ── task events (the Wins tab's history) ────────────────────────────────

// Events in [from, to), oldest first. A session's end is the journal's, not
// the Wins history's.
export function eventsBetween(from: string, to: string): TaskEventRow[] {
  return all<TaskEventRow>(
    "SELECT * FROM task_events WHERE at >= ? AND at < ? AND kind != 'ended' ORDER BY at, id",
    from,
    to,
  );
}

// A task's events before `to`, oldest first: what it had come to by then.
export function eventsForTask(taskId: number, to: string): TaskEventRow[] {
  return all<TaskEventRow>(
    "SELECT * FROM task_events WHERE task_id = ? AND at < ? ORDER BY at, id",
    taskId,
    to,
  );
}

// The owner's and the agents' turns per task in [from, to).
export function turnCountsBetween(
  from: string,
  to: string,
): { task_id: number; role: TurnRole; n: number; last: string }[] {
  return all(
    "SELECT task_id, role, COUNT(*) AS n, MAX(started_at) AS last FROM turns WHERE started_at >= ? AND started_at < ? AND role IN ('you', 'agent') GROUP BY task_id, role",
    from,
    to,
  );
}

export function turnsForTaskBetween(
  taskId: number,
  from: string,
  to: string,
): TurnRow[] {
  return all<TurnRow>(
    "SELECT * FROM turns WHERE task_id = ? AND started_at >= ? AND started_at < ? ORDER BY started_at, id",
    taskId,
    from,
    to,
  );
}

export function movesBetween(from: string, to: string): MoveRow[] {
  return all<MoveRow>(
    "SELECT * FROM moves WHERE created_at >= ? AND created_at < ? ORDER BY created_at, id",
    from,
    to,
  );
}

export function taskSpendOn(taskId: number, day: string): SpendTotal {
  return (
    one<SpendTotal>(
      `SELECT ${SPEND_SUMS} FROM spend WHERE task_id = ? AND day = ?`,
      taskId,
      day,
    ) ?? {
      cost: 0,
      calls: 0,
      tokens: 0,
    }
  );
}

// Task id -> its PR's last read state, for every task with one.
export function prStates(): Map<number, string> {
  return new Map(
    all<{ task_id: number; state: string }>(
      "SELECT task_id, state FROM pr_status",
    ).map((r) => [r.task_id, r.state]),
  );
}

// ── task status (the row-level half; lifecycle.ts owns the agent's side) ─

// A task made --from another reports back to it when it ends, so whoever
// made it (a project lead, an agent) can see the result and decide what next.
export function tellFromTask(
  task: TaskRow,
  what: string,
  result: string | null,
): void {
  if (!task.from_task_id || !getTask(task.from_task_id)) {
    return;
  }
  addTurn({
    taskId: task.from_task_id,
    role: TurnRole.trigger,
    body: `${taskRef(task.id)} ${what}: ${task.title}${result ? `\nResult: ${result}` : ""}`,
  });
}

export function reopen(taskId: number): void {
  batch(() => {
    updateTask(taskId, {
      status: TaskStatus.open,
      closed_at: null,
      closed_by: null,
      remind_at: null,
    });
    cancelTimers(taskId, [TimerKind.remind]);
  });
}

// Put away until a day: the task's one reminder is a timer (core/timers.ts),
// and remind_at says the day on the task for the rail.
export function remindAt(taskId: number, at: string, by = "you"): void {
  batch(() => {
    updateTask(taskId, { status: TaskStatus.later, remind_at: at });
    cancelTimers(taskId, [TimerKind.remind]);
    addTimer({ taskId, kind: TimerKind.remind, dueAt: at, by });
  });
}

// ── timers ───────────────────────────────────────────────────────────────

export interface NewTimer {
  taskId: number;
  kind: TimerKind;
  dueAt: string;
  rule?: string | null;
  note?: string;
  by: string;
}

export function addTimer(t: NewTimer): TimerRow {
  const id = run(
    `INSERT INTO timers (task_id, kind, due_at, rule, note, by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    t.taskId,
    t.kind,
    t.dueAt,
    t.rule ?? null,
    t.note ?? "",
    t.by,
    now(),
  );
  return getTimer(id)!;
}

export function getTimer(id: number): TimerRow | null {
  return one<TimerRow>("SELECT * FROM timers WHERE id = ?", id);
}

// A task's timers still to fire, soonest first.
export function timersForTask(taskId: number): TimerRow[] {
  return all<TimerRow>(
    "SELECT * FROM timers WHERE task_id = ? AND state = 'pending' ORDER BY due_at, id",
    taskId,
  );
}

// Every timer still to fire, soonest first.
export function pendingTimers(limit = 100): TimerRow[] {
  return all<TimerRow>(
    "SELECT * FROM timers WHERE state = 'pending' ORDER BY due_at, id LIMIT ?",
    limit,
  );
}

export function dueTimers(at: string): TimerRow[] {
  return all<TimerRow>(
    "SELECT * FROM timers WHERE state = 'pending' AND due_at <= ? ORDER BY due_at, id",
    at,
  );
}

// A fired timer: done, or (a schedule) due again at its next time.
export function firedTimer(id: number, at: string, next: string | null): void {
  if (next) {
    run(
      "UPDATE timers SET due_at = ?, fired_at = ? WHERE id = ?",
      next,
      at,
      id,
    );
  } else {
    run("UPDATE timers SET state = 'done', fired_at = ? WHERE id = ?", at, id);
  }
}

export function setTimerState(id: number, state: TimerState): void {
  run("UPDATE timers SET state = ? WHERE id = ?", state, id);
}

// Tasks a timer fired on that the owner has not opened since (its message
// unread): the rail's Due section. Task id -> when the latest fired.
export function ringingTimers(): Map<number, string> {
  const rows = all<{ task_id: number; at: string }>(
    `SELECT task_id, MAX(received_at) AS at FROM messages
     WHERE channel = 'timer' AND read_at IS NULL AND task_id IS NOT NULL
     GROUP BY task_id`,
  );
  return new Map(rows.map((r) => [r.task_id, r.at]));
}

// The owner opened the task: its fired timers stop ringing.
export function silenceTimers(taskId: number): number {
  const ids = all<{ id: number }>(
    "SELECT id FROM messages WHERE channel = 'timer' AND task_id = ? AND read_at IS NULL",
    taskId,
  );
  for (const { id } of ids) {
    markMessageRead(id);
  }
  return ids.length;
}

// Cancels a task's pending timers of these kinds; returns how many.
export function cancelTimers(
  taskId: number,
  kinds: readonly TimerKind[],
): number {
  const ids = all<{ id: number }>(
    `SELECT id FROM timers WHERE task_id = ? AND state = 'pending'
     AND kind IN (SELECT value FROM json_each(?))`,
    taskId,
    JSON.stringify(kinds),
  );
  for (const { id } of ids) {
    setTimerState(id, TimerState.cancelled);
  }
  return ids.length;
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

// Only one claimer wins, so a move never runs twice. Whether this UPDATE won
// is read from RETURNING, not `.changes`: bun 1.3 counts the rows the
// table_versions trigger changed there too, so a won claim said 2 (#6).
export function claimMove(id: number): boolean {
  const won = db()
    .query(
      "UPDATE moves SET status = 'running' WHERE id = ? AND status = 'pending' RETURNING id",
    )
    .get(id);
  changed();
  return won != null;
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

// A move nobody picked up is failed, not left to run whenever Riker next starts.
export function abandonMove(id: number, why: string): boolean {
  const abandoned = db()
    .query(
      "UPDATE moves SET status = 'failed', result = ?, finished_at = ? WHERE id = ? AND status = 'pending' RETURNING id",
    )
    .get(why, now(), id);
  changed();
  return abandoned != null;
}

// ── session digests and stories (docs/session-digests-design.md) ─────────

export type DigestInput = Omit<DigestRow, "id" | "at"> & { at?: string };

export function addDigest(d: DigestInput): DigestRow {
  const id = run(
    `INSERT INTO digests (task_id, session_id, at, by, outcome, goals, did, decisions, learned, next, blocked, questions, links, knowledge, covers_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    d.task_id,
    d.session_id,
    d.at ?? now(),
    d.by,
    d.outcome,
    d.goals,
    d.did,
    d.decisions,
    d.learned,
    d.next,
    d.blocked,
    d.questions,
    d.links,
    d.knowledge,
    d.covers_to,
  );
  return one<DigestRow>("SELECT * FROM digests WHERE id = ?", id)!;
}

export function getDigest(id: number): DigestRow | null {
  return one<DigestRow>("SELECT * FROM digests WHERE id = ?", id);
}

// A session's digests, newest first.
export function digestsForSession(sessionId: string): DigestRow[] {
  return all<DigestRow>(
    "SELECT * FROM digests WHERE session_id = ? ORDER BY id DESC",
    sessionId,
  );
}

// The session's end before event `beforeId`: where its next run began.
export function sessionEndedBefore(
  sessionId: string,
  beforeId: number,
): TaskEventRow | null {
  return one<TaskEventRow>(
    "SELECT * FROM task_events WHERE kind = 'ended' AND detail = ? AND id < ? ORDER BY id DESC LIMIT 1",
    sessionId,
    beforeId,
  );
}

export function latestDigest(taskId: number): DigestRow | null {
  return one<DigestRow>(
    "SELECT * FROM digests WHERE task_id = ? ORDER BY id DESC LIMIT 1",
    taskId,
  );
}

export type StoryInput = Omit<StoryRow, "id" | "at"> & { at?: string };

export function addStory(v: StoryInput): StoryRow {
  const id = run(
    `INSERT INTO stories (task_id, digest_id, at, by, goals, now, decisions, blocked, next, questions, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    v.task_id,
    v.digest_id,
    v.at ?? now(),
    v.by,
    v.goals,
    v.now,
    v.decisions,
    v.blocked,
    v.next,
    v.questions,
    v.pinned,
  );
  return one<StoryRow>("SELECT * FROM stories WHERE id = ?", id)!;
}

// The current version of a task's story: its newest.
export function currentStory(taskId: number): StoryRow | null {
  return one<StoryRow>(
    "SELECT * FROM stories WHERE task_id = ? ORDER BY id DESC LIMIT 1",
    taskId,
  );
}

// Every version, newest first.
export function storiesFor(taskId: number): StoryRow[] {
  return all<StoryRow>(
    "SELECT * FROM stories WHERE task_id = ? ORDER BY id DESC",
    taskId,
  );
}
