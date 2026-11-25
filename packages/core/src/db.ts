// The one SQLite file. WAL so the TUI can read while agent hooks (separate
// `riker hook` processes) write; `PRAGMA data_version` tells the TUI when anyone
// else has committed.

import { Database } from "bun:sqlite";
import { paths, ensureHome } from "./paths";
import { costBefore } from "./session-log";

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
  meta TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'new',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT
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
  started_by TEXT NOT NULL DEFAULT 'riker',
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
-- elsewhere. Unlike task_threads, Riker never reads what is behind them.
CREATE TABLE IF NOT EXISTS task_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  url TEXT NOT NULL,
  title TEXT,
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, url)
);

-- Moves asked for from another process (riker-tools, run by the Assistant or
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
  error TEXT,
  queue TEXT NOT NULL DEFAULT 'none',
  queue_position INTEGER,
  queue_reason TEXT
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

-- What each headless model call cost (core/spend.ts): one row per call, by
-- the owner's local day, the task it was for (none for triage, the Advisor)
-- and the role that made it. Coding agents in tmux are not here.
CREATE TABLE IF NOT EXISTS spend (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  day TEXT NOT NULL,
  task_id INTEGER,
  role TEXT NOT NULL,
  model TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  -- A persisted session's id and claude's total for it after this call: a
  -- resumed call reports the session's whole total, so its row costs the
  -- difference from the last one.
  session_id TEXT,
  session_total REAL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS spend_day ON spend(day);
CREATE INDEX IF NOT EXISTS spend_task ON spend(task_id);

-- What happened to a task, one row per change, kept after the task's own
-- columns move on (a reopen clears closed_at). Triggers write it
-- (recordEvents), so every writer in every process is heard. The Wins tab
-- reads a day of it.
CREATE TABLE IF NOT EXISTS task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_at ON task_events(at);
CREATE INDEX IF NOT EXISTS task_events_task ON task_events(task_id);

-- When something is due on a task (core/timers.ts): a follow-up, a schedule
-- or a reminder. The engine's tick turns each due one into a message on the
-- inbox and marks it done or moves it to its next time, in one write.
CREATE TABLE IF NOT EXISTS timers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  kind TEXT NOT NULL,
  due_at TEXT NOT NULL,
  rule TEXT,
  note TEXT NOT NULL DEFAULT '',
  by TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL,
  fired_at TEXT
);
CREATE INDEX IF NOT EXISTS timers_due ON timers(state, due_at);
CREATE INDEX IF NOT EXISTS timers_task ON timers(task_id);

-- A task action an event ran by itself, once per task, action and event,
-- so a re-triaged message or a reopen-and-close does not run it again.
CREATE TABLE IF NOT EXISTS action_runs (
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  action TEXT NOT NULL,
  event TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (task_id, action, event)
);

-- A finished session written up once: the project journal and the task's
-- story read it (core/digests.ts).
CREATE TABLE IF NOT EXISTS digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  session_id TEXT,
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  outcome TEXT NOT NULL,
  goals TEXT NOT NULL DEFAULT '',
  did TEXT NOT NULL DEFAULT '',
  decisions TEXT NOT NULL DEFAULT '',
  learned TEXT NOT NULL DEFAULT '',
  next TEXT NOT NULL DEFAULT '',
  blocked TEXT NOT NULL DEFAULT '',
  questions TEXT NOT NULL DEFAULT '',
  links TEXT NOT NULL DEFAULT '{}',
  knowledge TEXT NOT NULL DEFAULT '[]',
  covers_to INTEGER
);
CREATE INDEX IF NOT EXISTS digests_task ON digests(task_id);
CREATE INDEX IF NOT EXISTS digests_session ON digests(session_id);

-- A task's story, one row per version, newest is current (core/story.ts).
CREATE TABLE IF NOT EXISTS stories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES tasks(id),
  digest_id INTEGER REFERENCES digests(id),
  at TEXT NOT NULL,
  by TEXT NOT NULL,
  goals TEXT NOT NULL DEFAULT '',
  now TEXT NOT NULL DEFAULT '',
  decisions TEXT NOT NULL DEFAULT '',
  blocked TEXT NOT NULL DEFAULT '',
  next TEXT NOT NULL DEFAULT '',
  questions TEXT NOT NULL DEFAULT '',
  pinned TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS stories_task ON stories(task_id);
`;

let shared: Database | undefined;

export function openDb(file = paths.db()): Database {
  if (file !== ":memory:") {
    ensureHome();
  }
  const db = new Database(file, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA);
  migrate(db);
  recordEvents(db);
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
  spend: "spend",
  taskEvents: "task_events",
  actionRuns: "action_runs",
  timers: "timers",
  digests: "digests",
  stories: "stories",
} as const;
export type Table = (typeof Table)[keyof typeof Table];

export const TABLES: Table[] = Object.values(Table);

// A counter per table, bumped by triggers, so a write from any process (an
// agent's hook, riker-tools) says which table it touched. data_version only
// says that something changed.
function trackTables(db: Database): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS table_versions (name TEXT PRIMARY KEY, v INTEGER NOT NULL DEFAULT 0)",
  );
  const seed = db.query(
    "INSERT OR IGNORE INTO table_versions (name) VALUES (?)",
  );
  for (const table of TABLES) {
    seed.run(table);
    for (const op of ["INSERT", "UPDATE", "DELETE"]) {
      db.exec(
        `CREATE TRIGGER IF NOT EXISTS tv_${table}_${op.toLowerCase()} AFTER ${op} ON ${table} BEGIN UPDATE table_versions SET v = v + 1 WHERE name = '${table}'; END`,
      );
    }
  }
}

// SQLite's now in the shape of now(): ISO, UTC, milliseconds.
const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

// Task changes into task_events. After migrate: merged_at is an added
// column. A chat session "ends" with every turn, so only a coding (tmux)
// session's end is an event. Home and a project's manager are not work, so
// they have no events. The two that name kinds are made again at every
// start, so a kind added later reaches a file that already has them.
const EVENT_TRIGGERS = `
DROP TRIGGER IF EXISTS ev_task_created;
DROP TRIGGER IF EXISTS ev_task_status;
CREATE TRIGGER IF NOT EXISTS ev_task_created AFTER INSERT ON tasks
WHEN NEW.kind NOT IN ('home', 'manager')
BEGIN
  INSERT INTO task_events (task_id, kind, detail, at) VALUES (NEW.id, 'created', NEW.kind, NEW.created_at);
END;
CREATE TRIGGER IF NOT EXISTS ev_task_status AFTER UPDATE OF status ON tasks
WHEN NEW.status != OLD.status AND NEW.kind NOT IN ('home', 'manager')
  AND (NEW.status != 'open' OR OLD.status IN ('done', 'dropped'))
BEGIN
  INSERT INTO task_events (task_id, kind, detail, at) VALUES (
    NEW.id,
    CASE NEW.status WHEN 'open' THEN 'reopened' ELSE NEW.status END,
    CASE WHEN NEW.status IN ('done', 'dropped') THEN NEW.closed_by END,
    CASE WHEN NEW.status IN ('done', 'dropped') THEN COALESCE(NEW.closed_at, ${SQL_NOW}) ELSE ${SQL_NOW} END
  );
END;
CREATE TRIGGER IF NOT EXISTS ev_task_merged AFTER UPDATE OF merged_at ON tasks
WHEN (OLD.merged_at IS NULL) != (NEW.merged_at IS NULL)
BEGIN
  INSERT INTO task_events (task_id, kind, at) VALUES (
    NEW.id,
    CASE WHEN NEW.merged_at IS NULL THEN 'unmerged' ELSE 'merged' END,
    COALESCE(NEW.merged_at, ${SQL_NOW})
  );
END;
CREATE TRIGGER IF NOT EXISTS ev_session_finished AFTER UPDATE OF result ON sessions
WHEN NEW.result IS NOT NULL AND NEW.result IS NOT OLD.result
BEGIN
  INSERT INTO task_events (task_id, kind, detail, at) VALUES (NEW.task_id, 'finished', NEW.result, ${SQL_NOW});
END;
CREATE TRIGGER IF NOT EXISTS ev_session_ended AFTER UPDATE OF ended_at ON sessions
WHEN OLD.ended_at IS NULL AND NEW.ended_at IS NOT NULL AND NEW.kind = 'tmux'
BEGIN
  INSERT INTO task_events (task_id, kind, detail, at) VALUES (NEW.task_id, 'ended', NEW.id, NEW.ended_at);
END;
`;

// Tasks from before task_events get what their columns still say, once:
// when each was made, closed, merged, and what its agents finished.
const EVENTS_BACKFILLED = "events.backfilled";

function recordEvents(db: Database): void {
  db.transaction(() => {
    if (!db.query("SELECT 1 FROM kv WHERE key = ?").get(EVENTS_BACKFILLED)) {
      db.exec(`
        INSERT INTO task_events (task_id, kind, detail, at)
        SELECT id, 'created', kind, created_at FROM tasks WHERE kind != 'home'`);
      db.exec(`
        INSERT INTO task_events (task_id, kind, detail, at)
        SELECT id, status, closed_by, closed_at FROM tasks
        WHERE kind != 'home' AND status IN ('done', 'dropped') AND closed_at IS NOT NULL`);
      db.exec(`
        INSERT INTO task_events (task_id, kind, at)
        SELECT id, 'merged', merged_at FROM tasks WHERE merged_at IS NOT NULL`);
      db.exec(`
        INSERT INTO task_events (task_id, kind, detail, at)
        SELECT task_id, 'finished', result, COALESCE(ended_at, last_event_at) FROM sessions
        WHERE result IS NOT NULL`);
      db.query("INSERT INTO kv (key, value) VALUES (?, ?)").run(
        EVENTS_BACKFILLED,
        new Date().toISOString(),
      );
    }
    db.exec(EVENT_TRIGGERS);
  })();
}

export function tableVersions(): Record<Table, number> {
  const rows = db().query("SELECT name, v FROM table_versions").all() as {
    name: Table;
    v: number;
  }[];
  const out = {} as Record<Table, number>;
  for (const table of TABLES) {
    out[table] = 0;
  }
  for (const row of rows) {
    out[row.name] = row.v;
  }
  return out;
}

// Columns added after a table first shipped: added in place on an old file.
const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: "turns", column: "files", ddl: "TEXT NOT NULL DEFAULT '[]'" },
  {
    table: "tasks",
    column: "project_id",
    ddl: "INTEGER REFERENCES projects(id)",
  },
  { table: "tasks", column: "branch", ddl: "TEXT" },
  { table: "tasks", column: "worktree", ddl: "TEXT" },
  { table: "sessions", column: "tmux_window", ddl: "TEXT" },
  {
    table: "tasks",
    column: "from_task_id",
    ddl: "INTEGER REFERENCES tasks(id)",
  },
  // The task an approved idea became.
  {
    table: "ideas",
    column: "made_task_id",
    ddl: "INTEGER REFERENCES tasks(id)",
  },
  { table: "turns", column: "pending", ddl: "INTEGER NOT NULL DEFAULT 0" },
  // Where a running action is (the guide's stage), one line.
  { table: "turns", column: "progress", ddl: "TEXT" },
  { table: "projects", column: "brief", ddl: "TEXT NOT NULL DEFAULT ''" },
  {
    table: "tasks",
    column: "goal_id",
    ddl: "INTEGER REFERENCES project_goals(id)",
  },
  { table: "sessions", column: "end_reason", ddl: "TEXT" },
  { table: "sessions", column: "transcript_path", ddl: "TEXT" },
  { table: "projects", column: "journal", ddl: "INTEGER" },
  { table: "projects", column: "story", ddl: "INTEGER" },
  { table: "tasks", column: "story", ddl: "INTEGER" },
  { table: "sessions", column: "context_tokens", ddl: "INTEGER" },
  // The model a chat session started on: its prompt cache is that model's.
  { table: "sessions", column: "model", ddl: "TEXT" },
  { table: "tasks", column: "merged_at", ddl: "TEXT" },
  { table: "pr_status", column: "error", ddl: "TEXT" },
  { table: "spend", column: "session_id", ddl: "TEXT" },
  { table: "spend", column: "session_total", ddl: "REAL" },
  { table: "pr_status", column: "queue", ddl: "TEXT NOT NULL DEFAULT 'none'" },
  { table: "pr_status", column: "queue_position", ddl: "INTEGER" },
  { table: "pr_status", column: "queue_reason", ddl: "TEXT" },
  // The branch the PR merges into (another PR's in a stack): what the
  // guide's patch is taken against.
  { table: "pr_status", column: "base", ddl: "TEXT" },
  { table: "messages", column: "state", ddl: "TEXT NOT NULL DEFAULT 'new'" },
  { table: "messages", column: "attempts", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "messages", column: "next_at", ddl: "TEXT" },
  // A Knowledge entry the owner retired or merged into another (the doc
  // pass proposes it): kept, but out of what agents read.
  { table: "hub", column: "retired_at", ddl: "TEXT" },
  { table: "hub", column: "retired_why", ddl: "TEXT" },
  { table: "hub", column: "superseded_by", ddl: "INTEGER REFERENCES hub(id)" },
  { table: "projects", column: "standing", ddl: "TEXT NOT NULL DEFAULT ''" },
  { table: "projects", column: "standing_at", ddl: "TEXT" },
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
  const before = columns(db, "messages");
  const stateAdded = before.length > 0 && !before.includes("state");
  const spendBefore = columns(db, "spend");
  const sessionsAdded =
    spendBefore.length > 0 && !spendBefore.includes("session_id");
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    const cols = columns(db, table);
    if (cols.length > 0 && !cols.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    }
  }
  // Indexes on added columns wait until the columns exist.
  if (columns(db, "tasks").includes("branch")) {
    db.exec("CREATE INDEX IF NOT EXISTS tasks_branch ON tasks(repo, branch)");
  }
  if (columns(db, "spend").includes("session_id")) {
    if (sessionsAdded) {
      spendBySession(db);
    }
    db.exec("CREATE INDEX IF NOT EXISTS spend_session ON spend(session_id)");
  }
  if (columns(db, "messages").includes("state")) {
    if (stateAdded) {
      backfillMessageState(db);
    }
    db.exec(
      "CREATE INDEX IF NOT EXISTS messages_state ON messages(state, next_at)",
    );
  }
  for (const [from, to] of RENAMED_STATES) {
    if (columns(db, "tasks").length > 0) {
      db.query("UPDATE tasks SET agent_state = ? WHERE agent_state = ?").run(
        to,
        from,
      );
    }
    if (columns(db, "sessions").length > 0) {
      db.query("UPDATE sessions SET state = ? WHERE state = ?").run(to, from);
    }
  }
  backfillTriage(db);
  remindersToTimers(db);
}

// Before spend kept sessions, a resumed chat turn was recorded at its
// session's running total (claude -p --resume restores the cost state), so
// Home read $68 a turn. Each chat row is put on its session (its task's chat
// session latest started by then) and keeps only the difference from the
// row before it in that session; a session's first row, from the total
// before it in the session's own log, when the log says. Task actions on
// forks are left as they were.
function spendBySession(db: Database): void {
  if (columns(db, "sessions").length === 0) {
    return;
  }
  const rows = db
    .query(
      `SELECT sp.id, sp.cost_usd AS cost,
         (SELECT s.id FROM sessions s
           WHERE s.task_id = sp.task_id AND s.kind = 'chat' AND s.started_at <= sp.at
           ORDER BY s.started_at DESC LIMIT 1) AS session
       FROM spend sp
       WHERE sp.role IN ('assistant', 'general') AND sp.task_id IS NOT NULL
       ORDER BY sp.id`,
    )
    .all() as { id: number; cost: number; session: string | null }[];
  const update = db.query(
    "UPDATE spend SET session_id = ?, session_total = ?, cost_usd = ? WHERE id = ?",
  );
  const last = new Map<string, number>();
  db.transaction(() => {
    for (const row of rows) {
      if (!row.session) {
        continue;
      }
      const prev = last.get(row.session) ?? loggedBefore(row.session, row.cost);
      const cost =
        prev !== null && row.cost >= prev ? row.cost - prev : row.cost;
      last.set(row.session, row.cost);
      update.run(row.session, row.cost, cost, row.id);
    }
  })();
}

// Never fails a start: a log unread leaves the row as it was.
function loggedBefore(sessionId: string, total: number): number | null {
  try {
    return costBefore(sessionId, total);
  } catch {
    return null;
  }
}

// A task put away before reminders were timers keeps its day: one remind
// timer for each, unless one was ever made for that day.
function remindersToTimers(db: Database): void {
  if (columns(db, "timers").length === 0 || columns(db, "tasks").length === 0) {
    return;
  }
  db.exec(`
    INSERT INTO timers (task_id, kind, due_at, note, by, created_at)
    SELECT t.id, 'remind', t.remind_at, '', 'you', t.updated_at FROM tasks t
    WHERE t.status = 'later' AND t.remind_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM timers r WHERE r.task_id = t.id AND r.kind = 'remind' AND r.due_at = t.remind_at
      )`);
}

// A file from before the inbox kept state: what its columns say. A message
// triage filed is done; one the model failed on has had its try and stays
// for the owner (no next_at, so the worker leaves it); one nothing filed
// (Riker died between insert and triage) is new, and the worker takes it.
function backfillMessageState(db: Database): void {
  const ran =
    columns(db, "triage_runs").length > 0
      ? "OR EXISTS (SELECT 1 FROM triage_runs r WHERE r.message_id = messages.id)"
      : "";
  db.exec(`
    UPDATE messages SET
      state = CASE
        WHEN reason LIKE 'awaiting AI triage%' THEN 'failed'
        WHEN verdict IS NOT NULL OR reason IS NOT NULL OR task_id IS NOT NULL ${ran} THEN 'done'
        ELSE 'new'
      END,
      attempts = CASE WHEN reason LIKE 'awaiting AI triage%' THEN 1 ELSE 0 END`);
}

// Messages triaged before the chain was recorded get one run with a single
// "legacy" step from the verdict and reason they kept, so the Inbox explains
// every message the same way. Once: a message filed later outside triage
// (an FYI made a task by hand) has its own run already.
const TRIAGE_BACKFILLED = "triage.backfilled";

function backfillTriage(db: Database): void {
  for (const table of [
    "kv",
    "messages",
    "tasks",
    "triage_runs",
    "triage_steps",
  ]) {
    if (columns(db, table).length === 0) {
      return;
    }
  }
  const done = db
    .query("SELECT 1 FROM kv WHERE key = ?")
    .get(TRIAGE_BACKFILLED);
  if (done) {
    return;
  }
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
    db.query("INSERT INTO kv (key, value) VALUES (?, ?)").run(
      TRIAGE_BACKFILLED,
      new Date().toISOString(),
    );
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
      if (!isBusy(err) || attempt >= tries) {
        throw err;
      }
      await Bun.sleep(waitMs);
    }
  }
}

export function now(): string {
  return new Date().toISOString();
}
