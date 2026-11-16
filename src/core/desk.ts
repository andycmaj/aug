// Every move the owner makes, once: the buttons in the TUI, the verbs the
// Assistant and agents ask for through aug-tools, and the tests all come
// here. The desk changes the store, teaches LEARNED.md from corrections, and
// hands agent work to the task's driver. It runs nothing on a clock: the
// engine does, and owns a desk.

import { DocName, readDoc, writeDoc } from "./docs";
import {
  acceptProposals,
  hasOpenProposals,
  onboardingTask,
  ONBOARD_TASK,
  redraftProposals,
  rejectProposals,
  systemTask,
} from "./proposals";
import {
  inTmux,
  type CloseResult,
  type Drivers,
  type StartOptions,
  type StartResult,
} from "./driver";
import { nudgeText } from "./feedback";
import { correct } from "./learn";
import { holdForStart, taskClosed, taskDropped } from "./lifecycle";
import type { AugConfig, ConfigSource, NoiseRule } from "./config";
import { now } from "./db";
import * as projects from "./projects";
import { applyProjectDoc, renderProjectDoc } from "./project-doc";
import { editPending, sendPending } from "./outbound";
import * as repos from "./repos";
import { briefEditable } from "./read-model";
import * as store from "./store";
import { adoptStray, findStrays, type Stray } from "./strays";
import {
  AgentState,
  IdeaStatus,
  Kind,
  Priority,
  TaskStatus,
  TurnRole,
  Verdict,
  type NoteLabel,
  type TaskRow,
} from "./types";

// How the owner signs what they write on the Board.
const OWNER = "you";
const HOOKS_OFFERED = "hooks.offered";

export interface DeskOptions {
  drivers: Drivers;
  config: ConfigSource;
  // Fixture mode never touches your real settings (the hooks offer).
  offline?: boolean;
  onLearned?: (line: string) => void;
}

export class Desk {
  constructor(private options: DeskOptions) {}

  private learnedNotice = (line: string) => this.options.onLearned?.(line);

  private get drivers(): Drivers {
    return this.options.drivers;
  }

  get offline(): boolean {
    return Boolean(this.options.offline);
  }

  // Read each time a setting is used, so an edit to config.json (or a move
  // below) applies without a restart.
  config(): AugConfig {
    return this.options.config.get();
  }

  // ── config ────────────────────────────────────────────────────────────

  // A noise pattern triage reads on the next message.
  addNoise(rule: NoiseRule): void {
    this.options.config.update((c) => ({
      ...c,
      triage: { ...c.triage, noise: [...c.triage.noise, rule] },
    }));
  }

  // ── tasks ─────────────────────────────────────────────────────────────

  newTask(
    title: string,
    kind: Kind,
    summary = "",
    place: Pick<store.NewTask, "projectId" | "repo" | "fromTaskId" | "goalId"> = {},
  ): TaskRow {
    const task = store.createTask({
      title,
      kind,
      summary,
      channel: "owner",
      ...place,
    });
    if (kind === Kind.coding) holdForStart(task.id);
    return store.getTask(task.id) ?? task;
  }

  // The brief is what the agent starts from. Once it has started, a new
  // brief would say something the agent never read: tell it instead.
  briefEditable(taskId: number): boolean {
    return briefEditable(taskId);
  }

  editBrief(taskId: number, text: string): boolean {
    if (!text.trim() || !this.briefEditable(taskId)) return false;
    store.updateTask(taskId, { summary: text.trim() });
    return true;
  }

  // ── the task's agent ──────────────────────────────────────────────────

  // Typing always continues: same agent, same conversation, whether it is
  // working, finished or stopped. A closed task's chat reopens it. The line
  // is recorded as pending until the agent has it; a coding claude that is
  // not running hears it at its next start. True when the agent has it now.
  async say(taskId: number, text: string): Promise<boolean> {
    const task = store.getTask(taskId);
    if (!task || !text.trim()) return false;
    // A SYSTEM task has no agent: what you type is notes on its proposal.
    if (task.kind === Kind.system) {
      void this.redraftDocs(taskId, text);
      return true;
    }
    store.batch(() => {
      if (task.status !== TaskStatus.open) store.reopen(taskId);
      store.addTurn({
        taskId,
        role: TurnRole.you,
        author: "you",
        body: text.trim(),
        pending: true,
      });
      store.updateTask(taskId, { unread_result: 0 });
    });
    return this.drivers.for(task).deliver(task);
  }

  // Start, or continue, the task's agent. What a coding start still needs
  // comes back as `needs`; the caller asks the owner and calls again.
  async startAgent(
    taskId: number,
    opts: StartOptions = {},
  ): Promise<StartResult> {
    const task = store.getTask(taskId);
    if (!task) return { type: "failed", error: `no task ${taskId}` };
    if (task.kind === Kind.system && !inTmux(task))
      return {
        type: "failed",
        error: "a System task has no agent: y accepts, x rejects",
      };
    return this.drivers.for(task).start(task, opts);
  }

  // The owner's Stop: stopped, and Start resumes it.
  async stopAgent(taskId: number): Promise<void> {
    const task = store.getTask(taskId);
    if (task) await this.drivers.for(task).stop(task);
  }

  // Mark done: the task closes first, then its agent's leavings go (a
  // coding task's window and worktree).
  async close(taskId: number): Promise<CloseResult> {
    const task = store.getTask(taskId);
    if (!task) return { warnings: [], archived: false };
    taskClosed(taskId);
    return this.drivers.for(task).close(task);
  }

  // Whether an agent is at work on it now.
  isLive(task: TaskRow): boolean {
    return this.drivers.for(task).isLive(task);
  }

  // One line into the agent's window pointing it at its feedback.
  nudge(taskId: number): Promise<boolean> {
    return projects.nudge(taskId, nudgeText(taskId));
  }

  // ── projects ──────────────────────────────────────────────────────────

  createProject(name: string, repo?: string | null) {
    return projects.createProject(this.config(), { name, repo });
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

  // Claudes started outside aug, and making one a task in a project.
  async strays(): Promise<Stray[]> {
    // The fixture day never reads your real claudes.
    return this.offline ? [] : findStrays();
  }

  async adoptStray(stray: Stray, projectId: number): Promise<TaskRow> {
    const project = store.getProject(projectId);
    if (!project) throw new Error(`no project ${projectId}`);
    return adoptStray(this.config(), stray, project);
  }

  // The project's file as the owner edits it, and what writing it back did.
  projectDoc(projectId: number): string | null {
    const project = store.getProject(projectId);
    return project ? renderProjectDoc(project, this.config()) : null;
  }

  editProject(projectId: number, text: string): string {
    return applyProjectDoc(this.options.config, projectId, text, "you");
  }

  setTaskRepo(taskId: number, repo: string) {
    repos.setTaskRepo(taskId, repo);
  }

  // ── repos and their checkouts ─────────────────────────────────────────

  repoReport(fresh = false) {
    return repos.repoReport(this.config(), fresh);
  }

  // Where a repo is checked out, so a start that asked for it can run.
  mapRepo(repo: string, path: string) {
    repos.mapRepo(this.options.config, repo, path);
  }

  unmapRepo(repo: string) {
    repos.unmapRepo(this.options.config, repo);
  }

  cloneRepo(repo: string, dest?: string) {
    return repos.cloneRepo(this.options.config, repo, dest);
  }

  renameRepo(from: string, to: string) {
    return repos.renameRepo(this.options.config, from, to);
  }

  allowMismatch(repo: string, path: string) {
    repos.allowMismatch(repo, path);
  }

  removeProjectRepo(projectId: number, repo: string) {
    store.removeProjectRepo(projectId, repo);
  }

  moveTask(taskId: number, projectId: number) {
    return projects.moveTask(this.config(), taskId, projectId);
  }

  jumpToProject(projectId: number) {
    return projects.jumpToProject(this.config(), projectId);
  }

  // Your own tmux client, moved to the task's window.
  jumpToTask(taskId: number) {
    return projects.jump(taskId);
  }

  // argv for the embedded terminal on the task's window.
  viewer(taskId: number) {
    return projects.viewerArgv(taskId);
  }

  // ── drafts ────────────────────────────────────────────────────────────

  async send(taskId: number): Promise<string> {
    return sendPending(this.config(), taskId);
  }

  editDraft(taskId: number, text: string): boolean {
    const before = editPending(taskId, text);
    if (before === null) return false;
    correct(
      this.config(),
      { taskId, what: "edited the draft before sending", before, after: text },
      this.learnedNotice,
    );
    return true;
  }

  redraft(taskId: number, instruction: string): void {
    const pending = store.pendingAction(taskId);
    correct(
      this.config(),
      {
        taskId,
        what: "asked for a redraft",
        before: pending?.turn.action ?? null,
        note: instruction,
      },
      this.learnedNotice,
    );
    store.retirePendingActions(taskId);
    void this.say(taskId, `Redraft the reply: ${instruction}`);
  }

  // ── the task's place on the rail ──────────────────────────────────────

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
      this.config(),
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
      this.config(),
      {
        taskId,
        what: "Not a task: should have been FYI",
        before: task.kind,
        after: "fyi",
        note: why || null,
      },
      this.learnedNotice,
    );
    if (worked) void this.close(taskId);
    else {
      void this.drivers.for(task).stop(task);
      taskDropped(taskId);
      for (const m of store.messagesForTask(taskId))
        store.fileMessage(m.id, Verdict.fyi, "you said: not a task", null);
    }
  }

  setPriority(taskId: number, priority: Priority): void {
    const task = store.getTask(taskId);
    if (!task || task.priority === priority) return;
    store.updateTask(taskId, { priority, priority_pinned: 1 });
    correct(
      this.config(),
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
    store.batch(() => {
      store.updateTask(taskId, { kind });
      if (kind === Kind.coding && task.agent_state === AgentState.none)
        holdForStart(taskId);
    });
    correct(
      this.config(),
      {
        taskId,
        what: "changed what kind of work it is",
        before: task.kind,
        after: kind,
      },
      this.learnedNotice,
    );
  }

  // A task waits on others; each is told nothing, the waiting one hears
  // when they close (lifecycle.blockerResolved).
  blockOn(taskId: number, blockerId: number, by: string): string {
    const task = store.getTask(taskId);
    const blocker = store.getTask(blockerId);
    if (!task || !blocker) throw new Error(`no task ${store.taskRef(blockerId)}`);
    if (taskId === blockerId) throw new Error("a task cannot wait on itself");
    if (blocker.status === TaskStatus.done || blocker.status === TaskStatus.dropped)
      throw new Error(`${store.taskRef(blockerId)} is ${blocker.status} already`);
    if (waitsOn(blockerId, taskId))
      throw new Error(`${store.taskRef(blockerId)} already waits on ${store.taskRef(taskId)}`);
    store.batch(() => {
      store.addBlocker(taskId, blockerId, by);
      store.addTurn({
        taskId,
        role: TurnRole.trigger,
        body: `Blocked by ${store.taskRef(blockerId)}: ${blocker.title}`,
      });
    });
    return `${store.taskRef(taskId)} is blocked by ${store.taskRef(blockerId)}`;
  }

  // No blocker: all of them.
  unblock(taskId: number, blockerId?: number): string {
    const had = store.blockersOf(taskId);
    const gone = blockerId === undefined ? had : had.filter((id) => id === blockerId);
    if (gone.length === 0) return `${store.taskRef(taskId)} was not blocked by that`;
    store.batch(() => {
      store.removeBlocker(taskId, blockerId);
      store.addTurn({
        taskId,
        role: TurnRole.trigger,
        body: `No longer blocked by ${gone.map((id) => store.taskRef(id)).join(", ")}`,
      });
    });
    return `${store.taskRef(taskId)} is no longer blocked by ${gone.map((id) => store.taskRef(id)).join(", ")}`;
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

  // ── FYIs and ideas ────────────────────────────────────────────────────

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
      this.config(),
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
    store.setIdeaStatus(ideaId, IdeaStatus.dismissed);
  }

  ideaToTask(ideaId: number): TaskRow | null {
    const idea = store.openIdeas().find((i) => i.id === ideaId);
    if (!idea) return null;
    store.setIdeaStatus(ideaId, IdeaStatus.tasked);
    return this.newTask(idea.title, Kind.task, idea.body);
  }

  // ── brain docs (System tasks) ─────────────────────────────────────────

  // y on a System task: the onboarding offer starts its interview; anything
  // else writes the proposed docs.
  acceptDocs(taskId: number): string {
    const task = store.getTask(taskId);
    if (!task || task.kind !== Kind.system) return "not a System task";
    if (!hasOpenProposals(taskId) && onboardingTask()?.id === taskId)
      return this.onboard();
    return this.closedDocs(task, acceptProposals(taskId));
  }

  rejectDocs(taskId: number): string {
    const task = store.getTask(taskId);
    if (!task || task.kind !== Kind.system) return "not a System task";
    return this.closedDocs(task, rejectProposals(taskId));
  }

  // A System task y or x closed takes its interview's window with it.
  private closedDocs(task: TaskRow, said: string): string {
    if (store.getTask(task.id)?.status !== TaskStatus.open && inTmux(task))
      void this.drivers.for(task).close(task);
    return said;
  }

  // Your notes on a proposal (from revdiff, or typed on the task) go back to
  // be redrafted.
  redraftDocs(taskId: number, notes: string): Promise<string> {
    return redraftProposals(this.config(), taskId, notes);
  }

  // The onboarding interview: interactive claude in the System task's own
  // window (its canvas shows it), which reads what it can, asks the rest,
  // and hands drafts in on the same task. Again, it resumes that session.
  onboard(): string {
    let task = onboardingTask();
    if (!task) {
      task = systemTask(
        "Your docs: the interview",
        "aug interviews you in this task's terminal; its drafts land here.",
      );
      store.kvSet(ONBOARD_TASK, String(task.id));
    }
    const ref = store.taskRef(task.id);
    const started = task;
    void this.drivers
      .for(started)
      .start(started, { noWorktree: true })
      .then((result) => {
        if (result.type !== "failed" && result.type !== "needs") return;
        store.addTurn({
          taskId: started.id,
          role: TurnRole.trigger,
          body: `Could not start the interview: ${result.type === "failed" ? result.error : `it needs a ${result.need.what}`}. y tries again.`,
        });
      });
    return `the interview is starting in ${ref}`;
  }

  // A line the owner said, written straight into LEARNED.md.
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

  // ── the Board's notes and knowledge ───────────────────────────────────

  note(label: NoteLabel, body: string): void {
    store.addNote(OWNER, label, body);
  }

  readNotes(): void {
    store.markNotesRead(OWNER);
  }

  addKnowledge(topic: string, title: string, body: string): void {
    store.addKnowledge(topic, title, body, OWNER);
  }

  // The hooks are offered once, with the first project made or adopted.
  offerHooksOnce(): boolean {
    if (store.kvGet(HOOKS_OFFERED)) return false;
    store.kvSet(HOOKS_OFFERED, "1");
    return true;
  }
}

// Whether from waits on to, directly or through the tasks it waits on.
function waitsOn(from: number, to: number, seen = new Set<number>()): boolean {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return store.blockersOf(from).some((id) => waitsOn(id, to, seen));
}
