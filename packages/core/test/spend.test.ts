import { beforeEach, describe, expect, test } from "bun:test";
import { runAdvisor } from "../src/advisor";
import {
  AgentPool,
  CODING_BRIEF_TURNS,
  codingBrief,
  turnPrompt,
} from "../src/agents";
import { think } from "../src/brain";
import { fixedConfig, type RikerConfig } from "../src/config";
import { runDocPass } from "../src/doc-pass";
import { localDay } from "../src/rail";
import {
  capReached,
  dailyCap,
  recordSpend,
  reportLines,
  spendReport,
  spentToday,
} from "../src/spend";
import * as store from "../src/store";
import { AgentState, Kind, SpendRole, TurnRole, Verdict } from "../src/types";
import { config, fakeBrain, freshHome } from "./support/helpers";

const DONE = { about: "a", did: "b", next: "c", state: "done" };

function capped(dailyUsd: number, capEnabled = true): RikerConfig {
  return { ...config(), maxActiveAgents: 4, spend: { capEnabled, dailyUsd } };
}

function spendRows(): {
  role: string;
  task_id: number | null;
  cost_usd: number;
}[] {
  return store.spendByRole(localDay(new Date())).flatMap((r) =>
    Array.from({ length: r.calls }, () => ({
      role: r.role,
      task_id: null,
      cost_usd: r.cost / r.calls,
    })),
  );
}

function chatTask(title = "seat count"): number {
  const t = store.createTask({ title, kind: Kind.general, channel: "owner" });
  store.addTurn({
    taskId: t.id,
    role: TurnRole.you,
    author: "you",
    body: `ask about ${title}`,
  });
  return t.id;
}

describe("recording spend", () => {
  beforeEach(() => freshHome());

  test("think records what a call cost under its role and task", async () => {
    fakeBrain(() => null, { costUsd: 0.25 });
    await think({
      prompt: "hi",
      model: "haiku",
      spend: { role: SpendRole.general, taskId: 7 },
    });
    await think({ prompt: "hi" });
    const today = spentToday();
    expect(today.calls).toBe(2);
    expect(today.cost).toBeCloseTo(0.5);
    expect(today.tokens).toBe(230);
    expect(store.taskSpend(7)).toMatchObject({ calls: 1, cost: 0.25 });
    expect(
      spendRows()
        .map((r) => r.role)
        .sort(),
    ).toEqual(["general", "other"]);
  });

  test("a call that reports no cost leaves no row", async () => {
    fakeBrain(() => null);
    await think({ prompt: "hi", spend: { role: SpendRole.triage } });
    expect(spentToday().calls).toBe(0);
  });

  test("each caller tags its role: a general turn, Home, the Advisor, the doc pass", async () => {
    const general = chatTask();
    const home = store.homeTask();
    store.addTurn({
      taskId: home.id,
      role: TurnRole.you,
      author: "you",
      body: "what is open?",
    });
    fakeBrain(
      (call) =>
        call.schema && "verdict" in (call.schema.properties ?? {})
          ? {
              verdict: Verdict.fyi,
              reason: "x",
              title: "x",
              summary: "x",
              priority: "regular",
            }
          : call.schema && "ideas" in (call.schema.properties ?? {})
            ? { ideas: [] }
            : call.schema && "edits" in (call.schema.properties ?? {})
              ? { edits: [], ideas: [] }
              : DONE,
      { costUsd: 0.1 },
    );
    const pool = new AgentPool({ config: fixedConfig(capped(100)) });
    await pool.request(general, "x", "owner");
    await pool.request(home.id, "x", "owner");
    await runAdvisor(config(), new Date(), true);
    await runDocPass(config(), new Date(), true);
    expect(store.taskSpend(general)).toMatchObject({ calls: 1 });
    expect(store.taskSpend(home.id)).toMatchObject({ calls: 1 });
    expect(
      spendRows()
        .map((r) => r.role)
        .sort(),
    ).toEqual(["advisor", "assistant", "doc-pass", "general"].sort());
  });

  test("the report says today, by role and task, the week, and the cap", () => {
    const t = chatTask("renewals");
    recordSpend({ role: SpendRole.general, taskId: t }, "sonnet", {
      costUsd: 1.5,
    });
    recordSpend({ role: SpendRole.triage }, "haiku", { costUsd: 0.02 });
    const yesterday = new Date(Date.now() - 86400_000);
    recordSpend(
      { role: SpendRole.general, taskId: t },
      "sonnet",
      { costUsd: 3 },
      yesterday,
    );
    const report = spendReport(capped(10));
    expect(report.today.cost).toBeCloseTo(1.52);
    expect(report.byRole.map((r) => r.role)).toEqual(["general", "triage"]);
    expect(report.week).toHaveLength(2);
    expect(report.tasksWeek[0]).toMatchObject({ task_id: t, calls: 2 });
    const text = reportLines(report).join("\n");
    expect(text).toContain("$1.52 over 2 calls");
    expect(text).toContain("cap $10.00/day");
    expect(text).toContain(store.taskRef(t));
    expect(reportLines(spendReport(capped(10, false))).join("\n")).toContain(
      "no daily cap",
    );
  });
});

describe("the daily cap", () => {
  beforeEach(() => freshHome());

  test("is off when disabled or zero", () => {
    recordSpend({ role: SpendRole.general }, null, { costUsd: 50 });
    expect(dailyCap(capped(10, false))).toBeNull();
    expect(capReached(capped(10, false))).toBe(false);
    expect(dailyCap(capped(0))).toBeNull();
    expect(capReached(capped(10))).toBe(true);
    expect(capReached(capped(60))).toBe(false);
  });

  test("once reached, turns Riker starts wait with the reason; the owner's still run", async () => {
    const [mine, augs] = [chatTask("mine"), chatTask("augs")];
    const calls = fakeBrain(() => DONE);
    recordSpend({ role: SpendRole.general }, null, { costUsd: 2 });
    const source = fixedConfig(capped(1));
    const pool = new AgentPool({ config: source });
    expect(pool.request(augs, "autostart", "riker")).toBeNull();
    const held = store.getTask(augs)!;
    expect(held.agent_state).toBe(AgentState.queued);
    expect(held.queue_reason).toContain(
      "daily spend cap reached ($2.00 of $1.00)",
    );
    await pool.request(mine, "the owner typed", "owner");
    expect(calls).toHaveLength(1);
    // Still capped: draining leaves it waiting.
    pool.drain();
    expect(pool.isWaiting(augs)).toBe(true);
    // Raised (or the day turns): the next drain runs it.
    source.update((c) => ({ ...c, spend: { capEnabled: true, dailyUsd: 5 } }));
    pool.drain();
    expect(pool.isWaiting(augs)).toBe(false);
    expect(pool.isRunning(augs)).toBe(true);
  });

  test("with the cap off, Riker's turns run past any spend", async () => {
    const t = chatTask();
    fakeBrain(() => DONE);
    recordSpend({ role: SpendRole.general }, null, { costUsd: 500 });
    const pool = new AgentPool({ config: fixedConfig(capped(1, false)) });
    expect(pool.request(t, "autostart", "riker")).not.toBeNull();
  });

  test("the owner's coding Start still goes when the cap holds chat turns", async () => {
    const [chat, coding] = [chatTask("chat"), chatTask("coding")];
    fakeBrain(() => DONE);
    recordSpend({ role: SpendRole.general }, null, { costUsd: 2 });
    const pool = new AgentPool({
      config: fixedConfig({ ...capped(1), maxActiveAgents: 1 }),
    });
    expect(pool.request(chat, "autostart", "riker")).toBeNull();
    let release: () => void = () => {};
    const blocker = pool.claim(
      9999,
      () => new Promise<void>((r) => (release = r)),
    );
    let started = false;
    expect(pool.claim(coding, async () => void (started = true))).toBeNull();
    release();
    await blocker;
    expect(started).toBe(true);
    expect(pool.isWaiting(chat)).toBe(true);
  });

  test("the Advisor and the doc pass skip their model call while capped", async () => {
    const calls = fakeBrain(() => ({ ideas: [], edits: [] }));
    recordSpend({ role: SpendRole.general }, null, { costUsd: 2 });
    expect(await runAdvisor(capped(1))).toEqual({
      added: 0,
      skipped: "daily spend cap reached",
    });
    expect((await runDocPass(capped(1), new Date())).skipped).toBe(
      "daily spend cap reached",
    );
    expect(calls).toHaveLength(0);
    // Not marked run: it asks once the cap lifts.
    expect(store.kvGet("advisor.lastRun")).toBeNull();
  });
});

describe("what a turn re-sends", () => {
  beforeEach(() => freshHome());

  test("a resumed general turn sends only what came since its last answer", async () => {
    const t = chatTask();
    const calls = fakeBrain(() => DONE);
    const pool = new AgentPool({ config: fixedConfig(capped(100)) });
    await pool.request(t, "first", "owner");
    store.addTurn({
      taskId: t,
      role: TurnRole.you,
      author: "you",
      body: "and the renewal date?",
    });
    await pool.request(t, "second", "owner");
    expect(calls[1].resume).toBe(calls[0].sessionId);
    expect(calls[0].prompt).toContain("ask about seat count");
    expect(calls[1].prompt).not.toContain("ask about seat count");
    expect(calls[1].prompt).toContain("and the renewal date?");
    expect(calls[1].prompt).toContain(`Task ${store.taskRef(t)}: seat count`);
    expect(calls[1].prompt).toContain("New since your last answer");
  });

  test("a turn that failed is no proof the session heard what came before it", () => {
    const t = chatTask();
    const turn = store.addTurn({
      taskId: t,
      role: TurnRole.agent,
      author: "agent",
      status: "failed",
      body: "x",
    });
    store.addTurn({
      taskId: t,
      role: TurnRole.you,
      author: "you",
      body: "again",
    });
    const prompt = turnPrompt(
      store.getTask(t)!,
      store.turnsForTask(t),
      "x",
      true,
    );
    expect(turn.status).toBe("failed");
    expect(prompt).toContain("ask about seat count");
    expect(prompt).toContain("again");
  });

  test("a fresh session reads the whole conversation back", () => {
    const t = chatTask();
    store.addTurn({
      taskId: t,
      role: TurnRole.agent,
      author: "agent",
      status: "done",
      body: "42",
    });
    store.addTurn({
      taskId: t,
      role: TurnRole.you,
      author: "you",
      body: "thanks",
    });
    const prompt = turnPrompt(
      store.getTask(t)!,
      store.turnsForTask(t),
      "x",
      false,
    );
    expect(prompt).toContain("The conversation so far");
    expect(prompt).toContain("ask about seat count");
  });

  test("the coding brief keeps only the latest turns", () => {
    const t = store.createTask({
      title: "fix it",
      kind: Kind.coding,
      channel: "owner",
    });
    for (let i = 0; i < CODING_BRIEF_TURNS + 5; i++) {
      store.addTurn({
        taskId: t.id,
        role: TurnRole.you,
        author: "you",
        body: `note number ${i}.`,
      });
    }
    const brief = codingBrief(config(), store.getTask(t.id)!);
    expect(brief).not.toContain("note number 4.");
    expect(brief).toContain("note number 5.");
    expect(brief).toContain(`note number ${CODING_BRIEF_TURNS + 4}.`);
    expect(brief).toContain("5 earlier turns left out");
  });
});

describe("the Advisor's clock", () => {
  beforeEach(() => freshHome());

  test("asks the model only when the work picture changed, unless forced", async () => {
    const calls = fakeBrain(() => ({ ideas: [] }));
    chatTask("one");
    const cfg = capped(100);
    expect(await runAdvisor(cfg)).toEqual({ added: 0 });
    expect(await runAdvisor(cfg)).toEqual({
      added: 0,
      skipped: "work unchanged",
    });
    expect(calls).toHaveLength(1);
    await runAdvisor(cfg, new Date(), true);
    expect(calls).toHaveLength(2);
    chatTask("two");
    await runAdvisor(cfg);
    expect(calls).toHaveLength(3);
  });
});
