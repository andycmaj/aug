// The one SQLite file. WAL so the TUI can read while agent hooks (separate
// `aug hook` processes) write; `PRAGMA data_version` tells the TUI when anyone
// else has committed.

import { Database } from "bun:sqlite";
import { paths, ensureHome } from "./paths";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'regular',
  priority_pinned INTEGER NOT NULL DEFAULT 0,
  watching INTEGER NOT NULL DEFAULT 0,
  remind_at TEXT,
  waiting_on TEXT,
  repo TEXT,
  thread_key TEXT,
  channel TEXT NOT NULL DEFAULT 'owner',
  url TEXT,
  agent_state TEXT NOT NULL DEFAULT 'none',
  agent_says TEXT,
  queue_reason TEXT,
  triage_reason TEXT,
  unread_result INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  closed_by TEXT
);
CREATE INDEX IF NOT EXISTS tasks_thread ON tasks(thread_key);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL UNIQUE,
  thread_key TEXT NOT NULL,
  author TEXT NOT NULL,
  author_name TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  url TEXT,
  received_at TEXT NOT NULL,
  task_id INTEGER REFERENCES tasks(id),
  verdict TEXT,
  reason TEXT,
  read_at TEXT,
  from_me INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_key);
CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id);

CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  role TEXT NOT NULL,
  message_id INTEGER,
  author TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  about TEXT,
  did TEXT,
  next TEXT,
  action TEXT,
  action_state TEXT,
  action_result TEXT,
  steps TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'done',
  session_id TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS turns_task ON turns(task_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  cwd TEXT NOT NULL,
  state TEXT NOT NULL,
  says TEXT,
  last_tool TEXT,
  started_by TEXT NOT NULL DEFAULT 'aug',
  started_at TEXT NOT NULL,
  last_event_at TEXT NOT NULL,
  ended_at TEXT,
  result TEXT
);
CREATE INDEX IF NOT EXISTS sessions_task ON sessions(task_id);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT NOT NULL,
  label TEXT NOT NULL,
  body TEXT NOT NULL,
  task_id INTEGER,
  read_by TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

-- Knowledge (the Board tab); the table kept its old name.
CREATE TABLE IF NOT EXISTS hub (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  author TEXT NOT NULL,
  parent_id INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  task_id INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER,
  message_id INTEGER,
  what TEXT NOT NULL,
  before TEXT,
  after TEXT,
  note TEXT,
  learned TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  tmux_session TEXT NOT NULL,
  repos TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  solo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

-- What a project is for, as outcomes its tasks add up to. A task names the
-- goal it serves (tasks.goal_id); a goal is met by the owner's say, not by
-- its tasks closing.
CREATE TABLE IF NOT EXISTS project_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  met_at TEXT
);
CREATE INDEX IF NOT EXISTS project_goals_project ON project_goals(project_id);

-- Docs a project leans on (a Notion page, a spec), as task_links are a
-- task's. Every task in the project sees them in its brief.
CREATE TABLE IF NOT EXISTS project_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  url TEXT NOT NULL,
  title TEXT,
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (project_id, url)
);

-- More threads that belong to a task: the PR its worktree opened, beside
-- the issue it came from.
CREATE TABLE IF NOT EXISTS task_threads (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  thread_key TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  PRIMARY KEY (thread_key, task_id)
);

-- URLs attached to a task by hand: a doc, a Slack thread, a ticket
-- elsewhere. Unlike task_threads, aug never reads what is behind them.
CREATE TABLE IF NOT EXISTS task_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  url TEXT NOT NULL,
  title TEXT,
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, url)
);

-- Moves asked for from another process (aug-tools, run by the Assistant or
-- an agent). The engine claims each one, runs it, and writes the result back.
CREATE TABLE IF NOT EXISTS moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  verb TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '{}',
  asked_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS moves_status ON moves(status);

-- The last read of a task's PR (checks, reviews, state), for the rail and
-- the table's header. core/pr.ts finds the PR and refreshes the row.
CREATE TABLE IF NOT EXISTS pr_status (
  task_id INTEGER PRIMARY KEY REFERENCES tasks(id),
  repo TEXT NOT NULL,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  state TEXT NOT NULL,
  checks TEXT NOT NULL,
  review TEXT NOT NULL,
  mergeable TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  error TEXT
);

CREATE TABLE IF NOT EXISTS doc_proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  doc TEXT NOT NULL,
  source TEXT NOT NULL,
  base TEXT NOT NULL,
  proposed TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  absorbs TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- A task waiting on other tasks. A row goes when its blocker is done or
-- dropped (lifecycle.blockerResolved).
CREATE TABLE IF NOT EXISTS task_blockers (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  blocker_id INTEGER NOT NULL REFERENCES tasks(id),
  by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, blocker_id)
);
CREATE INDEX IF NOT EXISTS task_blockers_blocker ON task_blockers(blocker_id);

-- The day's Wins: up to five tasks the owner pinned for that (local) day.
CREATE TABLE IF NOT EXISTS wins (
  day TEXT NOT NULL,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  pinned_at TEXT NOT NULL,
  PRIMARY KEY (day, task_id)
);

-- What triage did with a message, one run per pass of the chain (a re-run
-- adds one): what the rules saw, the model's verdict if one was asked, and
-- every rule in order with what it decided.
CREATE TABLE IF NOT EXISTS triage_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id),
  input TEXT NOT NULL DEFAULT '{}',
  verdict TEXT,
  rule TEXT NOT NULL,
  outcome TEXT,
  task_id INTEGER,
  project_id INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS triage_runs_message ON triage_runs(message_id);

CREATE TABLE IF NOT EXISTS triage_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES triage_runs(id),
  seq INTEGER NOT NULL,
  rule TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS triage_steps_run ON triage_steps(run_id, seq);
`;

let shared: Database | undefined;

export function openDb(file = paths.db()): Database {
  if (file !== ":memory:") ensureHome();
  const db = new Database(file, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  trackTables(db);
  return db;
}

// Every table, so the TUI can re-read only what a write touched.
export const Table = {
  tasks: "tasks",
  messages: "messages",
  turns: "turns",
  sessions: "sessions",
  notes: "notes",
  knowledge: "hub",
  ideas: "ideas",
  corrections: "corrections",
  projects: "projects",
  goals: "project_goals",
  projectLinks: "project_links",
  taskThreads: "task_threads",
  taskLinks: "task_links",
  moves: "moves",
  prStatus: "pr_status",
  proposals: "doc_proposals",
  kv: "kv",
  taskBlockers: "task_blockers",
  wins: "wins",
  triageRuns: "triage_runs",
  triageSteps: "triage_steps",
} as const;
export type Table = (typeof Table)[keyof typeof Table];

export const TABLES: Table[] = Object.values(Table);

// A counter per table, bumped by triggers, so a write from any process (an
// agent's hook, aug-tools) says which table it touched. data_version only
// says that something changed.
function trackTables(db: Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS table_versions (name TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0)",
  );
  const seed = db.query("INSERT OR IGNORE INTO table_versions (name) VALUES (?)");
  for (const table of TABLES) {
    seed.run(table);
    for (const op of ["INSERT", "UPDATE", "DELETE"])
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS tv_${table}_${op.toLowerCase()} AFTER ${op} ON ${table} BEGIN UPDATE table_versions SET v = v + 1 WHERE name = '${table}'; END`,
      );
  }
}

export function tableVersions(): Record<Table, number> {
  const rows = db().query("SELECT name, v FROM table_versions").all() as {
    name: Table;
    v: number;
  }[];
  const out = {} as Record<Table, number>;
  for (const table of TABLES) out[table] = 0;
  for (const row of rows) out[row.name] = row.v;
  return out;
}

// Columns added after a table first shipped: added in place on an old file.
const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: "turns", column: "files", ddl: "TEXT NOT NULL DEFAULT '[]'" },
  { table: "tasks", column: "project_id", ddl: "INTEGER REFERENCES projects(id)" },
  { table: "tasks", column: "branch", ddl: "TEXT" },
  { table: "tasks", column: "worktree", ddl: "TEXT" },
  { table: "sessions", column: "tmux_window", ddl: "TEXT" },
  { table: "tasks", column: "from_task_id", ddl: "INTEGER REFERENCES tasks(id)" },
  { table: "turns", column: "pending", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "projects", column: "brief", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "tasks", column: "goal_id", ddl: "INTEGER REFERENCES project_goals(id)" },
  { table: "sessions", column: "end_reason", ddl: "TEXT" },
  { table: "tasks", column: "merged_at", ddl: "TEXT" },
  { table: "pr_status", column: "error", ddl: "TEXT" },
];

// Agent states renamed or merged (docs/rail-status-design.md): blocked is
// waiting, saved is stopped, agentdone is ready (for review).
const RENAMED_STATES: [from: string, to: string][] = [
  ["blocked", "waiting"],
  ["saved", "stopped"],
  ["agentdone", "ready"],
];

function columns(db: Database, table: string): string[] {
  const rows = db.query(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return rows.map((r) => r.name);
}

export function migrate(db: Database): void {
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    const cols = columns(db, table);
    if (cols.length > 0 && !cols.includes(column))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
  // Indexes on added columns wait until the columns exist.
  if (columns(db, "tasks").includes("branch"))
    db.exec("CREATE INDEX IF NOT EXISTS tasks_branch ON tasks(repo, branch)");
  for (const [from, to] of RENAMED_STATES) {
    if (columns(db, "tasks").length > 0)
      db.query("UPDATE tasks SET agent_state = ? WHERE agent_state = ?").run(to, from);
    if (columns(db, "sessions").length > 0)
      db.query("UPDATE sessions SET state = ? WHERE state = ?").run(to, from);
  }
  backfillTriage(db);
}

// Messages triaged before the chain was recorded get one run with a single
// "legacy" step from the verdict and reason they kept, so the Inbox explains
// every message the same way. Once: a message filed later outside triage
// (an FYI made a task by hand) has its own run already.
const TRIAGE_BACKFILLED = "triage.backfilled";

function backfillTriage(db: Database): void {
  for (const table of ["kv", "messages", "tasks", "triage_runs", "triage_steps"])
    if (columns(db, table).length === 0) return;
  const done = db.query("SELECT 1 FROM kv WHERE key = ?").get(TRIAGE_BACKFILLED);
  if (done) return;
  db.transaction(() => {
    db.exec(`
      INSERT INTO triage_runs (message_id, rule, outcome, task_id, project_id, reason, at)
      SELECT m.id, 'legacy',
        CASE
          WHEN m.from_me = 1 THEN 'own'
          WHEN m.reason LIKE 'awaiting AI triage%' THEN 'failed'
          WHEN m.reason LIKE 'a greeting%' THEN 'opener'
          WHEN m.verdict IS NOT NULL THEN m.verdict
          WHEN m.task_id IS NOT NULL THEN 'attached'
          ELSE NULL
        END,
        m.task_id, t.project_id, COALESCE(m.reason, ''), m.received_at
      FROM messages m LEFT JOIN tasks t ON t.id = m.task_id
      WHERE (m.verdict IS NOT NULL OR m.reason IS NOT NULL OR m.task_id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM triage_runs r WHERE r.message_id = m.id)`);
    db.exec(`
      INSERT INTO triage_steps (run_id, seq, rule, decision, reason, at)
      SELECT r.id, 0, 'legacy', 'claim',
        COALESCE(NULLIF(r.reason, ''), 'triaged before the chain was recorded'), r.at
      FROM triage_runs r
      WHERE r.rule = 'legacy'
        AND NOT EXISTS (SELECT 1 FROM triage_steps s WHERE s.run_id = r.id)`);
    db.query("INSERT INTO kv (key, value) VALUES (?, ?)").run(TRIAGE_BACKFILLED, new Date().toISOString());
  })();
}

export function db(): Database {
  shared ??= openDb();
  return shared;
}

// Tests and fixture mode swap in their own database.
export function useDb(next: Database): void {
  shared = next;
}

// Bumps when another connection commits; the TUI polls it to know when to
// re-read without watching files.
export function dataVersion(): number {
  const row = db().query("PRAGMA data_version").get() as {
    data_version: number;
  };
  return row.data_version;
}

// Another process can hold the write lock past busy_timeout.
export function isBusy(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    typeof err.code === "string" &&
    err.code.startsWith("SQLITE_BUSY")
  );
}

// For a write that must land, like the record of a failure the owner should
// see: a busy database is tried again a few times before giving up.
export async function writeWhenFree<T>(
  write: () => T,
  tries = 8,
  waitMs = 250,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return write();
    } catch (err) {
      if (!isBusy(err) || attempt >= tries) throw err;
      await Bun.sleep(waitMs);
    }
  }
}

export function now(): string {
  return new Date().toISOString();
}
