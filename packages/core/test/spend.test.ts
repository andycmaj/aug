import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAdvisor } from "../src/advisor";
import {
  AgentPool,
  CODING_BRIEF_TURNS,
  codingBrief,
  turnPrompt,
} from "../src/agents";
import { think, type BrainCall } from "../src/brain";
import { db, migrate } from "../src/db";
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
import { costBefore, sessionLogCost } from "../src/session-log";
import * as store from "../src/store";
import {
  AgentState,
  Kind,
  SessionKind,
  SpendRole,
  TurnRole,
  Verdict,
} from "../src/types";
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

// claude -p --resume restores the session's cost state, so each resumed
// call reports the session's whole total so far, as claude really does.
function runningTotals(turns: number[]): (call: BrainCall) => number {
  const totals = new Map<string, number>();
  let i = 0;
  return (call) => {
    const id = call.resume ?? call.sessionId ?? "";
    const before = call.resume ? (totals.get(id) ?? 0) : 0;
    const total = before + (turns[i++] ?? 0);
    if (!call.fork) {
      totals.set(id, total);
    }
    return total;
  };
}

function rowsOf(taskId: number): {
  cost_usd: number;
  session_id: string | null;
  session_total: number | null;
}[] {
  return db()
    .query(
      "SELECT cost_usd, session_id, session_total FROM spend WHERE task_id = ? ORDER BY id",
    )
    .all(taskId) as {
    cost_usd: number;
    session_id: string | null;
    session_total: number | null;
  }[];
}

// A Claude config dir of the test's own, with these sessions' logs: each a
// list of the cost-state totals claude wrote, between other lines.
const realConfigDir = process.env.CLAUDE_CONFIG_DIR;
function claudeLogs(logs: Record<string, number[]> = {}): void {
  const dir = mkdtempSync(join(tmpdir(), "claude-config-"));
  process.env.CLAUDE_CONFIG_DIR = dir;
  const project = join(dir, "projects", "-Users-me-repo");
  mkdirSync(project, { recursive: true });
  for (const [id, totals] of Object.entries(logs)) {
    const lines = totals.flatMap((total) => [
      JSON.stringify({ type: "user", timestamp: "2026-11-23T23:00:00Z" }),
      JSON.stringify({
        type: "cost-state",
        sessionId: id,
        totalCostUSD: total,
      }),
    ]);
    writeFileSync(join(project, `${id}.jsonl`), [...lines, ""].join("\n"));
  }
}

function restoreConfigDir(): void {
  if (realConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = realConfigDir;
  }
}

describe("a resumed session's turns", () => {
  beforeEach(() => {
    freshHome();
    claudeLogs();
  });
  afterEach(restoreConfigDir);

  test("each records the difference from the session's last total", async () => {
    fakeBrain(() => null, { costUsd: runningTotals([0.5, 0.3, 0.4]) });
    const tag = { role: SpendRole.assistant, taskId: 7 };
    await think({ prompt: "a", sessionId: "s1", spend: tag });
    await think({ prompt: "b", resume: "s1", spend: tag });
    await think({ prompt: "c", resume: "s1", spend: tag });
    const rows = rowsOf(7);
    expect(rows.map((r) => r.cost_usd)).toEqual([
      0.5,
      expect.closeTo(0.3),
      expect.closeTo(0.4),
    ]);
    expect(rows.map((r) => r.session_total)).toEqual([
      0.5,
      expect.closeTo(0.8),
      expect.closeTo(1.2),
    ]);
    expect(rows.every((r) => r.session_id === "s1")).toBe(true);
    expect(store.taskSpend(7).cost).toBeCloseTo(1.2);
  });

  test("Home's resumed turns cost what they added, so the cap holds off", async () => {
    const home = store.homeTask();
    fakeBrain(() => DONE, { costUsd: runningTotals([60, 0.4, 0.5]) });
    const pool = new AgentPool({ config: fixedConfig(capped(25)) });
    // A session that already cost $60 before today's turns (claude says so
    // on its first resume): the first turn is $60, the next two are small.
    for (const words of ["what is open?", "and now?", "thanks"]) {
      store.addTurn({
        taskId: home.id,
        role: TurnRole.you,
        author: "you",
        body: words,
      });
      await pool.request(home.id, "x", "owner");
    }
    const rows = rowsOf(home.id);
    expect(rows.map((r) => r.cost_usd)).toEqual([
      60,
      expect.closeTo(0.4),
      expect.closeTo(0.5),
    ]);
    expect(spentToday().cost).toBeCloseTo(60.9);
  });

  test("a general task's resumed turns too", async () => {
    const t = chatTask();
    fakeBrain(() => DONE, { costUsd: runningTotals([0.2, 0.05]) });
    const pool = new AgentPool({ config: fixedConfig(capped(100)) });
    await pool.request(t, "x", "owner");
    store.addTurn({
      taskId: t,
      role: TurnRole.you,
      author: "you",
      body: "and the renewals?",
    });
    await pool.request(t, "x", "owner");
    expect(rowsOf(t).map((r) => r.cost_usd)).toEqual([
      0.2,
      expect.closeTo(0.05),
    ]);
  });

  test("a total below the last one was not restored: it is the turn's own", async () => {
    let total = 0.9;
    fakeBrain(() => null, { costUsd: () => total });
    const tag = { role: SpendRole.general, taskId: 3 };
    await think({ prompt: "a", sessionId: "s1", spend: tag });
    total = 0.1;
    await think({ prompt: "b", resume: "s1", spend: tag });
    expect(rowsOf(3).map((r) => r.cost_usd)).toEqual([0.9, 0.1]);
  });

  test("a resume Riker never recorded reads the session log's last cost-state", async () => {
    claudeLogs({ "coding-1": [8.5, 9.14] });
    expect(sessionLogCost("coding-1")).toBe(9.14);
    expect(sessionLogCost("never-ran")).toBeNull();
    expect(costBefore("coding-1", 9.14)).toBe(8.5);
    expect(costBefore("coding-1", 8.5)).toBe(0);
    expect(costBefore("coding-1", 3)).toBeNull();
    // A task action on a fork of a coding agent's session: claude reports
    // the parent's $9.14 plus the fork's own turn.
    fakeBrain(() => null, { costUsd: 9.928 });
    const result = await think({
      prompt: "sum up",
      resume: "coding-1",
      fork: true,
      spend: { role: SpendRole.action, taskId: 4 },
    });
    expect(result.costUsd).toBe(9.928);
    const [row] = rowsOf(4);
    expect(row?.cost_usd).toBeCloseTo(0.788);
    // A fork is never resumed: no total to carry.
    expect(row?.session_id).toBeNull();
  });

  test("a resume with no total anywhere records what claude said", async () => {
    fakeBrain(() => null, { costUsd: 0.3 });
    await think({
      prompt: "b",
      resume: "unknown",
      spend: { role: SpendRole.general, taskId: 5 },
    });
    expect(rowsOf(5).map((r) => r.cost_usd)).toEqual([0.3]);
  });

  test("a one-shot call keeps no session", async () => {
    fakeBrain(() => null, { costUsd: 0.02 });
    await think({
      prompt: "triage",
      spend: { role: SpendRole.triage, taskId: 6 },
    });
    expect(rowsOf(6)).toEqual([
      { cost_usd: 0.02, session_id: null, session_total: null },
    ]);
  });
});

describe("spend rows from before sessions were kept", () => {
  beforeEach(() => {
    freshHome();
    // Home's first session began before spend kept rows: its log knows
    // what it cost before the first one.
    claudeLogs({ h1: [65.1, 67.3321, 68.08, 68.89, 69.93] });
  });
  afterEach(restoreConfigDir);

  // An old file: spend without its session columns, its chat rows holding
  // running totals.
  function oldSpend(): void {
    db().exec("DROP INDEX IF EXISTS spend_session");
    db().exec("ALTER TABLE spend DROP COLUMN session_total");
    db().exec("ALTER TABLE spend DROP COLUMN session_id");
  }

  function session(
    id: string,
    taskId: number,
    startedAt: string,
    kind: SessionKind = SessionKind.chat,
  ): void {
    db()
      .query(
        "INSERT INTO sessions (id, task_id, kind, cwd, state, started_at, last_event_at) VALUES (?, ?, ?, '/w', 'idle', ?, ?)",
      )
      .run(id, taskId, kind, startedAt, startedAt);
  }

  function row(taskId: number, role: string, cost: number, at: string): void {
    db()
      .query(
        "INSERT INTO spend (day, task_id, role, cost_usd, at) VALUES ('2026-11-18', ?, ?, ?, ?)",
      )
      .run(taskId, role, cost, at);
  }

  test("each chat row becomes the difference from the one before it in its session", () => {
    const home = store.homeTask().id;
    const t = chatTask();
    oldSpend();
    session("h1", home, "2026-11-18T01:00:00Z");
    session("h2", home, "2026-11-18T05:00:00Z");
    session("g1", t, "2026-11-18T02:00:00Z");
    // A tmux session on the same task is never a chat turn's.
    session("c1", t, "2026-11-18T02:30:00Z", SessionKind.tmux);
    row(home, "assistant", 68.08, "2026-11-18T01:00:10Z");
    row(home, "assistant", 68.89, "2026-11-18T01:10:00Z");
    row(home, "assistant", 69.93, "2026-11-18T01:20:00Z");
    // A new session whose first turn is over the last total is still its
    // own, and with no log it stays as it was.
    row(home, "assistant", 70.5, "2026-11-18T05:00:20Z");
    row(home, "assistant", 70.75, "2026-11-18T05:10:00Z");
    row(t, "general", 0.28, "2026-11-18T02:00:10Z");
    row(t, "general", 0.31, "2026-11-18T03:00:00Z");
    // Not a resumed role: left alone.
    row(t, "triage", 0.02, "2026-11-18T03:00:00Z");
    migrate(db());
    expect(rowsOf(home).map((r) => r.cost_usd)).toEqual([
      expect.closeTo(0.7479),
      expect.closeTo(0.81),
      expect.closeTo(1.04),
      70.5,
      expect.closeTo(0.25),
    ]);
    expect(rowsOf(home).map((r) => r.session_id)).toEqual([
      "h1",
      "h1",
      "h1",
      "h2",
      "h2",
    ]);
    expect(rowsOf(home).map((r) => r.session_total)).toEqual([
      68.08, 68.89, 69.93, 70.5, 70.75,
    ]);
    expect(rowsOf(t)).toEqual([
      { cost_usd: 0.28, session_id: "g1", session_total: 0.28 },
      { cost_usd: expect.closeTo(0.03), session_id: "g1", session_total: 0.31 },
      { cost_usd: 0.02, session_id: null, session_total: null },
    ]);
    // Once: a second start leaves the rows as they are.
    migrate(db());
    expect(rowsOf(home)[1]?.cost_usd).toBeCloseTo(0.81);
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
