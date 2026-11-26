// What Riker's own model calls cost, and the daily cap on them. Every headless
// call (think(), and the Slack reader's persistent session) records one row
// by local day, task and role; the cap (config.spend) holds back the turns
// Riker starts by itself once the day's total reaches it. The owner's own
// presses always run. Coding agents in tmux report no cost to Riker and are
// not counted.

import type { RikerConfig } from "./config";
import { logger } from "./log";
import { localDay } from "./rail";
import { sessionLogCost } from "./session-log";
import * as store from "./store";
import {
  SpendRole,
  type SpendByDay,
  type SpendByRole,
  type SpendByTask,
  type SpendTotal,
} from "./types";

const log = logger("spend");

export interface SpendTag {
  role: SpendRole;
  taskId?: number | null;
}

interface Costed {
  costUsd?: number;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

// A persisted session the call ran in, and the total claude reported for it
// (the cost recorded is then only this turn's part of that total).
export interface SessionCost {
  id: string;
  total: number;
}

// Never throws: a spend row lost to a locked database must not fail the
// call it paid for.
export function recordSpend(
  tag: SpendTag | undefined,
  model: string | null | undefined,
  result: Costed,
  at = new Date(),
  session?: SessionCost,
): void {
  if (result.costUsd === undefined && !result.usage) {
    return;
  }
  try {
    store.addSpend({
      day: localDay(at),
      taskId: tag?.taskId ?? null,
      role: tag?.role ?? SpendRole.other,
      model: model ?? null,
      costUsd: Math.max(0, result.costUsd ?? 0),
      input: result.usage?.input ?? 0,
      output: result.usage?.output ?? 0,
      cacheRead: result.usage?.cacheRead ?? 0,
      cacheWrite: result.usage?.cacheWrite ?? 0,
      sessionId: session?.id ?? null,
      sessionTotal: session?.total ?? null,
    });
  } catch (err) {
    log.error("spend not recorded", { role: tag?.role ?? null, err });
  }
}

// `claude -p --resume` (a fork too) restores the session's cost state, so
// the result's total_cost_usd is the session's whole life, not the turn.
// What it was before the turn: the total Riker last recorded for it, else
// the session log's own. Read before the call, which appends to that log.
export function priorSessionCost(sessionId: string): number | null {
  try {
    return store.lastSessionTotal(sessionId) ?? sessionLogCost(sessionId);
  } catch (err) {
    log.warn("prior session cost unread", { session: sessionId, err });
    return null;
  }
}

// The turn's part of a resumed session's total. A total below the one
// before means claude restored nothing: the whole total is the turn's.
export function turnCost(
  total: number | undefined,
  before: number | null,
): number | undefined {
  if (total === undefined || before === null || total < before) {
    return total;
  }
  return total - before;
}

export function spentToday(at = new Date()): SpendTotal {
  return store.spendOn(localDay(at));
}

// The cap in force, or null when it is off.
export function dailyCap(config: RikerConfig): number | null {
  return config.spend.capEnabled && config.spend.dailyUsd > 0
    ? config.spend.dailyUsd
    : null;
}

export function capReached(config: RikerConfig, at = new Date()): boolean {
  const cap = dailyCap(config);
  return cap !== null && spentToday(at).cost >= cap;
}

// The queue reason a held turn carries.
export function capReason(config: RikerConfig, at = new Date()): string {
  return `daily spend cap reached (${usd(spentToday(at).cost)} of ${usd(dailyCap(config) ?? 0)}); runs tomorrow or when you start it`;
}

export function usd(n: number): string {
  if (n > 0 && n < 0.01) {
    return "<$0.01";
  }
  return `$${n.toFixed(2)}`;
}

// A day `days` before `at`, for "the last week".
export function dayBefore(at: Date, days: number): string {
  const d = new Date(at);
  d.setDate(d.getDate() - days);
  return localDay(d);
}

export function tokens(n: number): string {
  if (n >= 1_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${Math.round(n / 1_000)}k`;
  }
  return String(n);
}

// The whole picture, for riker-tools spend and the Board's Cost tab.
export interface SpendReport {
  day: string;
  today: SpendTotal;
  cap: number | null;
  byRole: SpendByRole[];
  week: SpendByDay[];
  tasksToday: SpendByTask[];
  tasksWeek: SpendByTask[];
}

export function spendReport(config: RikerConfig, at = new Date()): SpendReport {
  const day = localDay(at);
  const weekStart = dayBefore(at, 6);
  return {
    day,
    today: store.spendOn(day),
    cap: dailyCap(config),
    byRole: store.spendByRole(day),
    week: store.spendByDay(weekStart),
    tasksToday: store.spendByTask(day),
    tasksWeek: store.spendByTask(weekStart),
  };
}

export function reportLines(report: SpendReport): string[] {
  const capLine =
    report.cap === null
      ? "no daily cap (spend.capEnabled is off)"
      : `cap ${usd(report.cap)}/day${report.today.cost >= report.cap ? " - REACHED: turns Riker starts by itself wait" : ""}`;
  const task = (t: SpendByTask) =>
    `  ${store.taskRef(t.task_id).padEnd(9)} ${usd(t.cost).padStart(8)}  ${String(t.calls).padStart(4)} calls  ${store.getTask(t.task_id)?.title ?? "(gone)"}`;
  return [
    `Today (${report.day}): ${usd(report.today.cost)} over ${report.today.calls} calls, ${tokens(report.today.tokens)} tokens; ${capLine}`,
    "",
    "By role today:",
    ...(report.byRole.length
      ? report.byRole.map(
          (r) =>
            `  ${r.role.padEnd(10)} ${usd(r.cost).padStart(8)}  ${String(r.calls).padStart(4)} calls  ${tokens(r.tokens)} tokens`,
        )
      : ["  (nothing yet)"]),
    "",
    "Tasks today:",
    ...(report.tasksToday.length ? report.tasksToday.map(task) : ["  (none)"]),
    "",
    "Last 7 days:",
    ...(report.week.length
      ? report.week.map(
          (d) =>
            `  ${d.day} ${usd(d.cost).padStart(8)}  ${String(d.calls).padStart(4)} calls`,
        )
      : ["  (nothing yet)"]),
    "",
    "Tasks this week:",
    ...(report.tasksWeek.length ? report.tasksWeek.map(task) : ["  (none)"]),
    "",
    "Coding agents in tmux are not counted: their cost shows in their own Claude Code status line.",
  ];
}
