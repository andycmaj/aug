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

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
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
  return db;
}

// Columns added after a table first shipped: added in place on an old file.
const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: "turns", column: "files", ddl: "TEXT NOT NULL DEFAULT '[]'" },
  { table: "tasks", column: "project_id", ddl: "INTEGER REFERENCES projects(id)" },
  { table: "tasks", column: "branch", ddl: "TEXT" },
  { table: "tasks", column: "worktree", ddl: "TEXT" },
  { table: "sessions", column: "tmux_window", ddl: "TEXT" },
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

export function now(): string {
  return new Date().toISOString();
}
