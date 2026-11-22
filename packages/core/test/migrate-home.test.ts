// aug's home becoming Riker's, on a scratch folder seeded the way aug left
// ~/.aug, and a private tmux server (-L) for the window tags. Never the real
// home or the default tmux server.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, useDb } from "../src/db";
import { migrateHome, planHomeMigration } from "../src/migrate-home";
import { TmuxMux } from "../src/mux";
import { setToolsEntry, toolsEntry } from "../src/self";
import * as store from "../src/store";
import { Kind, SessionKind, TurnRole } from "../src/types";
import { freshHome } from "./support/helpers";

let root: string;
let from: string;
let to: string;
const DEAD_PID = 999_999;
const none = () => false;

// What aug left: its database (rows that carry aug's values and its repo's
// slug, and one of another repo whose name starts the same), its log and a
// stale lock, a config mapping the repo, docs and a bin.
function seedAugHome(): { taskId: number; other: number } {
  mkdirSync(join(from, "docs"), { recursive: true });
  mkdirSync(join(from, "bin"));
  writeFileSync(join(from, "docs", "LEARNED.md"), "see AUG-0076\n");
  writeFileSync(join(from, "aug.log"), "a line\n");
  writeFileSync(join(from, "aug.pid"), `${DEAD_PID}\n`);
  writeFileSync(
    join(from, "config.json"),
    JSON.stringify(
      {
        github: {
          repos: {
            "andycmaj/ghdash": "/w/ghdash",
            "andycmaj/aug": "/w/aug",
            "andycmaj/aug-tools": "/w/aug-tools",
          },
        },
        theme: "dark",
      },
      null,
      2,
    ),
  );
  const db = openDb(join(from, "aug.db"));
  useDb(db);
  const task = store.createTask({
    title: "rename aug",
    kind: Kind.coding,
    channel: "owner",
    repo: "andycmaj/aug",
    url: "https://github.com/andycmaj/aug/pull/10",
  });
  const other = store.createTask({
    title: "a near name",
    kind: Kind.coding,
    channel: "owner",
    repo: "andycmaj/aug-tools",
    url: "https://github.com/andycmaj/aug-tools/pull/3",
  });
  store.linkThread(task.id, "github:andycmaj/aug#10");
  store.linkThread(other.id, "github:andycmaj/aug-tools#3");
  store.createProject({ name: "aug-misc", tmuxSession: "aug-misc", repos: ["andycmaj/aug", "andycmaj/ghdash"] });
  store.createSession({ id: "s1", taskId: task.id, kind: SessionKind.tmux, cwd: "/w/aug", startedBy: "owner" });
  store.createSession({ id: "s2", taskId: task.id, kind: SessionKind.tmux, cwd: "/w/aug", startedBy: "owner" });
  store.addTurn({ taskId: task.id, role: TurnRole.agent, author: "aug", body: "aug said this" });
  db.run("UPDATE sessions SET started_by = 'aug' WHERE id = 's1'");
  db.run(
    `INSERT INTO pr_status (task_id, repo, number, url, state, checks, review, mergeable, fetched_at)
     VALUES (?, 'andycmaj/aug', 10, 'https://github.com/andycmaj/aug/pull/10', 'open', 'pass', 'none', 'yes', '2026-11-21')`,
    [task.id],
  );
  db.close();
  return { taskId: task.id, other: other.id };
}

beforeEach(() => {
  // The test's own home for openDb's ensureHome; the migration is told its
  // folders and an empty env, so nothing real is near it.
  freshHome();
  root = mkdtempSync(join(tmpdir(), "riker-migrate-"));
  from = join(root, ".aug");
  to = join(root, ".riker");
  mkdirSync(from);
});

describe("when it runs", () => {
  test("a home named by RIKER_HOME, or a scratch AUG_HOME, is used as it is", () => {
    expect(planHomeMigration({ env: { RIKER_HOME: "/x" }, from, to }).skip).toContain("RIKER_HOME is set");
    expect(planHomeMigration({ env: { AUG_HOME: "/scratch" }, from, to }).skip).toContain("AUG_HOME is set");
  });

  test("AUG_HOME naming ~/.aug itself is the default home: it moves", () => {
    seedAugHome();
    const plan = planHomeMigration({ env: { AUG_HOME: from }, from, to, alive: none });
    expect(plan.skip).toBeNull();
    expect(plan.refuse).toBeNull();
  });

  test("refuses while aug runs on it, and when both homes exist", () => {
    seedAugHome();
    expect(planHomeMigration({ env: {}, from, to, alive: (pid) => pid === DEAD_PID }).refuse).toContain(
      `pid ${DEAD_PID}`,
    );
    mkdirSync(to);
    expect(planHomeMigration({ env: {}, from, to, alive: none }).refuse).toContain("both");
  });

  test("nothing without ~/.aug", () => {
    expect(planHomeMigration({ env: {}, from: join(root, "none"), to }).skip).toContain("nothing to move");
  });
});

describe("the move", () => {
  test("--check says what it would do and changes nothing", () => {
    seedAugHome();
    const plan = planHomeMigration({ env: {}, from, to, alive: none });
    expect(plan.steps).toEqual([
      `move ${from} to ${to}`,
      "rename aug.db, aug.db-wal, aug.db-shm, aug.log, aug.pid to riker.*",
      `leave ${from} as a link to ${to}`,
      "db: update 1 turns said by aug to riker",
      "db: update 1 sessions aug started to riker",
      "db: update 1 tasks.repo andycmaj/aug to andycmaj/riker",
      "db: update 1 pr_status.repo andycmaj/aug to andycmaj/riker",
      "db: update 1 task_threads.thread_key github:andycmaj/aug to github:andycmaj/riker",
      "db: update 1 tasks.url https://github.com/andycmaj/aug to https://github.com/andycmaj/riker",
      "db: update 1 pr_status.url https://github.com/andycmaj/aug to https://github.com/andycmaj/riker",
      "db: update 1 projects.repos andycmaj/aug to andycmaj/riker",
      "config.json: github.repos andycmaj/aug becomes andycmaj/riker (/w/aug)",
    ]);
    expect(existsSync(to)).toBe(false);
    expect(lstatSync(from).isDirectory()).toBe(true);
  });

  test("moves the home, renames its files, links the old path, brings the values over", () => {
    const { taskId, other } = seedAugHome();
    const done = migrateHome({ env: {}, from, to, alive: none });
    expect(done.refuse).toBeNull();
    expect(done.skip).toBeNull();

    expect(lstatSync(from).isSymbolicLink()).toBe(true);
    expect(readlinkSync(from)).toBe(to);
    for (const file of ["riker.db", "riker.log", "riker.pid", "docs/LEARNED.md", "config.json"])
      expect(existsSync(join(to, file))).toBe(true);
    for (const file of ["aug.db", "aug.log", "aug.pid"]) expect(existsSync(join(to, file))).toBe(false);
    // Old paths resolve through the link.
    expect(readFileSync(join(from, "docs", "LEARNED.md"), "utf8")).toBe("see AUG-0076\n");

    const db = new Database(join(to, "riker.db"), { readonly: true });
    const one = <T>(sql: string, ...args: (string | number)[]) => db.query(sql).get(...args) as T;
    expect(one<{ author: string }>("SELECT author FROM turns WHERE body = 'aug said this'").author).toBe("riker");
    expect(one<{ n: number }>("SELECT count(*) AS n FROM sessions WHERE started_by = 'riker'").n).toBe(1);
    expect(one<{ n: number }>("SELECT count(*) AS n FROM sessions WHERE started_by = 'owner'").n).toBe(1);
    expect(one<{ repo: string; url: string }>("SELECT repo, url FROM tasks WHERE id = ?", taskId)).toEqual({
      repo: "andycmaj/riker",
      url: "https://github.com/andycmaj/riker/pull/10",
    });
    // Another repo whose name starts the same is left alone.
    expect(one<{ repo: string; url: string }>("SELECT repo, url FROM tasks WHERE id = ?", other)).toEqual({
      repo: "andycmaj/aug-tools",
      url: "https://github.com/andycmaj/aug-tools/pull/3",
    });
    expect(
      (db.query("SELECT thread_key FROM task_threads ORDER BY task_id").all() as { thread_key: string }[]).map(
        (r) => r.thread_key,
      ),
    ).toEqual(["github:andycmaj/riker#10", "github:andycmaj/aug-tools#3"]);
    expect(one<{ repo: string; url: string }>("SELECT repo, url FROM pr_status")).toEqual({
      repo: "andycmaj/riker",
      url: "https://github.com/andycmaj/riker/pull/10",
    });
    expect(JSON.parse(one<{ repos: string }>("SELECT repos FROM projects").repos)).toEqual([
      "andycmaj/riker",
      "andycmaj/ghdash",
    ]);
    // The text keeps what it said.
    expect(one<{ title: string }>("SELECT title FROM tasks WHERE id = ?", taskId).title).toBe("rename aug");
    db.close();

    const config = JSON.parse(readFileSync(join(to, "config.json"), "utf8"));
    // The key keeps its place; the path stays (Phase 3 moves the checkout).
    expect(config.github.repos).toEqual({
      "andycmaj/ghdash": "/w/ghdash",
      "andycmaj/riker": "/w/aug",
      "andycmaj/aug-tools": "/w/aug-tools",
    });
    expect(Object.keys(config.github.repos)).toEqual(["andycmaj/ghdash", "andycmaj/riker", "andycmaj/aug-tools"]);
    expect(config.theme).toBe("dark");
  });

  test("a second run finds the link and does nothing", () => {
    seedAugHome();
    migrateHome({ env: {}, from, to, alive: none });
    const again = migrateHome({ env: {}, from, to, alive: none });
    expect(again.skip).toContain("already a link");
  });

  test("the moved database opens as Riker's", () => {
    seedAugHome();
    migrateHome({ env: {}, from, to, alive: none });
    const db = openDb(join(to, "riker.db"));
    useDb(db);
    expect(store.listTasks().map((t) => t.title).sort()).toEqual(["a near name", "rename aug"]);
    db.close();
  });
});

// tmux 3.x on PATH; a private server, killed after.
const SOCKET = `riker-migrate-${process.pid}`;
const tmux = (...args: string[]) => {
  const run = Bun.spawnSync(["tmux", "-L", SOCKET, "-f", "/dev/null", ...args], { stdout: "pipe", stderr: "pipe" });
  return run.stdout.toString().trim();
};

describe.skipIf(!Bun.which("tmux"))("tmux tags", () => {
  // The made-up entry below would leak into later files, whose starts refuse a
  // riker-tools that is not there.
  const entry = toolsEntry();
  afterAll(() => {
    tmux("kill-server");
    setToolsEntry(entry);
  });

  test("aug's @aug_* tags are copied to @riker_*, and @riker_tools is this Riker's", async () => {
    setToolsEntry("/riker/packages/cli/src/riker-tools.ts");
    tmux("new-session", "-d", "-s", "aug-misc", "-n", "agent", "sleep 60");
    tmux("set-option", "-t", "aug-misc", "@aug_project", "4");
    tmux("set-option", "-w", "-t", "aug-misc:agent", "@aug_task", "90");
    tmux("set-option", "-w", "-t", "aug-misc:agent", "@aug_tools", "bun /old/aug-tools.ts");
    tmux("new-window", "-d", "-t", "aug-misc:", "-n", "mine", "sleep 60");
    // One already tagged by Riker keeps its tag.
    tmux("new-session", "-d", "-s", "ledger", "-n", "agent", "sleep 60");
    tmux("set-option", "-t", "ledger", "@riker_project", "5");
    tmux("set-option", "-t", "ledger", "@aug_project", "6");

    const mux = new TmuxMux(SOCKET);
    // Read through the fallback before anything is copied.
    const before = await mux.state();
    expect(before.sessions.find((s) => s.name === "aug-misc")?.projectId).toBe(4);
    expect(before.windows.find((w) => w.name === "agent" && w.taskId)?.taskId).toBe(90);

    expect(await mux.copyLegacyTags()).toBe(2);
    expect(tmux("display", "-p", "-t", "aug-misc", "#{@riker_project}")).toBe("4");
    expect(tmux("display", "-p", "-t", "aug-misc:agent", "#{@riker_task}")).toBe("90");
    expect(tmux("display", "-p", "-t", "aug-misc:agent", "#{@riker_tools}")).toContain("riker-tools.ts");
    expect(tmux("display", "-p", "-t", "aug-misc:mine", "#{@riker_task}")).toBe("");
    expect(tmux("display", "-p", "-t", "ledger", "#{@riker_project}")).toBe("5");
    // Idempotent.
    expect(await mux.copyLegacyTags()).toBe(0);
  });
});
