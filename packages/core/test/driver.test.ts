import { beforeEach, describe, expect, test } from "bun:test";
import { Engine } from "../src/engine";
import { sessionActivity } from "../src/lifecycle";
import { setMux } from "../src/mux";
import * as store from "../src/store";
import { AgentState, Kind, TaskStatus } from "../src/types";
import { FakeMux } from "./support/fake-mux";
import { fakeBrain, freshHome, testConfig } from "./support/helpers";

let engine: Engine;
let fake: FakeMux;

beforeEach(() => {
  freshHome({
    repos: { "acme/api": "/src/api" },
  });
  fakeBrain(() => ({ about: "a", did: "b", next: "c", state: "done" }));
  fake = new FakeMux();
  setMux(fake);
  engine = new Engine({ config: testConfig() });
});

const ref = (id: number) => store.taskRef(id);

describe("a coding task's driver", () => {
  test("asks for repo, then path, then branch, and starts once it has them", async () => {
    const task = engine.desk.newTask("Add a flag", Kind.coding);
    const noRepo = await engine.desk.startAgent(task.id);
    expect(noRepo).toEqual({
      type: "needs",
      need: { what: "repo", choices: ["acme/api"] },
    });

    engine.desk.setTaskRepo(task.id, "acme/web");
    const noPath = await engine.desk.startAgent(task.id);
    expect(noPath).toMatchObject({
      type: "needs",
      need: { what: "path", repo: "acme/web", problem: { kind: "unmapped" } },
    });

    engine.desk.setTaskRepo(task.id, "acme/api");
    const noBranch = await engine.desk.startAgent(task.id);
    expect(noBranch).toEqual({
      type: "needs",
      need: { what: "branch", suggested: "add-a-flag" },
    });

    const started = await engine.desk.startAgent(task.id, { branch: "flag" });
    expect(started.type).toBe("started");
    expect(fake.worktrees[0].branch).toBe("flag");
    expect(store.getTask(task.id)!.agent_state).toBe(AgentState.working);
  });

  test("scratch skips every question; resuming never asks again", async () => {
    const task = engine.desk.newTask("Try a thing", Kind.coding);
    expect(
      (await engine.desk.startAgent(task.id, { noWorktree: true })).type,
    ).toBe("started");
    await engine.desk.stopAgent(task.id);
    expect(store.getTask(task.id)!.agent_state).toBe(AgentState.stopped);
    expect(fake.windows).toHaveLength(0);
    expect((await engine.desk.startAgent(task.id)).type).toBe("started");
    expect(fake.windows[0].argv).toContain("--resume");
  });

  test("the stop move ends a coding agent's window, not just the chat pool", async () => {
    const task = engine.desk.newTask("Add a flag", Kind.coding, "", {
      repo: "acme/api",
    });
    await engine.desk.startAgent(task.id, { branch: "flag" });
    expect(fake.windows).toHaveLength(1);
    const out = await engine.runMove("stop", { task: ref(task.id) });
    expect(out.ok).toBe(true);
    expect(fake.windows).toHaveLength(0);
    expect(store.getTask(task.id)!.agent_state).toBe(AgentState.stopped);
  });

  test("close marks it done, then takes the window and worktree", async () => {
    const task = engine.desk.newTask("Add a flag", Kind.coding, "", {
      repo: "acme/api",
    });
    await engine.desk.startAgent(task.id, { branch: "flag" });
    const r = await engine.desk.close(task.id);
    expect(r.archived).toBe(true);
    expect(fake.windows).toHaveLength(0);
    expect(fake.removed).toHaveLength(1);
    expect(store.getTask(task.id)!.status).toBe(TaskStatus.done);
  });

  test("a line typed while claude runs goes to its window; otherwise it waits", async () => {
    const task = engine.desk.newTask("Add a flag", Kind.coding, "", {
      repo: "acme/api",
    });
    expect(await engine.desk.say(task.id, "early")).toBe(false);
    expect(store.pendingTurns(task.id)).toHaveLength(1);
    await engine.desk.startAgent(task.id, { branch: "flag" });
    expect(store.pendingTurns(task.id)).toHaveLength(0);
    expect(fake.windows[0].argv.at(-1)).toContain("early");
    expect(await engine.desk.say(task.id, "later")).toBe(true);
    expect(fake.sent).toEqual([
      { windowId: fake.windows[0].id, text: "later" },
    ]);
  });

  test("a second start while one is in flight is refused, not run", async () => {
    const task = engine.desk.newTask("Add a flag", Kind.coding, "", {
      repo: "acme/api",
    });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    const newWindow = fake.newWindow.bind(fake);
    fake.newWindow = async (w) => {
      await gate;
      return newWindow(w);
    };
    const seen: number[][] = [];
    const off = engine.desk.onStarting((ids) => seen.push([...ids]));

    const first = engine.desk.startAgent(task.id, { branch: "flag" });
    await Bun.sleep(5);
    expect(engine.desk.isStarting(task.id)).toBe(true);
    expect(await engine.desk.startAgent(task.id, { branch: "flag" })).toEqual({
      type: "starting",
    });
    const moved = await engine.runMove("start", { task: ref(task.id) });
    expect(moved).toMatchObject({ ok: true });
    expect(moved.result).toContain("already starting");

    open();
    expect((await first).type).toBe("started");
    expect(fake.windows).toHaveLength(1);
    expect(engine.desk.isStarting(task.id)).toBe(false);
    expect(seen).toEqual([[task.id], []]);
    off();
  });

  test("a failed start clears the guard, so it can be tried again", async () => {
    const task = engine.desk.newTask("Add a flag", Kind.coding, "", {
      repo: "acme/api",
    });
    const worktree = fake.worktree.bind(fake);
    fake.worktree = async () => {
      throw new Error("disk full");
    };
    const failed = await engine.desk.startAgent(task.id, { branch: "flag" });
    expect(failed.type).toBe("failed");
    expect(engine.desk.isStarting(task.id)).toBe(false);
    fake.worktree = worktree;
    expect(
      (await engine.desk.startAgent(task.id, { branch: "flag" })).type,
    ).toBe("started");
  });
});

describe("a general task's driver", () => {
  test("start runs a turn with the note; Home has nothing to start", async () => {
    const task = engine.desk.newTask("Think", Kind.general);
    const r = await engine.desk.startAgent(task.id, { note: "go" });
    expect(r).toEqual({ type: "started", project: null });
    await Bun.sleep(10);
    expect(store.turnsForTask(task.id).map((t) => t.role)).toEqual([
      "you",
      "agent",
    ]);
    const home = await engine.desk.startAgent(store.homeTask().id);
    expect(home.type).toBe("failed");
  });

  test("a typed line is heard at once, and stop cancels a queued start", async () => {
    const task = engine.desk.newTask("Think", Kind.general);
    expect(await engine.desk.say(task.id, "hello")).toBe(true);
    expect(store.pendingTurns(task.id)).toHaveLength(0);
    const held = engine.desk.newTask("Held", Kind.coding);
    engine.desk.setKind(held.id, Kind.general);
    expect(store.getTask(held.id)!.agent_state).toBe(AgentState.queued);
    await engine.desk.stopAgent(held.id);
    expect(store.getTask(held.id)!.agent_state).toBe(AgentState.stopped);
  });

  test("close stops the pool's turn and marks the task done", async () => {
    const task = engine.desk.newTask("Think", Kind.general);
    await engine.desk.startAgent(task.id);
    const r = await engine.desk.close(task.id);
    expect(r).toEqual({ warnings: [], archived: false });
    expect(store.getTask(task.id)!.status).toBe(TaskStatus.done);
    expect(engine.desk.isLive(store.getTask(task.id)!)).toBe(false);
  });
});

describe("Agents at once (maxActiveAgents)", () => {
  const codingTask = (title: string) =>
    engine.desk.newTask(title, Kind.coding, "", { repo: "acme/api" });

  const latestRef = (taskId: number) => ({
    taskId,
    sessionId: store.latestSession(taskId)!.id,
  });

  beforeEach(() => {
    freshHome({
      repos: { "acme/api": "/src/api" },
      maxActiveAgents: 2,
    });
    fake = new FakeMux();
    setMux(fake);
    engine = new Engine({ config: testConfig() });
  });

  test("Starts pressed back to back never run more coding agents than the limit", async () => {
    const tasks = [1, 2, 3, 4].map((n) => codingTask(`Task ${n}`));
    // All at once, as six quick presses of s were: none has started yet
    // when the next asks.
    const results = await Promise.all(
      tasks.map((t) => engine.desk.startAgent(t.id, { branch: `b${t.id}` })),
    );
    expect(results.map((r) => r.type)).toEqual([
      "started",
      "started",
      "queued",
      "queued",
    ]);
    expect(fake.windows).toHaveLength(2);
    expect(store.getTask(tasks[2].id)!.agent_state).toBe(AgentState.queued);
    expect(store.getTask(tasks[2].id)!.queue_reason).toContain(
      "waiting its turn",
    );
  });

  test("a queued Start runs, with its branch and note, once a working agent stops working", async () => {
    const [a, b, c] = ["A", "B", "C"].map(codingTask);
    await engine.desk.startAgent(a.id, { branch: "ba" });
    await engine.desk.startAgent(b.id, { branch: "bb" });
    const r = await engine.desk.startAgent(c.id, { branch: "bc", note: "go" });
    expect(r.type).toBe("queued");

    engine.pool.drain();
    expect(fake.windows).toHaveLength(2);

    // A's claude finishes its turn (its Stop hook): idle, not working.
    sessionActivity(latestRef(a.id), AgentState.waiting, "which way?");
    engine.pool.drain();
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(fake.windows).toHaveLength(3);
    expect(fake.worktrees.at(-1)!.branch).toBe("bc");
    expect(fake.windows.at(-1)!.argv.join(" ")).toContain("go");
    expect(store.getTask(c.id)!.agent_state).toBe(AgentState.working);
  });

  test("a coding agent already running only hears the note, even at the limit", async () => {
    const [a, b] = ["A", "B"].map(codingTask);
    await engine.desk.startAgent(a.id, { branch: "ba" });
    await engine.desk.startAgent(b.id, { branch: "bb" });
    const again = await engine.desk.startAgent(a.id, { note: "also this" });
    expect(again.type).toBe("started");
    expect(fake.windows).toHaveLength(2);
  });

  test("working coding agents hold back chat turns Riker starts by itself", async () => {
    const [a, b] = ["A", "B"].map(codingTask);
    await engine.desk.startAgent(a.id, { branch: "ba" });
    await engine.desk.startAgent(b.id, { branch: "bb" });
    const chat = engine.desk.newTask("Look into it", Kind.general);
    expect(engine.pool.request(chat.id, "a reply came", "riker")).toBeNull();
    expect(store.getTask(chat.id)!.agent_state).toBe(AgentState.queued);
  });

  test("Stop takes back a queued Start", async () => {
    const [a, b, c] = ["A", "B", "C"].map(codingTask);
    await engine.desk.startAgent(a.id, { branch: "ba" });
    await engine.desk.startAgent(b.id, { branch: "bb" });
    await engine.desk.startAgent(c.id, { branch: "bc" });
    await engine.desk.stopAgent(c.id);
    expect(store.getTask(c.id)!.agent_state).toBe(AgentState.stopped);
    await engine.desk.stopAgent(a.id);
    engine.pool.drain();
    await Bun.sleep(0);
    expect(fake.windows).toHaveLength(1);
  });
});
