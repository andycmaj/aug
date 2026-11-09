import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/core/config";
import { Engine } from "../src/core/engine";
import { drainMoves, MOVE_STALE_MS, waitForMove } from "../src/core/moves";
import { setMux } from "../src/core/mux";
import * as store from "../src/core/store";
import { handleDone } from "../src/core/hooks";
import { Kind, MoveStatus, SessionKind, TaskStatus } from "../src/core/types";
import { FakeMux } from "./fake-mux";
import { fakeBrain, freshHome } from "./helpers";

let engine: Engine;
let fake: FakeMux;

beforeEach(() => {
  freshHome({
    github: { ...DEFAULT_CONFIG.github, repos: { "acme/api": "/src/api" } },
  });
  fakeBrain(() => null);
  fake = new FakeMux();
  setMux(fake);
  engine = new Engine();
});

function ask(verb: string, args: Record<string, string>) {
  return store.enqueueMove(verb, args, "you");
}

describe("the moves bus", () => {
  test("a pending move runs once and records its result", async () => {
    const task = engine.newTask("Fix the build", Kind.general);
    const move = ask("done", { task: store.taskRef(task.id) });
    expect(await engine.drainMoves()).toBe(1);
    expect(await engine.drainMoves()).toBe(0);
    const row = store.getMove(move.id)!;
    expect(row.status).toBe(MoveStatus.done);
    expect(row.result).toBe(`${store.taskRef(task.id)} marked done`);
    expect(store.getTask(task.id)!.status).toBe(TaskStatus.done);
  });

  test("two drains at once never run a move twice", async () => {
    const task = engine.newTask("Ping Sam", Kind.general);
    ask("tell", { task: store.taskRef(task.id), text: "hello" });
    const [a, b] = await Promise.all([engine.drainMoves(), engine.drainMoves()]);
    expect(a + b).toBe(1);
  });

  test("an unknown task, verb or missing arg fails with a reason", async () => {
    const task = engine.newTask("Ping Sam", Kind.general);
    const noTask = ask("done", { task: "AUG-0999" });
    const noVerb = ask("explode", {});
    const noArg = ask("remind", { task: store.taskRef(task.id) });
    await engine.drainMoves();
    expect(store.getMove(noTask.id)!.result).toBe("no task AUG-0999");
    expect(store.getMove(noVerb.id)!.result).toStartWith("no move explode");
    expect(store.getMove(noArg.id)!.result).toBe("remind needs --days");
    for (const m of [noTask, noVerb, noArg])
      expect(store.getMove(m.id)!.status).toBe(MoveStatus.failed);
  });

  test("a move older than a minute expires instead of running", async () => {
    const task = engine.newTask("Old ask", Kind.general);
    const move = ask("done", { task: store.taskRef(task.id) });
    await drainMoves(engine, Date.now() + MOVE_STALE_MS + 1);
    expect(store.getMove(move.id)!.status).toBe(MoveStatus.failed);
    expect(store.getTask(task.id)!.status).toBe(TaskStatus.open);
  });

  test("waiting gives up on a move nobody picks up, so it never runs later", async () => {
    const task = engine.newTask("Nobody home", Kind.general);
    const move = ask("done", { task: store.taskRef(task.id) });
    const row = await waitForMove(move.id, { pickupMs: 20, pollMs: 5 });
    expect(row.status).toBe(MoveStatus.failed);
    expect(row.result).toContain("is aug running");
    await engine.drainMoves();
    expect(store.getTask(task.id)!.status).toBe(TaskStatus.open);
  });

  test("waiting returns the result once the engine has run it", async () => {
    const task = engine.newTask("Later", Kind.general);
    const move = ask("remind", { task: store.taskRef(task.id), days: "2" });
    setTimeout(() => void engine.drainMoves(), 10);
    const row = await waitForMove(move.id, { pollMs: 5 });
    expect(row.status).toBe(MoveStatus.done);
    expect(row.result).toStartWith(`${store.taskRef(task.id)} back on `);
  });
});

describe("start", () => {
  test("a coding task with no repo asks which, naming the known ones", async () => {
    const task = engine.newTask("Add a flag", Kind.coding);
    const out = await engine.runMove("start", { task: store.taskRef(task.id) });
    expect(out.ok).toBe(false);
    expect(out.result).toContain("needs repo");
    expect(out.result).toContain("acme/api");
  });

  test("an unmapped repo asks where it is checked out", async () => {
    const task = engine.newTask("Add a flag", Kind.coding);
    const out = await engine.runMove("start", {
      task: store.taskRef(task.id),
      repo: "acme/web",
    });
    expect(out.ok).toBe(false);
    expect(out.result).toContain("needs path");
    expect(store.getTask(task.id)!.repo).toBe("acme/web");
  });

  test("a coding task with a mapped repo starts in a worktree", async () => {
    const task = engine.newTask("Add a flag", Kind.coding);
    const out = await engine.runMove("start", {
      task: store.taskRef(task.id),
      repo: "acme/api",
    });
    expect(out).toEqual({
      ok: true,
      result: expect.stringContaining(`started ${store.taskRef(task.id)}'s coding agent`),
    });
    expect(store.getTask(task.id)!.worktree).toBeTruthy();
  });

  test("scratch starts with no repo at all", async () => {
    const task = engine.newTask("Try a thing", Kind.coding);
    const out = await engine.runMove("start", {
      task: store.taskRef(task.id),
      scratch: "yes",
    });
    expect(out.ok).toBe(true);
    expect(store.getTask(task.id)!.worktree).toBeNull();
  });
});

describe("making and placing tasks", () => {
  test("a coding task made from another, in a named project, takes its repo", async () => {
    const project = await engine.createProject("aug-bootstrap", "acme/api");
    const parent = engine.newTask("JOB.md is empty", Kind.general);
    const out = await engine.runMove(
      "new",
      {
        title: "Fill in JOB.md",
        kind: "coding",
        project: "AUG Bootstrap",
        brief: "Write JOB.md from the thread in AUG-0001",
        from: store.taskRef(parent.id),
      },
      "agent AUG-0001",
    );
    expect(out.ok).toBe(true);
    const made = store.listTasks().find((t) => t.title === "Fill in JOB.md")!;
    expect(out.result).toStartWith(`${store.taskRef(made.id)} made (coding in project aug-bootstrap, repo acme/api)`);
    expect(made).toMatchObject({
      kind: Kind.coding,
      project_id: project.id,
      repo: "acme/api",
      from_task_id: parent.id,
      summary: "Write JOB.md from the thread in AUG-0001",
    });
    expect(store.turnsForTask(made.id)[0].body).toBe(
      `Made from ${store.taskRef(parent.id)} by agent AUG-0001`,
    );
    expect(store.turnsForTask(parent.id).at(-1)!.body).toContain(
      `agent AUG-0001 made ${store.taskRef(made.id)} (coding in aug-bootstrap)`,
    );
  });

  test("a project that does not exist is named back with the ones that do", async () => {
    await engine.createProject("aug-mvp");
    const out = await engine.runMove("new", {
      title: "x",
      project: "aug-bootstrap",
    });
    expect(out).toEqual({
      ok: false,
      result: "no project aug-bootstrap. Projects: aug-mvp. Make one with project_new.",
    });
    expect(store.listTasks()).toHaveLength(0);
  });

  test("a bad kind or repo is refused before anything is made", async () => {
    expect((await engine.runMove("new", { title: "x", kind: "home" })).result).toStartWith(
      "kind must be",
    );
    expect((await engine.runMove("new", { title: "x", repo: "nope" })).result).toBe(
      "nope is not owner/repo",
    );
    expect(store.listTasks()).toHaveLength(0);
  });

  test("an unstarted task joins a project without waking its session", async () => {
    const project = await engine.createProject("api");
    const task = engine.newTask("Add a flag", Kind.coding);
    // You killed the session; nothing about this task needs it back yet.
    fake.sessions = [];
    const out = await engine.runMove("project", {
      task: store.taskRef(task.id),
      project: "api",
    });
    expect(out.ok).toBe(true);
    expect(store.getTask(task.id)!.project_id).toBe(project.id);
    expect(fake.sessions).toHaveLength(0);
  });

  test("retitle, kind and wait_on edit the task", async () => {
    const task = engine.newTask("old", Kind.general);
    const t = store.taskRef(task.id);
    await engine.runMove("retitle", { task: t, title: "new" });
    await engine.runMove("kind", { task: t, kind: "coding" });
    await engine.runMove("wait_on", { task: t, who: "Sam" });
    expect(store.getTask(task.id)).toMatchObject({
      title: "new",
      kind: Kind.coding,
      waiting_on: "Sam",
    });
  });

  async function child(parentTitle: string, by = "agent AUG-0001") {
    const parent = engine.newTask(parentTitle, Kind.general);
    await engine.runMove(
      "new",
      { title: "Fill in JOB.md", kind: "coding", from: store.taskRef(parent.id) },
      by,
    );
    const made = store.listTasks().find((t) => t.title === "Fill in JOB.md")!;
    return { parent, made, last: () => store.turnsForTask(parent.id).at(-1)! };
  }

  test("the task it was made from hears back when it is marked done", async () => {
    const { parent, made, last } = await child("JOB.md is empty");
    await engine.runMove("done", { task: store.taskRef(made.id) });
    expect(last().role).toBe("trigger");
    expect(last().body).toBe(`${store.taskRef(made.id)} marked done by you: Fill in JOB.md`);
    // done again (closeCoding after the agent closed it) says nothing new
    const count = store.turnsForTask(parent.id).length;
    await engine.closeCoding(made.id);
    expect(store.turnsForTask(parent.id)).toHaveLength(count);
  });

  test("when its agent finishes, the result line goes back to the task it came from", async () => {
    const { parent, made, last } = await child("JOB.md is empty");
    store.createSession({ id: "s1", taskId: made.id, kind: SessionKind.tmux, cwd: "/w", startedBy: "aug" });
    handleDone({ taskId: made.id, sessionId: "s1" }, { summary: "JOB.md written; 3 sections" });
    expect(store.getTask(made.id)!.status).toBe(TaskStatus.done);
    expect(last().body).toBe(
      `${store.taskRef(made.id)} finished: Fill in JOB.md\nResult: JOB.md written; 3 sections`,
    );
    const count = store.turnsForTask(parent.id).length;
    engine.markDone(made.id);
    expect(store.turnsForTask(parent.id)).toHaveLength(count);
  });

  test("an agent that finishes but leaves the task to its owner says so, then the close follows", async () => {
    const { made, last } = await child("JOB.md is empty");
    store.createSession({ id: "s1", taskId: made.id, kind: SessionKind.tmux, cwd: "/w", startedBy: "owner" });
    handleDone({ taskId: made.id, sessionId: "s1" }, { summary: "PR opened" });
    expect(last().body).toBe(
      `${store.taskRef(made.id)} finished; it waits for the owner: Fill in JOB.md\nResult: PR opened`,
    );
    engine.markDone(made.id);
    expect(last().body).toBe(
      `${store.taskRef(made.id)} marked done by you: Fill in JOB.md\nResult: PR opened`,
    );
  });

  test("a task made from nothing tells no one", async () => {
    const made = engine.newTask("Alone", Kind.general);
    const before = store.listTasks().flatMap((t) => store.turnsForTask(t.id)).length;
    engine.markDone(made.id);
    expect(store.listTasks().flatMap((t) => store.turnsForTask(t.id)).length).toBe(before);
  });
});

describe("projects", () => {
  test("project_new refuses a name already taken", async () => {
    expect((await engine.runMove("project_new", { name: "web" })).ok).toBe(true);
    expect((await engine.runMove("project_new", { name: "Web" })).result).toBe(
      "there is already a project web",
    );
  });

  test("project_repo adds a repo new coding tasks default to", async () => {
    await engine.runMove("project_new", { name: "web" });
    await engine.runMove("project_repo", { project: "web", repo: "acme/web" });
    await engine.runMove("new", { title: "x", kind: "coding", project: "web" });
    expect(store.listTasks()[0].repo).toBe("acme/web");
  });

  test("archiving a project with open tasks needs force", async () => {
    const project = await engine.createProject("web");
    engine.newTask("open one", Kind.general, "", { projectId: project.id });
    const refused = await engine.runMove("project_archive", { project: "web" });
    expect(refused.ok).toBe(false);
    expect(refused.result).toContain("--force yes");
    expect(store.getProject(project.id)!.status).toBe("active");
    const forced = await engine.runMove("project_archive", {
      project: "web",
      force: "yes",
    });
    expect(forced.ok).toBe(true);
    expect(store.getProject(project.id)!.status).toBe("archived");
  });
});

describe("what an agent may ask for", () => {
  test("it makes tasks, and edits only its own", async () => {
    const mine = engine.newTask("mine", Kind.general);
    const other = engine.newTask("other", Kind.general);
    const by = `agent ${store.taskRef(mine.id)}`;
    expect((await engine.runMove("new", { title: "follow-up", from: store.taskRef(mine.id) }, by)).ok).toBe(true);
    expect((await engine.runMove("wait_on", { task: store.taskRef(mine.id), who: "Sam" }, by)).ok).toBe(true);
    const theirs = await engine.runMove("priority", { task: store.taskRef(other.id), level: "urgent" }, by);
    expect(theirs).toEqual({ ok: false, result: `an agent changes only its own task (${store.taskRef(mine.id)})` });
  });

  test("starting, closing and projects stay the owner's", async () => {
    const mine = engine.newTask("mine", Kind.general);
    const by = `agent ${store.taskRef(mine.id)}`;
    for (const [verb, args] of [
      ["done", { task: store.taskRef(mine.id) }],
      ["start", { task: store.taskRef(mine.id) }],
      ["project_new", { name: "x" }],
    ] as const) {
      const out = await engine.runMove(verb, args, by);
      expect(out.ok).toBe(false);
      expect(out.result).toStartWith(`${verb} is the owner's move`);
    }
    expect(store.getTask(mine.id)!.status).toBe(TaskStatus.open);
  });
});
