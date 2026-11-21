import { beforeEach, describe, expect, test } from "bun:test";
import { setBrain, type BrainCall } from "../src/brain";
import { AgentPool } from "../src/agents";
import { buildRail } from "../src/rail";
import * as store from "../src/store";
import { Kind, TurnRole } from "../src/types";
import { freshHome, withLimit, testConfig, config } from "./support/helpers";

let calls: BrainCall[];

beforeEach(() => {
  freshHome();
  calls = [];
  setBrain(async (call) => {
    calls.push(call);
    return {
      text: "Made RIKER-0002 in riker-mvp.",
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
      lastHeard: new Map(),
      now: new Date(),
    });
    expect(rail.map((s) => s.section)).toEqual(["home", "tasks"]);
  });

  test("a turn is the Assistant: riker-tools and gh reads, who is asking, the named task read in", async () => {
    const home = store.homeTask();
    const job = store.createTask({
      title: "JOB.md is empty",
      summary: "Fill it in",
      kind: Kind.general,
      channel: "owner",
    });
    say(home.id, `make a coding task for @${store.taskRef(job.id)} in riker-mvp`);
    await new AgentPool({ config: withLimit(4) }).request(home.id, "the owner typed", "owner");

    const call = calls[0];
    expect(call.tools).toContain("Bash");
    const shell = call.allow!.filter((a) => a.startsWith("Bash(") && !a.startsWith("Bash(gh "));
    expect(shell).toHaveLength(3);
    expect(shell).toContain("Bash(riker-tools:*)");
    expect(shell.some((a) => a.startsWith("Bash(bun /") && a.endsWith("riker-tools.ts:*)"))).toBe(true);
    expect(call.env).toMatchObject({ RIKER_ASKED_BY: "assistant" });
    expect(call.env!.PATH).toStartWith(`${process.env.RIKER_HOME}/bin:`);
    expect(call.schema).toBeUndefined();
    expect(call.system).toContain("move new");
    expect(call.prompt).toContain("## Tasks the owner named");
    expect(call.prompt).toContain("Summary: Fill it in");
    expect(call.prompt).toContain("make a coding task for @RIKER-0002");

    const answer = store.turnsForTask(home.id).at(-1)!;
    expect(answer).toMatchObject({
      role: TurnRole.agent,
      author: "riker",
      did: "Made RIKER-0002 in riker-mvp.",
    });
  });

  test("a resumed turn sends only what the owner said since the last answer", async () => {
    const home = store.homeTask();
    const pool = new AgentPool({ config: withLimit(4) });
    say(home.id, "first question");
    await pool.request(home.id, "typed", "owner");
    say(home.id, "second question");
    await pool.request(home.id, "typed", "owner");
    expect(calls[1].resume).toBe(calls[0].sessionId);
    expect(calls[1].prompt).toContain("second question");
    expect(calls[1].prompt).not.toContain("first question");
  });

  test("Start on Home does nothing: the Assistant answers only what you say", async () => {
    const { Engine } = await import("../src/engine");
    const home = store.homeTask();
    void new Engine({ config: testConfig() }).desk.startAgent(home.id);
    await Bun.sleep(10);
    expect(calls).toHaveLength(0);
    expect(store.turnsForTask(home.id)).toHaveLength(0);
  });

  test("a general agent's tools know which task is asking", async () => {
    const task = store.createTask({ title: "t", kind: Kind.general, channel: "owner" });
    await new AgentPool({ config: withLimit(4) }).request(task.id, "go", "owner");
    expect(calls[0].env).toMatchObject({ RIKER_TASK_ID: String(task.id) });
    expect(calls[0].env!.PATH).toStartWith(`${process.env.RIKER_HOME}/bin:`);
  });
});

test("a general agent may run Riker's lookups and the agent moves, nothing else", async () => {
  const { generalAllow } = await import("../src/agents");
  const bash = generalAllow(config()).filter((r) => r.includes("riker-tools.ts"));
  expect(bash.some((r) => r.endsWith("riker-tools.ts move new:*)"))).toBe(true);
  expect(bash.some((r) => r.endsWith("riker-tools.ts projects:*)"))).toBe(true);
  expect(bash.some((r) => r.endsWith("riker-tools.ts move project_new:*)"))).toBe(true);
  expect(
    bash.some((r) => ["move done", "move start", "move project_archive"].some((m) => r.includes(m))),
  ).toBe(false);
});

test("a general agent's riker-tools rules match the bun path written either way", async () => {
  const { generalAllow } = await import("../src/agents");
  const { toolsCommand, toolsEntry } = await import("../src/self");
  const allow = generalAllow(config());
  expect(allow).toContain("Bash(riker-tools move project:*)");
  expect(allow).toContain(`Bash(${toolsCommand("move", "project")}:*)`);
  expect(allow).toContain(`Bash(bun ${toolsEntry()} move project:*)`);
});

test("riker-tools on a headless agent's PATH runs riker-tools", async () => {
  const { toolsEnv } = await import("../src/self");
  const run = Bun.spawnSync(["riker-tools", "projects"], { env: { ...process.env, ...toolsEnv() } });
  expect(run.exitCode).toBe(0);
  expect(run.stdout.toString()).toContain("no projects");
});

test("a general agent is told it has gh and how to write shell commands that are allowed", async () => {
  const { turnSystem } = await import("../src/agents");
  const { SHELL_HOWTO } = await import("../src/capabilities");
  const system = turnSystem(config());
  expect(system).toContain("gh pr view");
  expect(system).toContain(SHELL_HOWTO);
});

test("a denied call is kept on the turn, and the next turn is told not to repeat it", async () => {
  const denied = 'Bash B=/bin/bun; $B riker-tools.ts move link RIKER-0001 "u"';
  setBrain(async (call) => {
    calls.push(call);
    return {
      text: "",
      structured: { about: "a", did: "d", next: "n", state: "done" },
      sessionId: call.sessionId ?? call.resume ?? null,
      durationMs: 1,
      isError: false,
      denied: calls.length === 1 ? [denied] : [],
    };
  });
  const task = store.createTask({ title: "t", kind: Kind.general, channel: "owner" });
  const pool = new AgentPool({ config: withLimit(4) });
  await pool.request(task.id, "go", "owner");
  await Bun.sleep(10);
  const first = store.turnsForTask(task.id).findLast((t) => t.role === TurnRole.agent)!;
  expect(JSON.parse(first.steps)).toContain(`denied: ${denied}`);

  await pool.request(task.id, "again", "owner");
  await Bun.sleep(10);
  expect(calls[1].prompt).toContain(`- ${denied}`);
  expect(calls[1].prompt).toContain("riker-tools <command>");
  // The denied session is left behind for a new one, which is then resumed.
  expect(calls[1].resume).toBeUndefined();
  expect(calls[1].sessionId).not.toBe(calls[0].sessionId);
  await pool.request(task.id, "once more", "owner");
  await Bun.sleep(10);
  expect(calls[2].resume).toBe(calls[1].sessionId);
});

test("a denied Docs call says on the turn what to grant, and the next turn is told it", async () => {
  const denied = 'mcp__claude_ai_Claude_Docs__batch {"container":{"kind":"project"}}';
  setBrain(async (call) => {
    calls.push(call);
    return {
      text: "",
      structured: { about: "a", did: "d", next: "n", state: "done" },
      sessionId: call.sessionId ?? call.resume ?? null,
      durationMs: 1,
      isError: false,
      denied: calls.length === 1 ? [denied] : [],
    };
  });
  const task = store.createTask({ title: "t", kind: Kind.general, channel: "owner" });
  const pool = new AgentPool({ config: withLimit(4) });
  await pool.request(task.id, "go", "owner");
  await Bun.sleep(10);
  const first = store.turnsForTask(task.id).findLast((t) => t.role === TurnRole.agent)!;
  const { paths } = await import("../src/paths");
  const grant = `grant: mcp__claude_ai_Claude_Docs__batch: add "docs.write" to capabilities.grants.general in ${paths.config()}.`;
  expect(JSON.parse(first.steps)).toEqual([`denied: ${denied}`, grant]);

  await pool.request(task.id, "how do I enable it", "owner");
  await Bun.sleep(10);
  expect(calls[1].prompt).toContain('add "docs.write" to capabilities.grants.general');
  expect(calls[1].system).toContain("capabilities.grants.general");
});

test("a doc a headless agent makes is linked to its task; Home links nothing by itself", async () => {
  const url = "https://claude.ai/artifact/doc123";
  setBrain(async (call) => {
    calls.push(call);
    call.onTool?.({
      name: "mcp__claude_ai_Claude_Docs__batch",
      input: { container: { kind: "project", create: { name: "Devex 2027" } } },
      response: [{ type: "text", text: `created ${url}` }],
    });
    call.onTool?.({
      name: "mcp__claude_ai_Claude_Docs__read",
      input: {},
      response: "https://claude.ai/artifact/other",
    });
    return {
      text: "",
      structured: { about: "a", did: "d", next: "n", state: "done" },
      sessionId: call.sessionId ?? null,
      durationMs: 1,
      isError: false,
    };
  });
  const task = store.createTask({ title: "t", kind: Kind.general, channel: "owner" });
  const pool = new AgentPool({ config: withLimit(4) });
  await pool.request(task.id, "put it in a doc", "owner");
  await Bun.sleep(10);
  expect(store.linksForTask(task.id).map((l) => [l.url, l.title])).toEqual([
    [url, "Devex 2027"],
  ]);
  const home = store.homeTask();
  await pool.request(home.id, "make a doc", "owner");
  await Bun.sleep(10);
  expect(calls.at(-1)?.onTool).toBeUndefined();
});

describe("a chat turn leaves a session the cache has lost, or Home's grown too big", () => {
  function contextBrain(context: number) {
    setBrain(async (call) => {
      calls.push(call);
      return {
        text: "ok",
        structured: null,
        sessionId: call.sessionId ?? call.resume ?? null,
        durationMs: 1,
        isError: false,
        context,
      };
    });
  }

  // The last answer, as though it finished this many minutes ago.
  function lastAnswerAgo(taskId: number, minutes: number) {
    const answer = store.turnsForTask(taskId).findLast((t) => t.role === TurnRole.agent)!;
    store.updateTurn(answer.id, {
      finished_at: new Date(Date.now() - minutes * 60_000).toISOString(),
    });
  }

  test("Home idle past the cache's hour starts a new session that reads the talk back", async () => {
    const home = store.homeTask();
    const pool = new AgentPool({ config: withLimit(4) });
    say(home.id, "first question");
    await pool.request(home.id, "typed", "owner");
    lastAnswerAgo(home.id, 90);
    say(home.id, "second question");
    await pool.request(home.id, "typed", "owner");
    expect(calls[1].resume).toBeUndefined();
    expect(calls[1].sessionId).not.toBe(calls[0].sessionId);
    expect(calls[1].prompt).toContain("first question");
    expect(calls[1].prompt).toContain("second question");
    // The new session is the one the next warm turn resumes.
    say(home.id, "third question");
    await pool.request(home.id, "typed", "owner");
    expect(calls[2].resume).toBe(calls[1].sessionId);
  });

  test("Home within the hour and under the size resumes", async () => {
    contextBrain(20_000);
    const home = store.homeTask();
    const pool = new AgentPool({ config: withLimit(4) });
    say(home.id, "first question");
    await pool.request(home.id, "typed", "owner");
    lastAnswerAgo(home.id, 30);
    say(home.id, "second question");
    await pool.request(home.id, "typed", "owner");
    expect(calls[1].resume).toBe(calls[0].sessionId);
  });

  test("Home past homeMaxTokens of context starts a new session", async () => {
    contextBrain(70_000);
    const home = store.homeTask();
    const pool = new AgentPool({ config: withLimit(4) });
    say(home.id, "first question");
    await pool.request(home.id, "typed", "owner");
    expect(store.getSession(calls[0].sessionId!)!.context_tokens).toBe(70_000);
    say(home.id, "second question");
    await pool.request(home.id, "typed", "owner");
    expect(calls[1].resume).toBeUndefined();
    expect(calls[1].prompt).toContain("first question");
  });

  test("0 turns either bound off", async () => {
    contextBrain(70_000);
    const off = withLimit(4);
    off.update((c) => ({ ...c, chat: { idleMinutes: 0, homeMaxTokens: 0 } }));
    const home = store.homeTask();
    const pool = new AgentPool({ config: off });
    say(home.id, "first question");
    await pool.request(home.id, "typed", "owner");
    lastAnswerAgo(home.id, 600);
    say(home.id, "second question");
    await pool.request(home.id, "typed", "owner");
    expect(calls[1].resume).toBe(calls[0].sessionId);
  });

  test("a task's Q/A leaves an idle session but not a big one", async () => {
    contextBrain(200_000);
    const task = store.createTask({ title: "t", kind: Kind.general, channel: "owner" });
    const pool = new AgentPool({ config: withLimit(4) });
    say(task.id, "look into it");
    await pool.request(task.id, "go", "owner");
    say(task.id, "and then?");
    await pool.request(task.id, "go", "owner");
    expect(calls[1].resume).toBe(calls[0].sessionId);
    lastAnswerAgo(task.id, 90);
    say(task.id, "back again");
    await pool.request(task.id, "go", "owner");
    expect(calls[2].resume).toBeUndefined();
    expect(calls[2].prompt).toContain("look into it");
  });
});
