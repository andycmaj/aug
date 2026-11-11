import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/core/config";
import { Engine } from "../src/core/engine";
import { setMux } from "../src/core/mux";
import * as store from "../src/core/store";
import { AgentState, Kind, TaskStatus } from "../src/core/types";
import { FakeMux } from "./fake-mux";
import { fakeBrain, freshHome } from "./helpers";

let engine: Engine;
let fake: FakeMux;

beforeEach(() => {
  freshHome({
    github: { ...DEFAULT_CONFIG.github, repos: { "acme/api": "/src/api" } },
  });
  fakeBrain(() => ({ about: "a", did: "b", next: "c", state: "done" }));
  fake = new FakeMux();
  setMux(fake);
  engine = new Engine();
});

const ref = (id: number) => store.taskRef(id);

describe("a coding task's driver", () => {
  test("asks for repo, then path, then branch, and starts once it has them", async () => {
    const task = engine.newTask("Add a flag", Kind.coding);
    const noRepo = await engine.startAgent(task.id);
    expect(noRepo).toEqual({
      type: "needs",
      need: { what: "repo", choices: ["acme/api"] },
    });

    engine.setTaskRepo(task.id, "acme/web");
    const noPath = await engine.startAgent(task.id);
    expect(noPath).toEqual({
      type: "needs",
      need: { what: "path", repo: "acme/web" },
    });

    engine.setTaskRepo(task.id, "acme/api");
    const noBranch = await engine.startAgent(task.id);
    expect(noBranch).toEqual({
      type: "needs",
      need: { what: "branch", suggested: "add-a-flag" },
    });

    const started = await engine.startAgent(task.id, { branch: "flag" });
    expect(started.type).toBe("started");
    expect(fake.worktrees[0].branch).toBe("flag");
    expect(store.getTask(task.id)!.agent_state).toBe(AgentState.working);
  });

  test("scratch skips every question; resuming never asks again", async () => {
    const task = engine.newTask("Try a thing", Kind.coding);
    expect((await engine.startAgent(task.id, { noWorktree: true })).type).toBe(
      "started",
    );
    await engine.stopAgent(task.id);
    expect(store.getTask(task.id)!.agent_state).toBe(AgentState.saved);
    expect(fake.windows).toHaveLength(0);
    expect((await engine.startAgent(task.id)).type).toBe("started");
    expect(fake.windows[0].argv).toContain("--resume");
  });

  test("the stop move ends a coding agent's window, not just the chat pool", async () => {
    const task = engine.newTask("Add a flag", Kind.coding, "", {
      repo: "acme/api",
    });
    await engine.startAgent(task.id, { branch: "flag" });
    expect(fake.windows).toHaveLength(1);
    const out = await engine.runMove("stop", { task: ref(task.id) });
    expect(out.ok).toBe(true);
    expect(fake.windows).toHaveLength(0);
    expect(store.getTask(task.id)!.agent_state).toBe(AgentState.saved);
  });

  test("close marks it done, then takes the window and worktree", async () => {
    const task = engine.newTask("Add a flag", Kind.coding, "", {
      repo: "acme/api",
    });
    await engine.startAgent(task.id, { branch: "flag" });
    const r = await engine.close(task.id);
    expect(r.archived).toBe(true);
    expect(fake.windows).toHaveLength(0);
    expect(fake.removed).toHaveLength(1);
    expect(store.getTask(task.id)!.status).toBe(TaskStatus.done);
  });

  test("a line typed while claude runs goes to its window; otherwise it waits", async () => {
    const task = engine.newTask("Add a flag", Kind.coding, "", {
      repo: "acme/api",
    });
    expect(await engine.say(task.id, "early")).toBe(false);
    expect(store.pendingTurns(task.id)).toHaveLength(1);
    await engine.startAgent(task.id, { branch: "flag" });
    expect(store.pendingTurns(task.id)).toHaveLength(0);
    expect(fake.windows[0].argv.at(-1)).toContain("early");
    expect(await engine.say(task.id, "later")).toBe(true);
    expect(fake.sent).toEqual([
      { windowId: fake.windows[0].id, text: "later" },
    ]);
  });
});

describe("a general task's driver", () => {
  test("start runs a turn with the note; Home has nothing to start", async () => {
    const task = engine.newTask("Think", Kind.general);
    const r = await engine.startAgent(task.id, { note: "go" });
    expect(r).toEqual({ type: "started", project: null });
    await Bun.sleep(10);
    expect(store.turnsForTask(task.id).map((t) => t.role)).toEqual([
      "you",
      "agent",
    ]);
    const home = await engine.startAgent(store.homeTask().id);
    expect(home.type).toBe("failed");
  });

  test("a typed line is heard at once, and stop cancels a queued start", async () => {
    const task = engine.newTask("Think", Kind.general);
    expect(await engine.say(task.id, "hello")).toBe(true);
    expect(store.pendingTurns(task.id)).toHaveLength(0);
    const held = engine.newTask("Held", Kind.coding);
    engine.setKind(held.id, Kind.general);
    expect(store.getTask(held.id)!.agent_state).toBe(AgentState.queued);
    await engine.stopAgent(held.id);
    expect(store.getTask(held.id)!.agent_state).toBe(AgentState.saved);
  });

  test("close stops the pool's turn and marks the task done", async () => {
    const task = engine.newTask("Think", Kind.general);
    await engine.startAgent(task.id);
    const r = await engine.close(task.id);
    expect(r).toEqual({ warnings: [], archived: false });
    expect(store.getTask(task.id)!.status).toBe(TaskStatus.done);
    expect(engine.isLive(store.getTask(task.id)!)).toBe(false);
  });
});
