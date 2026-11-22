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
import { Drafts } from "./outbound";
import { syncDocs } from "./doc-sync";
import { refreshInstalls } from "./install";
import { Drivers } from "./driver";
import { checkMerges } from "./merge";
import { errorMessage, logger } from "./log";
import { count, measure, perfStart } from "./perf";
import { recoverAtBoot } from "./lifecycle";
import { drainMoves, runMove, type MoveOutcome } from "./moves";
import * as projects from "./projects";
import * as store from "./store";
import { ActionEvent } from "./task-actions";
import { settleStaleTurns } from "./turn-check";
import {
  offStatus,
  type Connector,
  type ConnectorContext,
  type ConnectorStatus,
  type RikerPlugin,
  type Triage,
  type Triaged,
  type TriageEffect,
} from "./plugins";
import { SessionKind, type TaskRow } from "./types";

export type { ConnectorState, ConnectorStatus } from "./plugins";

// Each connector's line by its name, and the Advisor's.
export type EngineStatus = Record<string, ConnectorStatus> & {
  advisor: ConnectorStatus;
};

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
  // What other packages add (core/plugins.ts): triage, connections.
  plugins?: readonly RikerPlugin[];
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

const off = offStatus;

export class Engine {
  readonly pool: AgentPool;
  readonly drivers: Drivers;
  readonly desk: Desk;
  private timers: ReturnType<typeof setInterval>[] = [];
  private statusListeners = new Set<(s: EngineStatus) => void>();
  status: EngineStatus = {
    advisor: off("not started"),
  };
  // Every connector the plugins brought, in their order.
  readonly connectors: readonly Connector[];

  // What the status line and modal list, in order.
  connections(): readonly Pick<Connector, "name" | "label" | "quietWhenOff" | "hint">[] {
    return this.connectors;
  }

  private readonly judge: Triage | null;

  constructor(private options: EngineOptions) {
    const { config } = options;
    const judges = (options.plugins ?? []).flatMap((p) => (p.triage ? [p.triage] : []));
    if (judges.length > 1) throw new Error("more than one plugin brings triage");
    this.judge = judges[0] ?? null;
    const plugins = options.plugins ?? [];
    this.connectors = plugins.flatMap((p) => p.connectors ?? []);
    const names = new Set<string>(["advisor"]);
    for (const c of this.connectors) {
      if (names.has(c.name)) throw new Error(`two connectors are called ${c.name}`);
      names.add(c.name);
      this.status = { ...this.status, [c.name]: off("not started") };
    }
    const drafts = Drafts.of(plugins);
    this.pool = new AgentPool({ config, drafts });
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
      drafts,
      guards: plugins.flatMap((p) => p.guards ?? []),
    });
    for (const c of this.connectors) c.attach(this.connectorContext(c));
  }

  onStatus(listener: (s: EngineStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private connectorContext(c: Connector): ConnectorContext {
    return {
      config: this.options.config,
      status: () => this.status[c.name] ?? off("not started"),
      setStatus: (next) => this.setStatus(c.name, next),
      ingest: (messages) => this.ingest(messages),
      every: (ms, fn) => void this.timers.push(setInterval(fn, ms)),
      say: (taskId, text, author) => this.desk.say(taskId, text, author),
      wake: (taskId, reason) => {
        const task = store.getTask(taskId);
        if (task) void this.drivers.for(task).wake(task, reason);
      },
      runMove: (verb, args, by) => this.runMove(verb, args, by),
      checkMerges: () => this.checkMerges(),
    };
  }

  private setStatus(key: string, next: ConnectorStatus): void {
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
      for (const c of this.connectors) this.setStatus(c.name, off("fixture mode"));
      this.setStatus("advisor", off("fixture mode"));
      return;
    }
    void this.resumeTriage();
    // Retries come due on their own clock.
    this.timers.push(setInterval(() => void this.triageInbox(), 15_000));
    const config = this.options.config.get();
    log.info("engine start", {
      connectors: this.connectors.map((c) => c.name).join(","),
      maxActiveAgents: config.maxActiveAgents,
    });
    for (const c of this.connectors) c.start();
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
    for (const c of this.connectors) c.stop?.();
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

  async pollNow(): Promise<void> {
    await Promise.all(this.connectors.map((c) => c.pollNow?.()));
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
