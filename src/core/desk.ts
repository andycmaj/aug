// Every move the owner makes, once: the buttons in the TUI, the verbs the
// Assistant and agents ask for through aug-tools, and the tests all come
// here. The desk changes the store, teaches LEARNED.md from corrections, and
// hands agent work to the task's driver. It runs nothing on a clock: the
// engine does, and owns a desk.

import { DocName, readDoc, writeDoc } from "./docs";
import {
  type CloseResult,
  type Drivers,
  type StartOptions,
  type StartResult,
} from "./driver";
import { nudgeText } from "./feedback";
import { correct } from "./learn";
import { holdForStart, taskClosed } from "./lifecycle";
import { now } from "./db";
import * as projects from "./projects";
import { editPending, sendPending } from "./outbound";
import { setTaskRepo } from "./repos";
import * as store from "./store";
import {
  AgentState,
  IdeaStatus,
  Kind,
  Priority,
  TaskStatus,
  TurnRole,
  Verdict,
  type TaskRow,
} from "./types";

export interface DeskOptions {
  drivers: Drivers;
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

  // ── tasks ─────────────────────────────────────────────────────────────

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
    if (kind === Kind.coding) holdForStart(task.id);
    return store.getTask(task.id) ?? task;
  }

  // The brief is what the agent starts from. Once it has started, a new
  // brief would say something the agent never read: tell it instead.
  briefEditable(taskId: number): boolean {
    const task = store.getTask(taskId);
    return (
      Boolean(task) && task?.kind !== Kind.home && !store.latestSession(taskId)
    );
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
    return this.drivers.for(task).start(task, opts);
  }

  // The owner's Stop: saved, so Start resumes it.
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
    setTaskRepo(taskId, repo);
  }

  moveTask(taskId: number, projectId: number) {
    return projects.moveTask(taskId, projectId);
  }

  jumpToProject(projectId: number) {
    return projects.jumpToProject(projectId);
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
    if (worked) void this.close(taskId);
    else {
      void this.drivers.for(task).stop(task);
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
    store.batch(() => {
      store.updateTask(taskId, { kind });
      if (kind === Kind.coding && task.agent_state === AgentState.none)
        holdForStart(taskId);
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
}
