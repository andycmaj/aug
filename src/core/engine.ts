// The loop, in one place: something arrives, it gets a verdict, the verdict
// decides who does the work, and whatever comes out waits for you. The engine
// is what runs: the pollers, the agent pool, the Advisor's clock, the moves
// drain and the tmux watch. The owner's moves themselves live on its desk.

import { advisorDue, runAdvisor } from "./advisor";
import { AgentPool, type CodingLaunch } from "./agents";
import { loadConfig } from "./config";
import { dataVersion, now } from "./db";
import { Desk } from "./desk";
import { ensureDocs } from "./docs";
import { refreshInstalls } from "./install";
import { Drivers } from "./driver";
import { pollGithub } from "./ingest/github";
import { refreshPrStatuses } from "./pr";
import { errorMessage, logger } from "./log";
import { EMPTY_CURSOR, type SlackCursor } from "./slack/shared";
import { slackTransport, type SlackTransport } from "./slack/transport";
import { recoverAtBoot } from "./lifecycle";
import { drainMoves, runMove, type MoveOutcome } from "./moves";
import * as projects from "./projects";
import { setSlackSender } from "./outbound";
import * as store from "./store";
import { linkByBranch, triage, type TriageEffect } from "./triage";
import { SessionKind, TaskStatus, type TaskRow } from "./types";

export type ConnectorState = "off" | "polling" | "ok" | "error";

export interface ConnectorStatus {
  state: ConnectorState;
  detail: string;
  at: string | null;
}

export interface EngineStatus {
  github: ConnectorStatus;
  slack: ConnectorStatus;
  advisor: ConnectorStatus;
}

export interface EngineOptions {
  // Fixture mode: no pollers, no Advisor clock.
  offline?: boolean;
  // Replaces the coding agent's command line (fixture mode's fake claude).
  launchOverride?: (task: TaskRow, launch: CodingLaunch) => CodingLaunch;
  // Fixture mode has no checkouts: coding windows open in scratch.
  noWorktrees?: boolean;
  onLearned?: (line: string) => void;
  // Replaces the Slack transport chosen from config (tests).
  slack?: SlackTransport;
}

const log = logger("engine");

const off = (detail: string): ConnectorStatus => ({
  state: "off",
  detail,
  at: null,
});

export class Engine {
  readonly pool = new AgentPool();
  readonly drivers: Drivers;
  readonly desk: Desk;
  private slack: SlackTransport | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private polling = new Set<string>();
  private statusListeners = new Set<(s: EngineStatus) => void>();
  status: EngineStatus = {
    github: off("not started"),
    slack: off("not started"),
    advisor: off("not started"),
  };

  constructor(private options: EngineOptions = {}) {
    this.drivers = new Drivers({
      pool: this.pool,
      noWorktrees: options.noWorktrees,
      launchOverride: options.launchOverride,
    });
    this.desk = new Desk({
      drivers: this.drivers,
      offline: options.offline,
      onLearned: options.onLearned,
    });
  }

  onStatus(listener: (s: EngineStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(key: keyof EngineStatus, next: ConnectorStatus): void {
    const prev = this.status[key];
    // A connection changing state is worth a line; each poll is only a trace.
    if (prev.state !== next.state || prev.detail !== next.detail) {
      const fields = { from: prev.state, detail: next.detail };
      if (next.state === "error") log.error(`${key} ${next.state}`, fields);
      else if (next.state === "polling") log.trace(`${key} polling`, fields);
      else log.info(`${key} ${next.state}`, fields);
    }
    this.status = { ...this.status, [key]: next };
    for (const l of this.statusListeners) l(this.status);
  }

  // Your setup outside aug follows aug when it moves (a new checkout, the
  // compiled binary): stale installs are rewritten, nothing new goes in.
  private refreshInstalls(): void {
    try {
      const names = refreshInstalls();
      if (names.length) log.info("refreshed installs", { names: names.join(",") });
    } catch (err) {
      log.error("refresh installs failed", { error: errorMessage(err) });
    }
  }

  start(): void {
    ensureDocs();
    if (!this.options.offline) this.refreshInstalls();
    store.homeTask();
    this.recoverSessions();
    void this.reconcile();
    this.timers.push(
      setInterval(() => {
        void this.reconcile();
        this.watchTmux();
      }, 30_000),
    );
    this.watchTmux();
    store.wakeReminders();
    this.timers.push(setInterval(() => store.wakeReminders(), 60_000));
    this.watchMoves();
    if (this.options.offline) {
      this.setStatus("github", off("fixture mode"));
      this.setStatus("slack", off("fixture mode"));
      this.setStatus("advisor", off("fixture mode"));
      return;
    }
    const config = loadConfig();
    log.info("engine start", {
      github: config.github.enabled,
      slack: config.slack.enabled ? config.slack.transport : false,
      maxActiveAgents: config.maxActiveAgents,
    });
    if (config.github.enabled) {
      void this.pollGithub();
      this.timers.push(
        setInterval(
          () => void this.pollGithub(),
          config.github.pollSeconds * 1000,
        ),
      );
    } else this.setStatus("github", off("disabled in config"));
    this.slack = this.options.slack ?? slackTransport(config);
    const slack = this.slack;
    setSlackSender((action) => slack.send(action));
    const canSlack = slack.available();
    if (config.slack.enabled && canSlack.ok) {
      void this.pollSlack();
      this.timers.push(
        setInterval(
          () => void this.pollSlack(),
          config.slack.pollSeconds * 1000,
        ),
      );
    } else if (!config.slack.enabled)
      this.setStatus("slack", off("disabled in config"));
    else
      this.setStatus(
        "slack",
        slack.kind === "mcp"
          ? { state: "error", detail: canSlack.detail, at: now() }
          : off(canSlack.detail),
      );
    this.timers.push(setInterval(() => void this.advisorTick(), 10 * 60_000));
    setTimeout(() => void this.advisorTick(), 20_000);
  }

  stop(): void {
    log.info("engine stop");
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.watching?.abort();
    this.watching = null;
    this.slack?.stop();
    this.pool.stopAll();
  }

  // tmux keeps coding agents alive across restarts; reconcile asks it which
  // still are. Anything else that was live died with the last aug.
  private recoverSessions(): void {
    recoverAtBoot(
      (taskId) => this.pool.isRunning(taskId),
      (s) => s.kind === SessionKind.tmux,
    );
  }

  // aug-tools asks for moves from another process; its commit bumps
  // data_version, and the engine drains whatever is pending. A slot frees
  // from a hook in another process or from aug's own stop and tmux watch,
  // which data_version does not show, so the pool's queue is tried each tick.
  private draining = false;
  private watchMoves(): void {
    let seen = -1;
    this.timers.push(
      setInterval(() => {
        this.pool.drain();
        const v = dataVersion();
        if (v === seen || this.draining) return;
        seen = v;
        void this.drainMoves();
      }, 250),
    );
  }

  async drainMoves(): Promise<number> {
    this.draining = true;
    try {
      return await drainMoves(this.desk);
    } finally {
      this.draining = false;
    }
  }

  runMove(
    verb: string,
    args: Record<string, string>,
    by = "you",
  ): Promise<MoveOutcome> {
    return runMove(this.desk, verb, args, by);
  }

  // ── ingest ──────────────────────────────────────────────────────────────

  private async ingest(messages: store.NewMessage[]): Promise<number> {
    let fresh = 0;
    for (const m of messages) {
      const row = store.insertMessage(m);
      if (!row) continue;
      fresh++;
      linkByBranch(row);
      const outcome = await triage(row);
      log.debug("triaged", {
        message: row.id,
        channel: m.channel,
        verdict: outcome.verdict,
        task: outcome.taskId,
        reason: outcome.reason,
      });
      this.runEffects(outcome.effects);
    }
    return fresh;
  }

  runEffects(effects: TriageEffect[]): void {
    for (const effect of effects) {
      const task = store.getTask(effect.taskId);
      if (!task) continue;
      this.drivers
        .for(task)
        .wake(
          task,
          effect.type === "agent-turn"
            ? effect.reason
            : "a new message joined the thread",
        );
    }
  }

  async pollGithub(): Promise<void> {
    if (this.polling.has("github")) return;
    this.polling.add("github");
    this.setStatus("github", { ...this.status.github, state: "polling" });
    const done = log.time("github poll");
    try {
      const startedAt = now();
      const since =
        store.kvGet("github.since") ??
        new Date(Date.now() - 2 * 86400000).toISOString();
      const fresh = await this.ingest(
        await pollGithub(since, undefined, store.hasBranchTasks),
      );
      store.kvSet("github.since", startedAt);
      // On the same clock: what the rail says about each task's PR.
      const prs = await refreshPrStatuses();
      done({ fresh, prs });
      this.setStatus("github", {
        state: "ok",
        detail: fresh ? `${fresh} new` : "up to date",
        at: now(),
      });
    } catch (err) {
      done({ ok: false, err });
      this.setStatus("github", {
        state: "error",
        detail: errorMessage(err),
        at: now(),
      });
    } finally {
      this.polling.delete("github");
    }
  }

  async pollSlack(): Promise<void> {
    const slack = this.slack;
    if (!slack?.available().ok || this.polling.has("slack")) return;
    this.polling.add("slack");
    this.setStatus("slack", { ...this.status.slack, state: "polling" });
    const done = log.time("slack poll", { transport: slack.kind });
    try {
      const config = loadConfig();
      const cursor = JSON.parse(
        store.kvGet(`slack.cursor.${slack.kind}`) ??
          JSON.stringify(EMPTY_CURSOR),
      ) as SlackCursor;
      const trackedThreads = store
        .listTasks()
        .filter(
          (t) =>
            t.status !== TaskStatus.done &&
            t.thread_key?.startsWith("slack:") &&
            !t.thread_key.endsWith(":dm"),
        )
        .map((t) => t.thread_key!.slice("slack:".length));
      const result = await slack.poll({
        cursor,
        watchChannels: config.slack.channels,
        trackedThreads,
        firstLookSeconds: 86400,
      });
      store.kvSet(`slack.cursor.${slack.kind}`, JSON.stringify(result.cursor));
      const fresh = await this.ingest(result.messages);
      done({ read: result.messages.length, fresh });
      this.setStatus("slack", {
        state: "ok",
        detail: `${fresh ? `${fresh} new` : "up to date"} · ${slack.kind}`,
        at: now(),
      });
    } catch (err) {
      done({ ok: false, err });
      this.setStatus("slack", {
        state: "error",
        detail: errorMessage(err),
        at: now(),
      });
    } finally {
      this.polling.delete("slack");
    }
  }

  async pollNow(): Promise<void> {
    await Promise.all([this.pollGithub(), this.pollSlack()]);
  }

  private async advisorTick(force = false): Promise<void> {
    if (!force && !advisorDue(store.kvGet("advisor.lastRun"), new Date()))
      return;
    this.setStatus("advisor", { ...this.status.advisor, state: "polling" });
    const done = log.time("advisor run", { force });
    try {
      const added = await runAdvisor();
      done({ added });
      this.setStatus("advisor", {
        state: "ok",
        detail: added ? `${added} new ideas` : "nothing new",
        at: now(),
      });
    } catch (err) {
      done({ ok: false, err });
      this.setStatus("advisor", {
        state: "error",
        detail: errorMessage(err),
        at: now(),
      });
    }
  }

  advisorNow(): Promise<void> {
    return this.advisorTick(true);
  }

  private watching: AbortController | null = null;

  // One watch at a time; when it ends (no server yet, or it went away) the
  // next poll tick starts another.
  private watchTmux(): void {
    if (this.watching) return;
    const abort = new AbortController();
    this.watching = abort;
    projects
      .watchTmux(() => void this.reconcile(), abort.signal)
      .catch((err) => log.debug("tmux watch ended", { err: errorMessage(err) }))
      .finally(() => {
        if (this.watching === abort) this.watching = null;
      });
  }

  async reconcile(): Promise<void> {
    try {
      await projects.reconcile();
    } catch (err) {
      log.warn("reconcile failed", { err: errorMessage(err) });
    }
  }

}
