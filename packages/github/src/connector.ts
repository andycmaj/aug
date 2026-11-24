// GitHub as a connector: notifications into the inbox and each task's PR
// status into pr_status, on one clock, behind the gate (gate.ts) that keeps
// Riker inside GitHub's budgets.

import type { Connector, ConnectorContext, ConnectorState } from "@riker/core/plugins";
import { now } from "@riker/core/db";
import { errorMessage, logger } from "@riker/core/log";
import { taskPr } from "@riker/core/pr";
import * as store from "@riker/core/store";
import { PrState, type TaskRow } from "@riker/core/types";
import {
  clockTime,
  GhBudget,
  ghTrouble,
  GhTrouble,
  GithubGate,
  GRAPHQL_RESERVE,
  limitedUntil,
  PauseWhy,
  type GateClock,
  type GhRateLimit,
  type Pause,
} from "./gate";
import { githubConfig } from "./config";
import { ghApi, pollGithub, type GhApi } from "./ingest";
import {
  ghPrBatch,
  refreshPrEndRest,
  refreshPrStatus,
  refreshPrStatuses,
  type PrFetch,
  type PrRefresh,
} from "./pr-status";

export interface GithubOptions {
  // Replace gh (tests, the sim).
  api?: GhApi;
  prs?: PrFetch;
  clock?: GateClock;
}

// A poll this slow is worth saying so on the status line.
const SLOW_GITHUB_MS = 30_000;

function short(message: string): string {
  const line = message.split("\n")[0] ?? message;
  return line.length > 100 ? `${line.slice(0, 99)}…` : line;
}

function pauseWords(what: string, p: Pause): string {
  return p.why === PauseWhy.rateLimit
    ? `${what}rate limited until ${clockTime(p.until)}`
    : `${what}paused until ${clockTime(p.until)} (GraphQL budget low)`;
}

const log = logger("github");

export class GithubConnector implements Connector {
  readonly name = "github";
  readonly label = "GitHub";
  readonly hint = "GitHub uses your gh login.";
  private gate: GithubGate | null = null;
  private polling = false;
  private ctx!: ConnectorContext;

  constructor(private opts: GithubOptions = {}) {}

  attach(ctx: ConnectorContext): void {
    this.ctx = ctx;
  }

  start(): void {
    const config = this.ctx.config.get();
    const github = githubConfig.of(config);
    if (!github.enabled) {
      this.ctx.setStatus({ state: "off", detail: "disabled in config", at: null });
      return;
    }
    void this.poll();
    this.ctx.every(github.pollSeconds * 1000, () => void this.poll());
  }

  pollNow(): Promise<void> {
    return this.poll(true);
  }

  // Its agent's turn just ended: its PR is read now, through the same gate
  // as the clock (a PR backing off waits). One GraphQL point; while GraphQL
  // is paused, REST says whether it merged, since a merge should not wait
  // out a rate limit. A PR already read as merged is not read again.
  async refreshTask(task: TaskRow): Promise<void> {
    if (!githubConfig.of(this.ctx.config.get()).enabled) return;
    const pr = taskPr(task);
    if (!pr) return;
    const last = store.prStatus(task.id);
    if (last?.url === pr.url && last.state === PrState.merged) return;
    const gate = this.githubGate();
    if (!gate.prAllowed(pr.url)) return;
    const rest = async () => {
      if (gate.pause(GhBudget.rest)) return;
      await refreshPrEndRest(task, pr, this.opts.api ?? ghApi);
    };
    if (gate.pause(GhBudget.graphql)) return rest();
    try {
      await refreshPrStatus(task, this.opts.prs ?? ghPrBatch);
      gate.prSucceeded(pr.url);
    } catch (err) {
      const message = errorMessage(err);
      if (ghTrouble(message) === GhTrouble.rateLimit) {
        await this.githubLimited(GhBudget.graphql);
        return rest();
      }
      gate.prFailed(pr.url);
      store.markPrStale(task.id, message);
      log.warn("pr status at turn end failed", { task: task.id, error: message });
    }
  }

  // The gate outlives a restart only for a rate limit: GitHub's reset time
  // does not move because Riker did.
  private githubGate(): GithubGate {
    if (this.gate) return this.gate;
    const gate = new GithubGate(
      () => githubConfig.of(this.ctx.config.get()).pollSeconds * 1000,
      this.opts.clock,
    );
    for (const budget of Object.values(GhBudget)) {
      const saved = store.kvGet(`github.pause.${budget}`);
      if (!saved) continue;
      try {
        const p = JSON.parse(saved) as Pause;
        gate.hold(budget, p.until, p.why);
      } catch {
        // A pause that cannot be read is no pause.
      }
    }
    this.gate = gate;
    return gate;
  }

  private holdGithub(budget: GhBudget, until: number, why: PauseWhy): void {
    const gate = this.githubGate();
    gate.hold(budget, until, why);
    const p = gate.pause(budget);
    if (p) store.kvSet(`github.pause.${budget}`, JSON.stringify(p));
    log.warn("github paused", { budget, why, until: new Date(until).toISOString() });
  }

  // gh api rate_limit is free; it says when the spent budget comes back.
  private async githubLimited(budget: GhBudget): Promise<void> {
    const api = this.opts.api ?? ghApi;
    let limits: GhRateLimit | null = null;
    try {
      limits = (await api("rate_limit")) as GhRateLimit;
    } catch (err) {
      log.warn("rate_limit failed", { err: errorMessage(err) });
    }
    const clock = this.opts.clock;
    const nowMs = clock ? clock.now() : Date.now();
    this.holdGithub(budget, limitedUntil(budget, limits, nowMs), PauseWhy.rateLimit);
  }

  // force (the owner's check now) skips a backoff, never a rate limit.
  async poll(force = false): Promise<void> {
    if (this.polling) return;
    const gate = this.githubGate();
    if (gate.backoff() && !force) return;
    const restHeld = gate.pause(GhBudget.rest);
    const graphHeld = gate.pause(GhBudget.graphql);
    if (restHeld && graphHeld) {
      this.ctx.setStatus({
        state: "error",
        detail: pauseWords("", restHeld),
        at: now(),
      });
      return;
    }
    this.polling = true;
    this.ctx.setStatus({ ...this.ctx.status(), state: "polling" });
    const done = log.time("github poll");
    const started = Date.now();
    const api = this.opts.api ?? ghApi;
    try {
      let fresh = 0;
      if (!restHeld) {
        const startedAt = now();
        const since =
          store.kvGet("github.since") ??
          new Date(Date.now() - 2 * 86400000).toISOString();
        fresh = this.ctx.ingest(await pollGithub(since, api, store.hasBranchTasks));
        store.kvSet("github.since", startedAt);
      }
      // On the same clock: what the rail says about each task's PR.
      const prs = graphHeld
        ? null
        : await refreshPrStatuses({
            fetch: this.opts.prs ?? ghPrBatch,
            gate,
          });
      if (prs?.limited) await this.githubLimited(GhBudget.graphql);
      else if (prs?.budget && prs.budget.remaining < GRAPHQL_RESERVE)
        this.holdGithub(
          GhBudget.graphql,
          Date.parse(prs.budget.resetAt),
          PauseWhy.reserve,
        );
      await this.ctx.checkMerges();
      const ms = Date.now() - started;
      done({ fresh, prs: prs?.asked ?? 0, failed: prs?.failed ?? 0 });
      this.githubPolled(fresh, prs, ms);
    } catch (err) {
      done({ ok: false, err });
      const message = errorMessage(err);
      if (ghTrouble(message) === GhTrouble.rateLimit) {
        await this.githubLimited(GhBudget.rest);
        const p = gate.pause(GhBudget.rest);
        this.ctx.setStatus({
          state: "error",
          detail: p ? pauseWords("", p) : short(message),
          at: now(),
        });
      } else {
        const until = gate.failed(message);
        this.ctx.setStatus({
          state: "error",
          detail: `${short(message)} · retry ${clockTime(until)}`,
          at: now(),
        });
      }
    } finally {
      this.polling = false;
    }
  }

  // What the round says: new messages, PRs that could not be read, a paused
  // budget, a slow poll. Every PR failing is the poll failing.
  private githubPolled(fresh: number, prs: PrRefresh | null, ms: number): void {
    const gate = this.githubGate();
    const restHeld = gate.pause(GhBudget.rest);
    const graphHeld = gate.pause(GhBudget.graphql);
    const allFailed = !!prs && prs.asked > 0 && prs.ok === 0 && prs.failed === prs.asked;
    const failedWords = prs?.failed
      ? `${prs.failed} PR${prs.failed === 1 ? "" : "s"} failed: ${short(prs.error ?? "")}`
      : "";
    const parts = [
      restHeld ? pauseWords("", restHeld) : fresh ? `${fresh} new` : "up to date",
      failedWords,
      graphHeld ? pauseWords("PR status ", graphHeld) : "",
      ms > SLOW_GITHUB_MS ? `slow ${Math.round(ms / 1000)}s` : "",
    ];
    let state: ConnectorState = "ok";
    if (allFailed) {
      const until = gate.failed(prs.error ?? "PR status failed");
      parts.push(`retry ${clockTime(until)}`);
      state = "error";
    } else gate.succeeded();
    if (graphHeld?.why === PauseWhy.rateLimit || restHeld) state = "error";
    this.ctx.setStatus({
      state,
      detail: parts.filter(Boolean).join(" · "),
      at: now(),
    });
  }
}
