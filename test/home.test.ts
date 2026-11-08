import { beforeEach, describe, expect, test } from "bun:test";
import { setBrain, type BrainCall } from "../src/core/brain";
import { AgentPool } from "../src/core/agents";
import { buildRail } from "../src/core/rail";
import * as store from "../src/core/store";
import { Kind, TurnRole } from "../src/core/types";
import { freshHome } from "./helpers";

let calls: BrainCall[];

beforeEach(() => {
  freshHome();
  calls = [];
  setBrain(async (call) => {
    calls.push(call);
    return {
      text: "Made AUG-0002 in aug-mvp.",
      structured: null,
      sessionId: call.sessionId ?? call.resume ?? null,
      durationMs: 1,
      isError: false,
    };
  });
});

function say(taskId: number, body: string) {
  store.addTurn({ taskId, role: TurnRole.you, author: "you", body });
}

describe("Home", () => {
  test("is made once, and nothing that lists work sees it", () => {
    const home = store.homeTask();
    expect(store.homeTask().id).toBe(home.id);
    expect(home.kind).toBe(Kind.home);
    store.createTask({ title: "real work", kind: Kind.general, channel: "owner" });
    expect(store.listTasks().map((t) => t.title)).toEqual(["real work"]);
  });

  test("sits first on the rail, in a section of its own", () => {
    const home = store.homeTask();
    const work = store.createTask({ title: "w", kind: Kind.general, channel: "owner" });
    const rail = buildRail({
      home,
      tasks: [work],
      pendingActions: new Set(),
      ideas: [],
      fyi: [],
      lastHeard: new Map(),
      now: new Date(),
    });
    expect(rail.map((s) => s.section)).toEqual(["home", "tasks"]);
  });

  test("a turn is the Assistant: aug-tools only, who is asking, the named task read in", async () => {
    const home = store.homeTask();
    const job = store.createTask({
      title: "JOB.md is empty",
      summary: "Fill it in",
      kind: Kind.general,
      channel: "owner",
    });
    say(home.id, `make a coding task for @${store.taskRef(job.id)} in aug-mvp`);
    await new AgentPool({ limit: () => 4 }).request(home.id, "the owner typed", "owner");

    const call = calls[0];
    expect(call.tools).toContain("Bash");
    expect(call.allow!.filter((a) => a.startsWith("Bash("))).toHaveLength(1);
    expect(call.allow![0]).toContain("aug-tools.ts");
    expect(call.env).toEqual({ AUG_ASKED_BY: "assistant" });
    expect(call.schema).toBeUndefined();
    expect(call.system).toContain("move new");
    expect(call.prompt).toContain("## Tasks the owner named");
    expect(call.prompt).toContain("Summary: Fill it in");
    expect(call.prompt).toContain("make a coding task for @AUG-0002");

    const answer = store.turnsForTask(home.id).at(-1)!;
    expect(answer).toMatchObject({
      role: TurnRole.agent,
      author: "aug",
      did: "Made AUG-0002 in aug-mvp.",
    });
  });

  test("a resumed turn sends only what the owner said since the last answer", async () => {
    const home = store.homeTask();
    const pool = new AgentPool({ limit: () => 4 });
    say(home.id, "first question");
    await pool.request(home.id, "typed", "owner");
    say(home.id, "second question");
    await pool.request(home.id, "typed", "owner");
    expect(calls[1].resume).toBe(calls[0].sessionId);
    expect(calls[1].prompt).toContain("second question");
    expect(calls[1].prompt).not.toContain("first question");
  });

  test("Start on Home does nothing: the Assistant answers only what you say", async () => {
    const { Engine } = await import("../src/core/engine");
    const home = store.homeTask();
    new Engine().startGeneral(home.id);
    await Bun.sleep(10);
    expect(calls).toHaveLength(0);
    expect(store.turnsForTask(home.id)).toHaveLength(0);
  });

  test("a general agent's tools know which task is asking", async () => {
    const task = store.createTask({ title: "t", kind: Kind.general, channel: "owner" });
    await new AgentPool({ limit: () => 4 }).request(task.id, "go", "owner");
    expect(calls[0].env).toEqual({ AUG_TASK_ID: String(task.id) });
  });
});

test("a general agent may run aug's lookups and the agent moves, nothing else", async () => {
  const { generalAllow } = await import("../src/core/agents");
  const bash = generalAllow().filter((r) => r.includes("aug-tools.ts"));
  expect(bash.some((r) => r.endsWith("aug-tools.ts move new:*)"))).toBe(true);
  expect(bash.some((r) => r.endsWith("aug-tools.ts projects:*)"))).toBe(true);
  expect(bash.some((r) => r.includes("move done") || r.includes("move start"))).toBe(false);
});
