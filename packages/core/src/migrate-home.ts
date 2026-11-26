// aug's home becomes Riker's (docs/rename-riker.md, Phase 2). Run at start,
// before anything opens the home, and by `riker migrate [--check]`. Only the
// default home moves: ~/.aug to ~/.riker, its files renamed, the stored
// values and repo slug brought over, and ~/.aug left as a link so the paths
// in agents started before keep resolving. A home named by RIKER_HOME, or a
// scratch AUG_HOME, is used as it is.

import { Database } from "bun:sqlite";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { CMD, envName, LEGACY, REPO, SELF } from "./brand";
import { defaultHome, legacyHome } from "./paths";

type Env = Record<string, string | undefined>;

export interface MigrateOptions {
  env?: Env;
  // aug's home and Riker's: ~/.aug and ~/.riker unless a test names others.
  from?: string;
  to?: string;
  alive?: (pid: number) => boolean;
}

export interface HomeMigration {
  from: string;
  to: string;
  // Why there is nothing to do; the home is used as it is.
  skip: string | null;
  // Why it cannot move now; Riker must not start on an empty home instead.
  refuse: string | null;
  // What it does (or did), one line each.
  steps: string[];
}

// The home's own files named for the program: the database and its WAL, the
// log and its rotation, the lock.
const STEMMED = ["db", "db-wal", "db-shm", "log", "log.1", "pid"];

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function heldBy(from: string, alive: (pid: number) => boolean): number | null {
  try {
    const pid = Number(
      readFileSync(join(from, `${LEGACY.cmd}.pid`), "utf8").trim(),
    );
    return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

export function planHomeMigration(opts: MigrateOptions = {}): HomeMigration {
  const env = opts.env ?? process.env;
  const from = opts.from ?? legacyHome();
  const to = opts.to ?? defaultHome();
  const plan = (
    skip: string | null,
    refuse: string | null,
    steps: string[] = [],
  ) => ({
    from,
    to,
    skip,
    refuse,
    steps,
  });
  const named = env[envName("HOME")];
  if (named) {
    return plan(
      `${envName("HOME")} is set (${named}): that home is used as it is`,
      null,
    );
  }
  const old = env[`${LEGACY.envPrefix}HOME`];
  if (old && resolve(old) !== resolve(from)) {
    return plan(
      `${LEGACY.envPrefix}HOME is set (${old}): that home is used as it is`,
      null,
    );
  }
  if (isLink(from)) {
    return plan(`${from} is already a link to ${readlinkSync(from)}`, null);
  }
  if (!existsSync(from)) {
    return plan(`no ${from}: nothing to move`, null);
  }
  if (existsSync(to)) {
    return plan(
      null,
      `both ${from} and ${to} exist: move one of them aside first`,
    );
  }
  const pid = heldBy(from, opts.alive ?? pidAlive);
  if (pid) {
    return plan(
      null,
      `${LEGACY.name} is running on ${from} (pid ${pid}): quit it first`,
    );
  }

  const files = STEMMED.filter((ext) =>
    existsSync(join(from, `${LEGACY.cmd}.${ext}`)),
  );
  const db = join(from, `${LEGACY.cmd}.db`);
  const steps = [
    `move ${from} to ${to}`,
    ...(files.length
      ? [
          `rename ${files.map((ext) => `${LEGACY.cmd}.${ext}`).join(", ")} to ${CMD}.*`,
        ]
      : []),
    `leave ${from} as a link to ${to}`,
    ...(existsSync(db) ? dbSteps(db, true) : []),
    ...configSteps(join(from, "config.json"), true),
  ];
  return plan(null, null, steps);
}

export function migrateHome(opts: MigrateOptions = {}): HomeMigration {
  const plan = planHomeMigration(opts);
  if (plan.skip || plan.refuse) {
    return plan;
  }
  const { from, to } = plan;
  renameSync(from, to);
  for (const ext of STEMMED) {
    const old = join(to, `${LEGACY.cmd}.${ext}`);
    if (existsSync(old)) {
      renameSync(old, join(to, `${CMD}.${ext}`));
    }
  }
  symlinkSync(to, from);
  const db = join(to, `${CMD}.db`);
  const steps = [
    `moved ${from} to ${to}, left a link`,
    ...(existsSync(db) ? dbSteps(db, false) : []),
    ...configSteps(join(to, "config.json"), false),
  ];
  return { ...plan, steps };
}

// ── the database ─────────────────────────────────────────────────────────

const OLD_URL = `https://github.com/${LEGACY.repo}`;
const NEW_URL = `https://github.com/${REPO}`;
const OLD_THREAD = `github:${LEGACY.repo}`;
const NEW_THREAD = `github:${REPO}`;

interface Change {
  what: string;
  table: string;
  count: string;
  apply: string;
  args: string[];
}

// Free text (titles, chat, notes) keeps what it said; these are the values
// Riker matches on. A GitHub thread key or URL starts with the slug, so the
// prefix is swapped: github:andycmaj/aug#10, .../andycmaj/aug/pull/10.
const CHANGES: Change[] = [
  {
    what: "turns said by aug",
    table: "turns",
    count: "SELECT count(*) AS n FROM turns WHERE author = ?1",
    apply: "UPDATE turns SET author = ?2 WHERE author = ?1",
    args: [LEGACY.self, SELF],
  },
  {
    what: "sessions aug started",
    table: "sessions",
    count: "SELECT count(*) AS n FROM sessions WHERE started_by = ?1",
    apply: "UPDATE sessions SET started_by = ?2 WHERE started_by = ?1",
    args: [LEGACY.self, SELF],
  },
  ...(
    [
      ["tasks", "repo"],
      ["pr_status", "repo"],
    ] as const
  ).map(([table, column]) => ({
    what: `${table}.${column} ${LEGACY.repo}`,
    table,
    count: `SELECT count(*) AS n FROM ${table} WHERE ${column} = ?1`,
    apply: `UPDATE ${table} SET ${column} = ?2 WHERE ${column} = ?1`,
    args: [LEGACY.repo, REPO],
  })),
  ...(
    [
      ["task_threads", "thread_key", OLD_THREAD, NEW_THREAD],
      ["messages", "thread_key", OLD_THREAD, NEW_THREAD],
      ["tasks", "url", OLD_URL, NEW_URL],
      ["pr_status", "url", OLD_URL, NEW_URL],
      ["task_links", "url", OLD_URL, NEW_URL],
    ] as const
  ).map(([table, column, old, now]) => ({
    what: `${table}.${column} ${old}`,
    table,
    // The slug ends there: andycmaj/aug-tools is another repo.
    count: `SELECT count(*) AS n FROM ${table} WHERE substr(${column}, 1, length(?1)) = ?1 AND substr(${column}, length(?1) + 1, 1) IN ('', '#', ':', '/')`,
    apply: `UPDATE ${table} SET ${column} = ?2 || substr(${column}, length(?1) + 1) WHERE substr(${column}, 1, length(?1)) = ?1 AND substr(${column}, length(?1) + 1, 1) IN ('', '#', ':', '/')`,
    args: [old, now],
  })),
];

function hasTable(db: Database, table: string): boolean {
  return Boolean(
    db
      .query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

interface ProjectRepos {
  id: number;
  repos: string;
}

function projectsToChange(db: Database): ProjectRepos[] {
  if (!hasTable(db, "projects")) {
    return [];
  }
  return (
    db.query("SELECT id, repos FROM projects").all() as ProjectRepos[]
  ).filter((p) => {
    try {
      return (JSON.parse(p.repos) as unknown[]).includes(LEGACY.repo);
    } catch {
      return false;
    }
  });
}

// One transaction: the counts in a dry run, the updates in a real one.
function dbSteps(file: string, dry: boolean): string[] {
  const db = new Database(file, dry ? { readonly: true } : {});
  try {
    const lines: string[] = [];
    const run = () => {
      for (const c of CHANGES) {
        if (!hasTable(db, c.table)) {
          continue;
        }
        const n = (db.query(c.count).get(c.args[0]) as { n: number }).n;
        if (!n) {
          continue;
        }
        if (!dry) {
          db.query(c.apply).run(...c.args);
        }
        lines.push(
          `${dry ? "update" : "updated"} ${n} ${c.what} to ${c.args[1]}`,
        );
      }
      const projects = projectsToChange(db);
      for (const p of projects) {
        if (dry) {
          continue;
        }
        const repos = (JSON.parse(p.repos) as string[]).map((r) =>
          r === LEGACY.repo ? REPO : r,
        );
        db.query("UPDATE projects SET repos = ? WHERE id = ?").run(
          JSON.stringify([...new Set(repos)]),
          p.id,
        );
      }
      if (projects.length) {
        lines.push(
          `${dry ? "update" : "updated"} ${projects.length} projects.repos ${LEGACY.repo} to ${REPO}`,
        );
      }
    };
    if (dry) {
      run();
    } else {
      db.transaction(run)();
    }
    return lines.map((l) => `db: ${l}`);
  } finally {
    db.close();
  }
}

// ── config.json ──────────────────────────────────────────────────────────

// repos is keyed by slug; the path stays (Phase 3 moves the checkout). A
// file from before repos left GitHub's section holds it as github.repos.
function configSteps(file: string, dry: boolean): string[] {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return [];
  }
  const github = raw.github as { repos?: Record<string, string> } | undefined;
  const holder = (raw.repos ? raw : github) as
    | { repos?: Record<string, string> }
    | undefined;
  const repos = holder?.repos;
  if (!repos || !(LEGACY.repo in repos) || REPO in repos) {
    return [];
  }
  const key = holder === raw ? "repos" : "github.repos";
  const line = `config.json: ${key} ${LEGACY.repo} becomes ${REPO} (${repos[LEGACY.repo]})`;
  if (dry) {
    return [line];
  }
  // Rebuilt in order, so the key keeps its place in the file.
  holder!.repos = Object.fromEntries(
    Object.entries(repos).map(([slug, path]) => [
      slug === LEGACY.repo ? REPO : slug,
      path,
    ]),
  );
  writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
  return [line];
}
