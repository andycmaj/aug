import { beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate } from "../src/core/db";
import { Engine } from "../src/core/engine";
import { setMux } from "../src/core/mux";
import * as store from "../src/core/store";
import { PROJECT_STEP, triage } from "../src/core/triage";
import { ideaRow } from "../src/core/inbox";
import { Kind, type MessageRow } from "../src/core/types";
import { FakeMux } from "./fake-mux";
import { config, fakeBrain, freshHome, testConfig } from "./helpers";

function slackDm(n: number, body: string): MessageRow {
  return store.insertMessage({
    channel: "slack",
    externalId: `slack:D1:${n}`,
    threadKey: "slack:D1:dm",
    author: "U2",
    authorName: "Sam Delgado",
    title: "DM with Sam Delgado",
    body,
    receivedAt: new Date(Date.UTC(2026, 10, 5, 10, n)).toISOString(),
    meta: { channel: "D1", ts: `${n}.0`, dm: true },
  })!;
}

function ghIssue(n: number, body: string, repo = "acme/api"): MessageRow {
  return store.insertMessage({
    channel: "github",
    externalId: `gh:${repo}:${n}`,
    threadKey: `github:${repo}#${n}`,
    author: "erin",
    authorName: "erin",
    title: `${repo}#${n} issue`,
    body,
    receivedAt: new Date(Date.UTC(2026, 10, 5, 9, n)).toISOString(),
    meta: { repo, number: n, type: "Issue", reason: "mention" },
  })!;
}

const verdict = (v: string, extra: Record<string, unknown> = {}) => ({
  verdict: v,
  title: "Same-day pay providers",
  summary: "Sam asks which providers offer same-day pay.",
  priority: "regular",
  reason: "a direct question",
  ...extra,
});

function lastRun(messageId: number) {
  const [run] = store.triageRunsFor(messageId);
  return { run: run!, steps: store.triageSteps(run!.id) };
}

describe("the triage chain is recorded", () => {
  beforeEach(() => freshHome());

  test("every rule it tried, in order, with what each decided", async () => {
    fakeBrain(() => verdict("general"));
    const m = slackDm(1, "Which payroll providers do same-day pay?");
    const out = await triage(m, { config: config() });
    const { run, steps } = lastRun(m.id);
    expect(run.rule).toBe("new task");
    expect(run.outcome).toBe("general");
    expect(run.task_id).toBe(out.taskId);
    expect(JSON.parse(run.verdict!).verdict).toBe("general");
    expect(JSON.parse(run.input)).toMatchObject({ dm: true, openOnThread: null });
    expect(steps.map((s) => [s.rule, s.decision])).toEqual([
      ["own message", "pass"],
      ["greeting", "pass"],
      ["noise", "pass"],
      ["same thread", "pass"],
      ["after close", "pass"],
      ["review ask", "pass"],
      ["unjudged", "pass"],
      ["same ask", "pass"],
      ["judged fyi", "pass"],
      ["escalation", "pass"],
      ["new task", "claim"],
      [PROJECT_STEP, "pass"],
    ]);
    expect(steps.every((s) => s.reason.length > 0)).toBe(true);
  });

  test("a gate's claim stops the chain and asks no model", async () => {
    const calls = fakeBrain(() => verdict("general"));
    const m = slackDm(1, "hey!");
    await triage(m, { config: config() });
    const { run, steps } = lastRun(m.id);
    expect(calls).toHaveLength(0);
    expect(run.verdict).toBeNull();
    expect(run.outcome).toBe("opener");
    expect(steps.map((s) => s.rule)).toEqual(["own message", "greeting"]);
  });

  test("a failed model call keeps the error as the run's verdict", async () => {
    fakeBrain(() => null);
    const m = slackDm(1, "Can you look at the payroll export?");
    await triage(m, { config: config() });
    const { run } = lastRun(m.id);
    expect(run.outcome).toBe("failed");
    expect(JSON.parse(run.verdict!)).toEqual({ error: "unreadable verdict" });
  });
});

describe("triage files new work under a project", () => {
  beforeEach(() => freshHome());

  test("the repo's one project, with no guess", async () => {
    const api = store.createProject({ name: "API", tmuxSession: "api", repos: ["acme/api"] });
    fakeBrain(() => verdict("task", { project: "Web" }));
    const m = ghIssue(1, "the export drops transfers");
    const out = await triage(m, { config: config() });
    expect(store.getTask(out.taskId!)!.project_id).toBe(api.id);
    const { run, steps } = lastRun(m.id);
    expect(run.project_id).toBe(api.id);
    expect(steps.at(-1)).toMatchObject({
      rule: PROJECT_STEP,
      decision: "claim",
      reason: "acme/api is in project API",
    });
  });

  test("otherwise the project the model named", async () => {
    store.createProject({ name: "API", tmuxSession: "api", repos: ["acme/api"] });
    const payroll = store.createProject({ name: "Payroll", tmuxSession: "payroll" });
    const calls = fakeBrain(() => verdict("task", { project: "payroll" }));
    const out = await triage(slackDm(1, "Which payroll providers do same-day pay?"), {
      config: config(),
    });
    expect(store.getTask(out.taskId!)!.project_id).toBe(payroll.id);
    expect(calls[0]!.prompt).toContain("- Payroll");
  });

  test("a solo project is never offered, and a name that is no project files none", async () => {
    store.createProject({ name: "Payroll", tmuxSession: "payroll", solo: true });
    const calls = fakeBrain(() => verdict("task", { project: "Payroll" }));
    const m = slackDm(1, "Which payroll providers do same-day pay?");
    const out = await triage(m, { config: config() });
    expect(store.getTask(out.taskId!)!.project_id).toBeNull();
    expect(calls[0]!.prompt).not.toContain("- Payroll");
    expect(lastRun(m.id).steps.at(-1)).toMatchObject({ rule: PROJECT_STEP, decision: "pass" });
  });

  test("an attach runs no project step", async () => {
    fakeBrain(() => verdict("task"));
    await triage(ghIssue(1, "please look"), { config: config() });
    const second = store.insertMessage({
      channel: "github",
      externalId: "gh:again",
      threadKey: "github:acme/api#1",
      author: "erin",
      authorName: "erin",
      title: "acme/api#1 issue",
      body: "any update?",
      receivedAt: new Date().toISOString(),
    })!;
    const out = await triage(second, { config: config() });
    expect(out.verdict).toBe("attached");
    expect(lastRun(second.id).steps.map((s) => s.rule)).not.toContain(PROJECT_STEP);
  });
});

describe("re-running triage", () => {
  let engine: Engine;
  beforeEach(() => {
    freshHome();
    setMux(new FakeMux());
    engine = new Engine({ config: testConfig() });
  });

  test("adds a run to a message on no task", async () => {
    fakeBrain(() => null);
    const m = slackDm(1, "Can you look at the payroll export?");
    await triage(m, { config: config() });
    fakeBrain(() => verdict("fyi"));
    const again = await engine.desk.retriage(m.id);
    expect(again.ok).toBe(true);
    const runs = store.triageRunsFor(m.id);
    expect(runs.map((r) => r.outcome)).toEqual(["fyi", "failed"]);
  });

  test("is refused for a message on a task", async () => {
    fakeBrain(() => verdict("general"));
    const m = slackDm(1, "Which payroll providers do same-day pay?");
    const out = await triage(m, { config: config() });
    const again = await engine.desk.retriage(m.id);
    expect(again).toEqual({
      ok: false,
      why: `it is on ${store.taskRef(out.taskId!)}: use ignore instead`,
    });
    expect(store.triageRunsFor(m.id)).toHaveLength(1);
  });

  test("moving a triaged task to another project is a correction", async () => {
    fakeBrain(() => verdict("task"));
    const web = store.createProject({ name: "Web", tmuxSession: "web" });
    const out = await triage(slackDm(1, "Can you check the signup page?"), { config: config() });
    await engine.desk.moveTask(out.taskId!, web.id);
    expect(store.recentCorrections().map((c) => [c.what, c.after])).toContainEqual([
      "Triage project: filed it under another project",
      "Web",
    ]);
  });

  test("the next verdict reads where the owner last moved such work", async () => {
    fakeBrain(() => verdict("task"));
    const web = store.createProject({ name: "Web", tmuxSession: "web" });
    const payroll = store.createProject({ name: "Payroll", tmuxSession: "payroll" });
    const out = await triage(slackDm(1, "Which payroll providers do same-day pay?"), {
      config: config(),
    });
    await engine.desk.moveTask(out.taskId!, web.id);
    await engine.desk.moveTask(out.taskId!, payroll.id);
    expect(store.recentProjectMoves()).toEqual([
      { title: "Same-day pay providers", before: "Web", after: "Payroll" },
    ]);
    const calls = fakeBrain(() => verdict("fyi"));
    await triage(slackDm(2, "And what about Deel?"), { config: config() });
    const prompt = calls.find((c) => c.prompt.includes("A message arrived"))!.prompt;
    expect(prompt).toContain('- "Same-day pay providers": Web -> Payroll');
    expect(prompt).not.toContain("-> Web");
  });

  test("an approved idea keeps the task it made", () => {
    const about = engine.desk.newTask("payroll", Kind.task);
    const idea = store.addIdea("Follow up with Sam", "body", about.id);
    const task = engine.desk.ideaToTask(idea.id)!;
    const row = store.allIdeas().find((i) => i.id === idea.id)!;
    expect(row).toMatchObject({ status: "tasked", made_task_id: task.id, task_id: about.id });
    expect(ideaRow(row).taskId).toBe(task.id);
    expect(ideaRow(store.addIdea("open", "body", about.id)).taskId).toBe(about.id);
  });
});

describe("the backfill", () => {
  test("a message triaged before the chain was recorded gets one legacy run, once", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE tasks (id INTEGER PRIMARY KEY, repo TEXT, agent_state TEXT, project_id INTEGER);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, from_me INTEGER NOT NULL DEFAULT 0, verdict TEXT, reason TEXT, task_id INTEGER, received_at TEXT NOT NULL);
      CREATE TABLE triage_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL, input TEXT NOT NULL DEFAULT '{}', verdict TEXT, rule TEXT NOT NULL, outcome TEXT, task_id INTEGER, project_id INTEGER, reason TEXT NOT NULL DEFAULT '', at TEXT NOT NULL);
      CREATE TABLE triage_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, seq INTEGER NOT NULL, rule TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', at TEXT NOT NULL);
      INSERT INTO tasks (id, project_id) VALUES (7, 3);
      INSERT INTO messages (id, verdict, reason, task_id, received_at) VALUES
        (1, 'task', 'a direct ask', 7, '2026-11-01'),
        (2, NULL, 'a greeting; waits for the ask', NULL, '2026-11-02'),
        (3, 'fyi', 'awaiting AI triage (timeout)', NULL, '2026-11-03'),
        (4, NULL, NULL, NULL, '2026-11-04');
    `);
    migrate(db);
    migrate(db);
    const runs = db
      .query("SELECT message_id, outcome, project_id FROM triage_runs ORDER BY message_id")
      .all();
    expect(runs).toEqual([
      { message_id: 1, outcome: "task", project_id: 3 },
      { message_id: 2, outcome: "opener", project_id: null },
      { message_id: 3, outcome: "failed", project_id: null },
    ]);
    const steps = db.query("SELECT rule, decision, reason FROM triage_steps ORDER BY run_id").all();
    expect(steps[0]).toEqual({ rule: "legacy", decision: "claim", reason: "a direct ask" });
    expect(steps).toHaveLength(3);
  });

  test("each message's inbox state comes from what it kept, once", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY, from_me INTEGER NOT NULL DEFAULT 0, verdict TEXT, reason TEXT, task_id INTEGER, read_at TEXT, received_at TEXT NOT NULL);
      INSERT INTO messages (id, verdict, reason, task_id, received_at) VALUES
        (1, 'task', 'a direct ask', 7, '2026-11-01'),
        (2, NULL, 'a greeting; waits for the ask', NULL, '2026-11-02'),
        (3, 'fyi', 'awaiting AI triage (timeout)', NULL, '2026-11-03'),
        (4, NULL, NULL, NULL, '2026-11-04');
    `);
    migrate(db);
    // A later state change survives the next start's migrate.
    db.exec("UPDATE messages SET state = 'done' WHERE id = 4");
    migrate(db);
    expect(
      db.query("SELECT id, state, attempts, next_at FROM messages ORDER BY id").all(),
    ).toEqual([
      { id: 1, state: "done", attempts: 0, next_at: null },
      { id: 2, state: "done", attempts: 0, next_at: null },
      // Failed before: tried once, left for the owner.
      { id: 3, state: "failed", attempts: 1, next_at: null },
      { id: 4, state: "done", attempts: 0, next_at: null },
    ]);
  });

  test("a message never triaged is new, so the worker takes it", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE messages (id INTEGER PRIMARY KEY, from_me INTEGER NOT NULL DEFAULT 0, verdict TEXT, reason TEXT, task_id INTEGER, received_at TEXT NOT NULL);
      INSERT INTO messages (id, received_at) VALUES (4, '2026-11-04');
    `);
    migrate(db);
    expect(db.query("SELECT state FROM messages").get()).toEqual({ state: "new" });
  });
});

