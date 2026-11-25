import { beforeEach, describe, expect, test } from "bun:test";
import { AgentPool } from "../src/agents";
import { setBrain, type BrainCall } from "../src/brain";
import { homeModel, simpleAsk } from "../src/home-model";
import * as store from "../src/store";
import { DENIED_STEP } from "../src/capabilities";
import { Kind, TurnRole, type TurnRow } from "../src/types";
import { config, freshHome, withLimit } from "./support/helpers";

let calls: BrainCall[];

beforeEach(() => {
  freshHome();
  calls = [];
  setBrain(async (call) => {
    calls.push(call);
    return {
      text: "ok",
      structured: null,
      sessionId: call.sessionId ?? call.resume ?? null,
      durationMs: 1,
      isError: false,
      context: 20_000,
    };
  });
});

function said(...lines: string[]): TurnRow[] {
  const home = store.homeTask();
  for (const body of lines)
    store.addTurn({ taskId: home.id, role: TurnRole.you, author: "you", body });
  return store.turnsForTask(home.id);
}

function simpleOn() {
  const source = withLimit(4);
  source.update((c) => ({
    ...c,
    brain: { ...c.brain, assistantModel: "sonnet", assistantSimpleModel: "haiku" },
  }));
  return source;
}

describe("a simple Home ask", () => {
  test.each([
    "start RIKER-0012",
    "stop RIKER-12",
    "done @RIKER-0012",
    "Please stop the agent on RIKER-0012.",
    "mark RIKER-0012 done",
    "resume AUG-0040",
    "what is waiting?",
    "what's waiting on me",
    "What's running right now?",
    "status",
    "show RIKER-0012",
    "where is RIKER-0012 at?",
    "RIKER-0012",
    "make a task called Fix the flaky rail test",
    "new task: bump bun to 1.4",
  ])("%p is simple", (line) => {
    expect(simpleAsk(said(line))).toBe(true);
  });

  test.each([
    "plan the auth rewrite for me",
    "start RIKER-0012 and RIKER-0013",
    "done RIKER-0012, RIKER-0013",
    "why is RIKER-0012 stuck?",
    "make a task called write up the plan for the new rail",
    "start RIKER-0012 and tell it to look at the flaky test first",
    "what should I work on today?",
    "review RIKER-0012",
    "summarize what happened yesterday",
    `make a task called ${"x".repeat(120)}`,
    "start RIKER-0012\nand stop RIKER-0013",
    "",
  ])("%p is not", (line) => {
    expect(simpleAsk(said(line))).toBe(false);
  });

  test("naming a project is not simple", () => {
    store.createProject({ name: "aug-bootstrap", tmuxSession: "aug-bootstrap" });
    expect(simpleAsk(said("make a task called fix login @aug-bootstrap"))).toBe(false);
  });

  test("two lines since the last answer are not one move", () => {
    expect(simpleAsk(said("start RIKER-0012", "stop RIKER-0013"))).toBe(false);
  });

  test("a turn Riker started itself, with no owner line, is not", () => {
    expect(simpleAsk([])).toBe(false);
  });

  test("a turn after denied calls is not", () => {
    const home = store.homeTask();
    store.addTurn({ taskId: home.id, role: TurnRole.you, author: "you", body: "x" });
    const answer = store.addTurn({ taskId: home.id, role: TurnRole.agent, author: "riker", body: "could not" });
    store.updateTurn(answer.id, { steps: JSON.stringify([`${DENIED_STEP}Bash(rm -rf /)`]) });
    expect(simpleAsk(said("status"))).toBe(false);
  });
});

function simpleOff() {
  const source = withLimit(4);
  source.update((c) => ({ ...c, brain: { ...c.brain, assistantSimpleModel: "" } }));
  return source;
}

describe("homeModel", () => {
  test("on by default", () => {
    expect(homeModel(config(), said("status"), null).model).toBe("haiku");
  });

  test("off with assistantSimpleModel empty", () => {
    expect(homeModel(simpleOff().get(), said("status"), null)).toEqual({
      model: config().brain.assistantModel,
      leave: null,
      simple: false,
    });
  });
});

describe("Home's model per turn", () => {
  test("a simple turn on a new session runs on the simple model, and that session keeps it", async () => {
    const home = store.homeTask();
    const pool = new AgentPool({ config: simpleOn() });
    said("what is waiting?");
    await pool.request(home.id, "typed", "owner");
    expect(calls[0].model).toBe("haiku");
    expect(calls[0].resume).toBeUndefined();
    expect(store.getSession(calls[0].sessionId!)!.model).toBe("haiku");

    said("start RIKER-0001");
    await pool.request(home.id, "typed", "owner");
    expect(calls[1].model).toBe("haiku");
    expect(calls[1].resume).toBe(calls[0].sessionId);
  });

  test("a turn that needs the full model leaves a simple-model session for a new one that reads the talk back", async () => {
    const home = store.homeTask();
    const pool = new AgentPool({ config: simpleOn() });
    said("what is waiting?");
    await pool.request(home.id, "typed", "owner");
    said("plan the auth rewrite with me");
    await pool.request(home.id, "typed", "owner");
    expect(calls[1].model).toBe("sonnet");
    expect(calls[1].resume).toBeUndefined();
    expect(calls[1].sessionId).not.toBe(calls[0].sessionId);
    expect(calls[1].prompt).toContain("what is waiting?");
    expect(store.getSession(calls[1].sessionId!)!.model).toBe("sonnet");
  });

  test("a simple turn on a warm full-model session stays on it rather than re-write the cache", async () => {
    const home = store.homeTask();
    const pool = new AgentPool({ config: simpleOn() });
    said("plan the auth rewrite with me");
    await pool.request(home.id, "typed", "owner");
    said("status");
    await pool.request(home.id, "typed", "owner");
    expect(calls[1].model).toBe("sonnet");
    expect(calls[1].resume).toBe(calls[0].sessionId);
  });

  test("a simple turn that starts a new session anyway (idle) switches to the simple model", async () => {
    const home = store.homeTask();
    const pool = new AgentPool({ config: simpleOn() });
    said("plan the auth rewrite with me");
    await pool.request(home.id, "typed", "owner");
    const answer = store.turnsForTask(home.id).findLast((t) => t.role === TurnRole.agent)!;
    store.updateTurn(answer.id, {
      finished_at: new Date(Date.now() - 90 * 60_000).toISOString(),
    });
    said("status");
    await pool.request(home.id, "typed", "owner");
    expect(calls[1].resume).toBeUndefined();
    expect(calls[1].model).toBe("haiku");
  });

  test("with it off every Home turn is the full model", async () => {
    const home = store.homeTask();
    const pool = new AgentPool({ config: simpleOff() });
    said("status");
    await pool.request(home.id, "typed", "owner");
    expect(calls[0].model).toBe(config().brain.assistantModel);
    expect(store.getSession(calls[0].sessionId!)!.model).toBe(config().brain.assistantModel);
  });

  test("a task's turn is never routed: it runs on agentModel", async () => {
    const task = store.createTask({ title: "t", kind: Kind.general, channel: "owner" });
    store.addTurn({ taskId: task.id, role: TurnRole.you, author: "you", body: "status" });
    await new AgentPool({ config: simpleOn() }).request(task.id, "go", "owner");
    expect(calls[0].model).toBe(config().brain.agentModel);
  });

  test("a project manager's simple line stays on assistantModel: its moves carry judgment about the plan", async () => {
    const p = store.createProject({ name: "rail-polish", tmuxSession: "rail-polish" });
    const manager = store.ensureManager(p.id);
    store.addTurn({ taskId: manager.id, role: TurnRole.you, author: "you", body: "done RIKER-0001" });
    await new AgentPool({ config: simpleOn() }).request(manager.id, "typed", "owner");
    expect(calls[0].model).toBe("sonnet");
    expect(store.getSession(calls[0].sessionId!)!.model).toBe("sonnet");
  });

  test("a session from before models were kept counts as the full model", async () => {
    const home = store.homeTask();
    const pool = new AgentPool({ config: simpleOn() });
    said("plan the auth rewrite with me");
    await pool.request(home.id, "typed", "owner");
    store.updateSession(calls[0].sessionId!, { model: null });
    said("plan the next bit too");
    await pool.request(home.id, "typed", "owner");
    expect(calls[1].resume).toBe(calls[0].sessionId);
    expect(calls[1].model).toBe("sonnet");
  });
});
