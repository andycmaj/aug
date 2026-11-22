// The loop, in one place: something arrives, it gets a verdict, the verdict
// decides who does the work, and whatever comes out waits for you. The engine
// is what runs: the pollers, the agent pool, the Advisor's clock, the moves
// drain and the tmux watch. The owner's moves themselves live on its desk.

import { advisorDue, runAdvisor } from "./advisor";
import { runDocPass } from "./doc-pass";
import { AgentPool, type CodingLaunch } from "./agents";
import type { ConfigSource } from "./config";
import { dataVersion, now } from "./db";
import { Desk } from "./desk";
import { syncDocs } from "./doc-sync";
import { refreshInstalls } from "./install";
import { Drivers } from "./driver";
import { ghApi, pollGithub, type GhApi } from "./ingest/github";
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
} from "./github-gate";
import { ghPrBatch, refreshPrStatuses, type PrFetch, type PrRefresh } from "./pr";
import { checkMerges } from "./merge";
import { errorMessage, logger } from "./log";
import { count, measure, perfStart } from "./perf";
import { EMPTY_CURSOR, type SlackCursor } from "./slack/shared";
import { slackTransport, type SlackTransport } from "./slack/transport";
import { Remote, remoteChannel, type RemoteLink } from "./slack/remote";
import { remoteLink } from "./slack/remote-links";
import { recoverAtBoot } from "./lifecycle";
import { drainMoves, runMove, type MoveOutcome } from "./moves";
import * as projects from "./projects";
import { setSlackSender } from "./outbound";
import * as store from "./store";
import { ActionEvent } from "./task-actions";
import { settleStaleTurns } from "./turn-check";
import type { RikerPlugin, Triage, Triaged, TriageEffect } from "./plugins";
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
  // Talking to the Assistant from Slack (core/slack/remote.ts).
  remote: ConnectorStatus;
  advisor: ConnectorStatus;
}

export interface EngineOptions {
  // config.json for a real Riker, fixedConfig for tests and the fixture day.
  // Everything the engine owns reads it through this, never a global.
  config: ConfigSource;
  // Fixture mode: no pollers, no Advisor clock.
  offline?: boolean;
  // Replaces the coding agent's command line (fixture mode's fake claude).
  launchOverride?: (task: TaskRow, launch: CodingLaunch) => CodingLaunch;
  // Fixture mode has no checkouts: coding windows open in scratch.
  noWorktrees?: boolean;
  onLearned?: (line: string) => void;
  // Replaces the Slack transport chosen from config (tests).
  slack?: SlackTransport;
  // Replaces gh for the GitHub poll (tests).
  github?: { api?: GhApi; prs?: PrFetch; clock?: GateClock };
  // Replaces the remote's Slack link chosen from config (tests).
  remoteLink?: RemoteLink;
  // What other packages add (core/plugins.ts): triage, connections.
  plugins?: readonly RikerPlugin[];
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

const EVENTS_CURSOR = "actions.events";

// task_events kinds that are action triggers: an agent's finished work
// (sessions.result, set only by workFinished) is ready for review.
const EVENT_TRIGGERS: Record<string, ActionEvent> = {
  finished: ActionEvent.ready,
  merged: ActionEvent.merged,
  done: ActionEvent.done,
};

const log = logger("engine");

const off = (detail: string): ConnectorStatus => ({
  state: "off",
  detail,
  at: null,
});

export class Engine {
  readonly pool: AgentPool;
  readonly drivers: Drivers;
  readonly desk: Desk;
  private slack: SlackTransport | null = null;
  private remote: Remote | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private polling = new Set<string>();
  private gate: GithubGate | null = null;
  private statusListeners = new Set<(s: EngineStatus) => void>();
  status: EngineStatus = {
    github: off("not started"),
    slack: off("not started"),
    remote: off("not started"),
    advisor: off("not started"),
  };

  private readonly judge: Triage | null;

  constructor(private options: EngineOptions) {
    const { config } = options;
    const judges = (options.plugins ?? []).flatMap((p) => (p.triage ? [p.triage] : []));
    if (judges.length > 1) throw new Error("more than one plugin brings triage");
    this.judge = judges[0] ?? null;
    this.slack = options.slack ?? null;
    this.pool = new AgentPool({ config });
    this.drivers = new Drivers({
      pool: this.pool,
      config,
      noWorktrees: options.noWorktrees,
      launchOverride: options.launchOverride,
    });
    this.desk = new Desk({
      drivers: this.drivers,
      config,
      offline: options.offline,
      onLearned: options.onLearned,
      triage: this.judge ?? undefined,
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

  // Your setup outside Riker follows Riker when it moves (a new checkout, the
  // compiled binary): stale installs are rewritten, nothing new goes in.
  private refreshInstalls(): void {
    try {
      const names = refreshInstalls();
      if (names.length) log.info("refreshed installs", { names: names.join(",") });
    } catch (err) {
      log.error("refresh installs failed", { error: errorMessage(err) });
    }
  }

  // The brain docs at start: the SOUL rename, shipped updates, the
  // onboarding offer (not on the fixture day). A failure costs a notice,
  // never the start.
  private syncDocs(): void {
    try {
      syncDocs({ offer: !this.options.offline });
    } catch (err) {
      log.error("doc sync failed", { error: errorMessage(err) });
    }
  }

  start(): void {
    this.syncDocs();
    if (!this.options.offline) this.refreshInstalls();
    store.homeTask();
    this.recoverSessions();
    void this.reconcile();
    this.timers.push(
      setInterval(() => {
        void this.reconcile("tick");
        this.watchTmux();
      }, 30_000),
    );
    this.watchTmux();
    const wakeReminders = () => measure("engine.reminders", () => store.wakeReminders());
    wakeReminders();
    this.timers.push(setInterval(wakeReminders, 60_000));
    this.watchMoves();
    this.timers.push(setInterval(() => this.fireEventActions(), 2_000));
    if (this.options.offline) {
      this.setStatus("github", off("fixture mode"));
      this.setStatus("slack", off("fixture mode"));
      this.setStatus("remote", off("fixture mode"));
      this.setStatus("advisor", off("fixture mode"));
      return;
    }
    void this.resumeTriage();
    // Retries come due on their own clock.
    this.timers.push(setInterval(() => void this.triageInbox(), 15_000));
    const config = this.options.config.get();
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
    this.startRemote();
    this.timers.push(setInterval(() => void this.advisorTick(), 10 * 60_000));
    setTimeout(() => void this.advisorTick(), 20_000);
    // A local merge needs no network, so it has its own clock.
    void this.checkMerges();
    this.timers.push(setInterval(() => void this.checkMerges(), 2 * 60_000));
  }

  private merging = false;

  async checkMerges(): Promise<void> {
    if (this.merging) return;
    this.merging = true;
    try {
      const changed = await checkMerges(this.options.config.get());
      if (changed) log.info("merge check", { changed });
    } catch (err) {
      log.warn("merge check failed", { err: errorMessage(err) });
    } finally {
      this.merging = false;
    }
  }

  stop(): void {
    log.info("engine stop");
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.watching?.abort();
    this.watching = null;
    this.slack?.stop();
    this.remote?.stop();
    this.remote = null;
    this.pool.stopAll();
  }

  // tmux keeps coding agents alive across restarts; reconcile asks it which
  // still are. Anything else that was live died with the last Riker.
  private recoverSessions(): void {
    recoverAtBoot(
      (taskId) => this.pool.isRunning(taskId),
      (s) => s.kind === SessionKind.tmux,
    );
  }

  // riker-tools asks for moves from another process; its commit bumps
  // data_version, and the engine drains whatever is pending. A slot frees
  // from a hook in another process or from Riker's own stop and tmux watch,
  // which data_version does not show, so the pool's queue is tried each tick.
  private draining = false;
  private watchMoves(): void {
    let seen = -1;
    this.timers.push(
      setInterval(() => {
        const v = measure("engine.moves_tick", () => {
          this.pool.drain();
          return dataVersion();
        });
        if (v === seen || this.draining) return;
        seen = v;
        void this.drainMoves();
      }, 250),
    );
  }

  // Task events since the last look, as action triggers. task_events is
  // written by triggers, so an agent's `done` from another process is heard
  // here. The first look starts at the newest event: history runs nothing.
  fireEventActions(): number {
    const cursor = store.kvGet(EVENTS_CURSOR);
    if (cursor === null) {
      store.kvSet(EVENTS_CURSOR, String(store.lastTaskEventId()));
      return 0;
    }
    const events = store.taskEventsAfter(Number(cursor));
    if (events.length === 0) return 0;
    let queued = 0;
    for (const e of events) {
      const event = EVENT_TRIGGERS[e.kind];
      if (event) queued += this.desk.fireActions(event, e.task_id).length;
    }
    store.kvSet(EVENTS_CURSOR, String(events.at(-1)!.id));
    return queued;
  }

  async drainMoves(): Promise<number> {
    this.draining = true;
    const done = perfStart("engine.drain_moves");
    let moves = 0;
    try {
      moves = await drainMoves(this.desk);
      return moves;
    } finally {
      done({ moves });
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

  // A poller only inserts (a duplicate is refused) and moves its cursor on
  // after; triage is the worker's, so a crash between the two loses nothing.
  private ingest(messages: store.NewMessage[]): number {
    let fresh = 0;
    for (const m of messages) {
      const row = measure("engine.insert_message", () => store.insertMessage(m));
      if (!row) continue;
      fresh++;
      this.judge?.arrived?.(row);
    }
    if (fresh && !this.options.offline) void this.triageInbox();
    return fresh;
  }

  // The inbox's one worker: GitHub's and Slack's messages wait their turn
  // here, oldest first. A call while it runs asks for one more pass, so a
  // message inserted mid-run is not left until the next tick.
  private triaging: Promise<number> | null = null;
  private triageAgain = false;
  triageInbox(): Promise<number> {
    const judge = this.judge;
    if (!judge) return Promise.resolve(0);
    if (this.triaging) {
      this.triageAgain = true;
      return this.triaging;
    }
    const run = async (): Promise<number> => {
      let ran = 0;
      do {
        this.triageAgain = false;
        for (;;) {
          let done: Triaged | null;
          try {
            done = await judge.next(this.options.config.get());
          } catch (err) {
            // Its messages wait for their retry; the next tick goes on.
            log.error("triage failed", { err: errorMessage(err) });
            break;
          }
          if (!done) break;
          ran++;
          log.debug("triaged", {
            messages: done.messages.join(","),
            verdict: done.outcome.verdict,
            task: done.outcome.taskId,
            reason: done.outcome.reason,
          });
          // The chain ran on the latest of a burst: that one's words.
          this.desk.afterTriage(done.outcome, store.getMessage(done.messages.at(-1)!));
        }
      } while (this.triageAgain);
      return ran;
    };
    this.triaging = run().finally(() => {
      this.triaging = null;
    });
    return this.triaging;
  }

  // At start: claims a Riker that died left are new again, and the worker
  // takes whatever waits (inserted, never triaged; a retry come due).
  resumeTriage(): Promise<number> {
    if (!this.judge) return Promise.resolve(0);
    const reset = store.resetTriaging();
    if (reset) log.info("triage claims reset", { messages: reset });
    return this.triageInbox();
  }

  runEffects(effects: TriageEffect[]): void {
    this.desk.runEffects(effects);
  }

  // The gate outlives a restart only for a rate limit: GitHub's reset time
  // does not move because Riker did.
  private githubGate(): GithubGate {
    if (this.gate) return this.gate;
    const gate = new GithubGate(
      () => this.options.config.get().github.pollSeconds * 1000,
      this.options.github?.clock,
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
    const api = this.options.github?.api ?? ghApi;
    let limits: GhRateLimit | null = null;
    try {
      limits = (await api("rate_limit")) as GhRateLimit;
    } catch (err) {
      log.warn("rate_limit failed", { err: errorMessage(err) });
    }
    const clock = this.options.github?.clock;
    const nowMs = clock ? clock.now() : Date.now();
    this.holdGithub(budget, limitedUntil(budget, limits, nowMs), PauseWhy.rateLimit);
  }

  // force (the owner's check now) skips a backoff, never a rate limit.
  async pollGithub(force = false): Promise<void> {
    if (this.polling.has("github")) return;
    const gate = this.githubGate();
    if (gate.backoff() && !force) return;
    const restHeld = gate.pause(GhBudget.rest);
    const graphHeld = gate.pause(GhBudget.graphql);
    if (restHeld && graphHeld) {
      this.setStatus("github", {
        state: "error",
        detail: pauseWords("", restHeld),
        at: now(),
      });
      return;
    }
    this.polling.add("github");
    this.setStatus("github", { ...this.status.github, state: "polling" });
    const done = log.time("github poll");
    const started = Date.now();
    const api = this.options.github?.api ?? ghApi;
    try {
      let fresh = 0;
      if (!restHeld) {
        const startedAt = now();
        const since =
          store.kvGet("github.since") ??
          new Date(Date.now() - 2 * 86400000).toISOString();
        fresh = this.ingest(await pollGithub(since, api, store.hasBranchTasks));
        store.kvSet("github.since", startedAt);
      }
      // On the same clock: what the rail says about each task's PR.
      const prs = graphHeld
        ? null
        : await refreshPrStatuses({
            fetch: this.options.github?.prs ?? ghPrBatch,
            gate,
          });
      if (prs?.limited) await this.githubLimited(GhBudget.graphql);
      else if (prs?.budget && prs.budget.remaining < GRAPHQL_RESERVE)
        this.holdGithub(
          GhBudget.graphql,
          Date.parse(prs.budget.resetAt),
          PauseWhy.reserve,
        );
      await this.checkMerges();
      const ms = Date.now() - started;
      done({ fresh, prs: prs?.asked ?? 0, failed: prs?.failed ?? 0 });
      this.githubPolled(fresh, prs, ms);
    } catch (err) {
      done({ ok: false, err });
      const message = errorMessage(err);
      if (ghTrouble(message) === GhTrouble.rateLimit) {
        await this.githubLimited(GhBudget.rest);
        const p = gate.pause(GhBudget.rest);
        this.setStatus("github", {
          state: "error",
          detail: p ? pauseWords("", p) : short(message),
          at: now(),
        });
      } else {
        const until = gate.failed(message);
        this.setStatus("github", {
          state: "error",
          detail: `${short(message)} · retry ${clockTime(until)}`,
          at: now(),
        });
      }
    } finally {
      this.polling.delete("github");
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
    this.setStatus("github", {
      state,
      detail: parts.filter(Boolean).join(" · "),
      at: now(),
    });
  }

  async pollSlack(): Promise<void> {
    const slack = this.slack;
    if (!slack?.available().ok || this.polling.has("slack")) return;
    this.polling.add("slack");
    this.setStatus("slack", { ...this.status.slack, state: "polling" });
    const done = log.time("slack poll", { transport: slack.kind });
    try {
      const config = this.options.config.get();
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
      const own = remoteChannel(this.options.config);
      const polled = await slack.poll({
        cursor,
        watchChannels: config.slack.channels,
        trackedThreads,
        firstLookSeconds: 86400,
      });
      // The remote's conversation is Riker talking with the owner, not inbox.
      const result = {
        ...polled,
        messages: polled.messages.filter((m) => m.meta?.channel !== own),
      };
      const fresh = this.ingest(result.messages);
      store.kvSet(`slack.cursor.${slack.kind}`, JSON.stringify(result.cursor));
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

  // ── the remote: the owner's Slack line to the Assistant ───────────────

  private startRemote(): void {
    const config = this.options.config.get();
    if (!config.remote.enabled) {
      this.setStatus("remote", off("disabled in config"));
      return;
    }
    const link = this.options.remoteLink ?? remoteLink(config);
    if ("error" in link) {
      this.setStatus("remote", { state: "error", detail: link.error, at: now() });
      return;
    }
    this.remote = new Remote({
      link,
      config: this.options.config,
      say: (taskId, text, author) => this.desk.say(taskId, text, author),
      wake: (taskId) => {
        const home = store.getTask(taskId);
        if (home)
          this.drivers.for(home).wake(home, "the owner wrote from Slack");
      },
      // The owner's own yes in Slack: the move runs as theirs.
      runMove: (verb, args) => this.runMove(verb, args, "you via Slack"),
    });
    void this.pollRemote();
    this.timers.push(
      setInterval(() => void this.pollRemote(), config.remote.pollSeconds * 1000),
    );
  }

  async pollRemote(): Promise<void> {
    const remote = this.remote;
    if (!remote || !this.options.config.get().remote.enabled) return;
    if (this.status.remote.state !== "error")
      this.setStatus("remote", { ...this.status.remote, state: "polling" });
    try {
      const result = await remote.tick();
      if (!result) return;
      const did = [
        result.heard ? `${result.heard} heard` : "",
        result.answered ? `${result.answered} answered` : "",
      ]
        .filter(Boolean)
        .join(", ");
      this.setStatus("remote", {
        state: "ok",
        detail: `${did || "listening"} · ${result.channel} · ${remote.kind}`,
        at: now(),
      });
    } catch (err) {
      // Slack unreachable, or the conversation is not the owner's alone:
      // nothing is heard or lost, and the next tick tries again.
      this.setStatus("remote", {
        state: "error",
        detail: errorMessage(err),
        at: now(),
      });
    }
  }

  async pollNow(): Promise<void> {
    await Promise.all([this.pollGithub(true), this.pollSlack()]);
  }

  private async advisorTick(force = false): Promise<void> {
    if (!force && !advisorDue(store.kvGet("advisor.lastRun"), new Date()))
      return;
    this.setStatus("advisor", { ...this.status.advisor, state: "polling" });
    const done = log.time("advisor run", { force });
    try {
      const { added, skipped } = await runAdvisor(
        this.options.config.get(),
        new Date(),
        force,
      );
      done({ added, skipped: skipped ?? null });
      this.setStatus("advisor", {
        state: "ok",
        detail: skipped
          ? `skipped: ${skipped}`
          : added
            ? `${added} new ideas`
            : "nothing new",
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
    // The daily doc pass rides the same clock; it gates itself.
    try {
      await runDocPass(this.options.config.get(), new Date(), force);
    } catch (err) {
      log.error("doc pass failed", { error: errorMessage(err) });
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
      .watchTmux(() => {
        count("engine.tmux_event");
        void this.reconcile("tmux");
      }, abort.signal)
      .catch((err) => log.debug("tmux watch ended", { err: errorMessage(err) }))
      .finally(() => {
        if (this.watching === abort) this.watching = null;
      });
  }

  async reconcile(by = "start"): Promise<void> {
    if (by === "start")
      try {
        const tagged = await projects.copyLegacyTags();
        if (tagged) log.info("copied aug's tmux tags", { tagged });
      } catch (err) {
        log.warn("copying aug's tmux tags failed", { err: errorMessage(err) });
      }
    const done = perfStart("engine.reconcile", { by });
    try {
      await projects.reconcile();
      done();
    } catch (err) {
      done({ ok: false });
      log.warn("reconcile failed", { err: errorMessage(err) });
    }
    try {
      const settled = settleStaleTurns();
      if (settled.length) log.info("stale turns settled", { sessions: settled });
    } catch (err) {
      log.warn("turn check failed", { err: errorMessage(err) });
    }
  }

}
