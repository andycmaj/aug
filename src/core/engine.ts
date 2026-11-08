// The loop, in one place: something arrives, it gets a verdict, the verdict
// decides who does the work, and whatever comes out waits for you. The engine
// owns the pollers, the agent pool and the Advisor's clock, and every move
// the owner makes (the buttons) goes through it so the TUI stays a view.

import { advisorDue, runAdvisor } from "./advisor";
import { AgentPool, type CodingLaunch } from "./agents";
import { loadConfig } from "./config";
import { dataVersion, now } from "./db";
import { DocName, ensureDocs, readDoc, writeDoc } from "./docs";
import { pollGithub } from "./ingest/github";
import { errorMessage, logger } from "./log";
import { EMPTY_CURSOR, type SlackCursor } from "./slack/shared";
import { slackTransport, type SlackTransport } from "./slack/transport";
import { correct } from "./learn";
import { nudgeText } from "./feedback";
import { drainMoves, runMove, type MoveOutcome } from "./moves";
import * as projects from "./projects";
import { editPending, sendPending, setSlackSender } from "./outbound";
import * as store from "./store";
import { triage, type TriageEffect } from "./triage";
import {
  AgentState,
  Kind,
  Priority,
  SessionKind,
  TaskStatus,
  TurnRole,
  Verdict,
  type MessageRow,
  type TaskRow,
} from "./types";

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

// A PR whose head branch is a task's worktree branch is that task's thread,
// so its reviews and CI land on the task instead of making a new one.
export function linkByBranch(message: MessageRow): number | null {
  if (message.channel !== "github") return null;
  const meta = JSON.parse(message.meta) as { repo?: string; head?: string };
  if (!meta.repo || !meta.head) return null;
  const task = store.taskForBranch(meta.repo, meta.head);
  if (!task || task.thread_key === message.thread_key) return null;
  store.linkThread(task.id, message.thread_key);
  if (!task.url && message.url) store.updateTask(task.id, { url: message.url });
  return task.id;
}

const off = (detail: string): ConnectorStatus => ({
  state: "off",
  detail,
  at: null,
});

export class Engine {
  readonly pool = new AgentPool();
  private slack: SlackTransport | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private polling = new Set<string>();
  private statusListeners = new Set<(s: EngineStatus) => void>();
  status: EngineStatus = {
    github: off("not started"),
    slack: off("not started"),
    advisor: off("not started"),
  };

  constructor(private options: EngineOptions = {}) {}

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

  start(): void {
    ensureDocs();
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

  // Sessions alive when aug last quit are not alive now: a chat turn cut off
  // or a terminal closed reads as stopped, with Continue.
  // tmux keeps coding agents alive across restarts; reconcile asks it which
  // still are. Anything else that was live died with the last aug.
  private recoverSessions(): void {
    store.batch(() => {
      for (const s of store.liveSessions()) {
        if (s.kind === SessionKind.tmux) continue;
        store.updateSession(s.id, {
          state: AgentState.stopped,
          ended_at: now(),
        });
        const task = store.getTask(s.task_id);
        if (
          task &&
          (task.agent_state === AgentState.working ||
            task.agent_state === AgentState.blocked)
        ) {
          store.updateTask(task.id, { agent_state: AgentState.stopped });
        }
      }
      for (const task of store.listTasks()) {
        if (
          task.agent_state === AgentState.working &&
          !store.liveSessions().some((s) => s.task_id === task.id) &&
          !this.pool.isRunning(task.id)
        ) {
          store.updateTask(task.id, { agent_state: AgentState.stopped });
        }
      }
    });
  }

  // aug-tools asks for moves from another process; its commit bumps
  // data_version, and the engine drains whatever is pending.
  private draining = false;
  private watchMoves(): void {
    let seen = -1;
    this.timers.push(
      setInterval(() => {
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
      return await drainMoves(this);
    } finally {
      this.draining = false;
    }
  }

  runMove(
    verb: string,
    args: Record<string, string>,
    by = "you",
  ): Promise<MoveOutcome> {
    return runMove(this, verb, args, by);
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
      const session = store.latestSession(effect.taskId);
      if (
        effect.type === "agent-message" &&
        (session?.kind === SessionKind.pty || session?.kind === SessionKind.tmux)
      )
        continue;
      const reason =
        effect.type === "agent-turn"
          ? effect.reason
          : "a new message joined the thread";
      void this.pool.request(effect.taskId, reason, "aug");
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
      done({ fresh });
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

  // ── the owner's moves ───────────────────────────────────────────────────

  private learnedNotice = (line: string) => this.options.onLearned?.(line);

  newTask(
    title: string,
    kind: Kind,
    summary = "",
    place: Pick<store.NewTask, "projectId" | "repo" | "fromTaskId"> = {},
  ): TaskRow {
    const task = store.createTask({
      title,
      kind,
      summary,
      channel: "owner",
      ...place,
    });
    if (kind === Kind.coding) {
      store.updateTask(task.id, {
        agent_state: AgentState.queued,
        queue_reason: "held for you: press Start",
      });
    }
    return store.getTask(task.id) ?? task;
  }

  // Typing always continues: same agent, same conversation, whether it is
  // working, finished or stopped. A closed task's chat reopens it.
  say(taskId: number, text: string): void {
    const task = store.getTask(taskId);
    if (!task || !text.trim()) return;
    store.batch(() => {
      if (task.status !== TaskStatus.open) store.reopen(taskId);
      store.addTurn({
        taskId,
        role: TurnRole.you,
        author: "you",
        body: text.trim(),
      });
      store.updateTask(taskId, { unread_result: 0 });
    });
    if (task.kind !== Kind.coding)
      void this.pool.request(taskId, "the owner typed in the chat", "owner");
  }

  startGeneral(taskId: number, note?: string): void {
    // Home's agent is the Assistant, which answers what the owner says. Start
    // would run it with nothing new to answer.
    if (store.getTask(taskId)?.kind === Kind.home) return;
    if (note?.trim())
      store.addTurn({
        taskId,
        role: TurnRole.you,
        author: "you",
        body: note.trim(),
      });
    void this.pool.request(
      taskId,
      note ? "the owner sent it with a note" : "the owner pressed Start",
      "owner",
    );
  }

  // A coding agent: a claude in a window of the task's project session.
  // tmux owns it; the TUI only embeds a viewer on it.
  startCoding(
    taskId: number,
    opts: Omit<projects.StartOptions, "launchOverride"> = {},
  ): Promise<projects.StartResult> {
    return projects.startTask(taskId, {
      ...opts,
      noWorktree: opts.noWorktree || this.options.noWorktrees,
      launchOverride: this.options.launchOverride,
    });
  }

  // ── projects ──────────────────────────────────────────────────────────

  // Fixture mode has no checkouts: no branch or repo questions.
  get makesWorktrees(): boolean {
    return !this.options.noWorktrees;
  }

  // Fixture mode never touches your real settings (the hooks offer).
  get offline(): boolean {
    return Boolean(this.options.offline);
  }

  createProject(name: string, repo?: string | null) {
    return projects.createProject({ name, repo });
  }

  adoptableSessions() {
    return projects.adoptableSessions();
  }

  adoptSession(sessionId: string) {
    return projects.adoptSession(sessionId);
  }

  archiveProject(projectId: number) {
    return projects.archiveProject(projectId);
  }

  setTaskRepo(taskId: number, repo: string) {
    projects.setTaskRepo(taskId, repo);
  }

  moveTask(taskId: number, projectId: number) {
    return projects.moveTask(taskId, projectId);
  }

  jumpToProject(projectId: number) {
    return projects.jumpToProject(projectId);
  }

  // One line into the agent's window pointing it at its feedback.
  nudge(taskId: number): Promise<boolean> {
    return projects.nudge(taskId, nudgeText(taskId));
  }

  stopCoding(taskId: number): Promise<void> {
    return projects.stopTask(taskId);
  }

  // Done with a coding task: its window and worktree go too.
  async closeCoding(taskId: number): Promise<projects.CloseResult> {
    this.markDone(taskId);
    return projects.closeTask(taskId);
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

  stopAgent(taskId: number): void {
    this.pool.stop(taskId);
    const task = store.getTask(taskId);
    if (task?.agent_state === AgentState.queued)
      store.updateTask(taskId, {
        agent_state: AgentState.saved,
        queue_reason: null,
      });
  }

  async send(taskId: number): Promise<string> {
    return sendPending(taskId);
  }

  editDraft(taskId: number, text: string): boolean {
    const before = editPending(taskId, text);
    if (before === null) return false;
    correct(
      { taskId, what: "edited the draft before sending", before, after: text },
      this.learnedNotice,
    );
    return true;
  }

  redraft(taskId: number, instruction: string): void {
    const pending = store.pendingAction(taskId);
    correct(
      {
        taskId,
        what: "asked for a redraft",
        before: pending?.turn.action ?? null,
        note: instruction,
      },
      this.learnedNotice,
    );
    store.retirePendingActions(taskId);
    this.say(taskId, `Redraft the reply: ${instruction}`);
  }

  markDone(taskId: number): void {
    this.pool.stop(taskId);
    store.markDone(taskId);
  }

  remind(taskId: number, days: number): string {
    const at = new Date();
    at.setDate(at.getDate() + Math.max(1, Math.round(days)));
    at.setHours(7, 0, 0, 0);
    store.remindAt(taskId, at.toISOString());
    return at.toISOString();
  }

  watch(taskId: number, on: boolean): void {
    store.setWatching(taskId, on);
    correct(
      {
        taskId,
        what: on
          ? "Watch it: not mine, someone else handles it"
          : "Stop watching: this is mine",
      },
      this.learnedNotice,
    );
  }

  // Not a task: deleted if nothing was done on it, otherwise Mark done.
  notATask(taskId: number, why = ""): void {
    const task = store.getTask(taskId);
    if (!task) return;
    const worked = store
      .turnsForTask(taskId)
      .some((t) => t.role === TurnRole.agent || t.role === TurnRole.you);
    correct(
      {
        taskId,
        what: "Not a task: should have been FYI",
        before: task.kind,
        after: "fyi",
        note: why || null,
      },
      this.learnedNotice,
    );
    if (worked) store.markDone(taskId);
    else {
      this.pool.stop(taskId);
      store.updateTask(taskId, {
        status: TaskStatus.dropped,
        closed_at: now(),
        closed_by: "you",
      });
      for (const m of store.messagesForTask(taskId))
        store.fileMessage(m.id, Verdict.fyi, "you said: not a task", null);
    }
  }

  setPriority(taskId: number, priority: Priority): void {
    const task = store.getTask(taskId);
    if (!task || task.priority === priority) return;
    store.updateTask(taskId, { priority, priority_pinned: 1 });
    correct(
      {
        taskId,
        what: "changed priority",
        before: task.priority,
        after: priority,
      },
      this.learnedNotice,
    );
  }

  setKind(taskId: number, kind: Kind): void {
    const task = store.getTask(taskId);
    if (!task || task.kind === kind) return;
    store.updateTask(taskId, {
      kind,
      ...(kind === Kind.coding && task.agent_state === AgentState.none
        ? {
            agent_state: AgentState.queued,
            queue_reason: "held for you: press Start",
          }
        : {}),
    });
    correct(
      {
        taskId,
        what: "changed what kind of work it is",
        before: task.kind,
        after: kind,
      },
      this.learnedNotice,
    );
  }

  waitOn(taskId: number, who: string): void {
    store.updateTask(taskId, { waiting_on: who.trim() || null });
    store.addTurn({
      taskId,
      role: TurnRole.trigger,
      body: who.trim()
        ? `Waiting on ${who.trim()}`
        : "No longer waiting on anyone",
    });
  }

  readResult(taskId: number): void {
    const task = store.getTask(taskId);
    if (task?.unread_result) store.updateTask(taskId, { unread_result: 0 });
  }

  readFyi(messageId: number): void {
    store.markMessageRead(messageId);
  }

  // An FYI that was work after all: it becomes a task and teaches triage.
  fyiToTask(messageId: number): TaskRow | null {
    const m = store.getMessage(messageId);
    if (!m) return null;
    const task = store.batch(() => {
      const created = store.createTask({
        title: m.title.slice(0, 120) || m.body.slice(0, 80),
        summary: m.body.slice(0, 300),
        kind: Kind.general,
        threadKey: m.thread_key,
        channel: m.channel,
        url: m.url,
        triageReason: "you made it a task",
        createdAt: m.received_at,
      });
      store.fileMessage(
        m.id,
        Verdict.general,
        "you made it a task",
        created.id,
      );
      store.markMessageRead(m.id);
      store.addTurn({
        taskId: created.id,
        role: TurnRole.incoming,
        author: m.author_name,
        body: m.body,
        messageId: m.id,
        startedAt: m.received_at,
      });
      return created;
    });
    correct(
      {
        messageId,
        taskId: task.id,
        what: "FYI was work: made it a task",
        before: "fyi",
        after: "general",
      },
      this.learnedNotice,
    );
    return task;
  }

  dismissIdea(ideaId: number): void {
    store.setIdeaStatus(ideaId, "dismissed");
  }

  ideaToTask(ideaId: number): TaskRow | null {
    const idea = store.openIdeas().find((i) => i.id === ideaId);
    if (!idea) return null;
    store.setIdeaStatus(ideaId, "tasked");
    return this.newTask(idea.title, Kind.task, idea.body);
  }

  remember(line: string): void {
    const text = readDoc(DocName.learned);
    const marker = "## What you care about";
    const at = text.indexOf(marker);
    const next =
      at === -1
        ? `${text.trimEnd()}\n\n${marker}\n- ${line}\n`
        : text.replace(marker, `${marker}\n- ${line}`);
    writeDoc(DocName.learned, next);
  }
}
