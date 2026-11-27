// Every move the owner makes, once: the buttons in the TUI, the verbs the
// Assistant and agents ask for through riker-tools, and the tests all come
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
import {
  holdForStart,
  taskClosed,
  taskDropped,
  taskReopened,
} from "./lifecycle";
import { localDay, MAX_WINS, readFolds, writeFolds } from "./rail";
import type { RikerConfig, ConfigSource, NoiseRule } from "./config";
import { now } from "./db";
import { unmergedWork, type NotMerged } from "./merge";
import * as projects from "./projects";
import { applyProjectDoc, renderProjectDoc } from "./project-doc";
import { Drafts, editPending, sendPending } from "./outbound";
import * as repos from "./repos";
import type { PathNeed } from "./repos";
import { briefEditable } from "./read-model";
import * as store from "./store";
import { adoptStray, findStrays, type Stray } from "./strays";
import {
  guideReview,
  hasGuideReview,
  startAction,
  type ActionResult,
} from "./run-action";
import { ReviewEnd, reviewExit } from "./guide-turn";
import { capReached } from "./spend";
import {
  ActionEvent,
  ActionVia,
  actionNamed,
  invocation,
  makesCheckout,
  registeredActions,
  triggeredBy,
  whyNot,
  whyNotOffered,
  type ActionSpec,
} from "./task-actions";
import {
  revert,
  snapshot,
  taskDraft,
  UndoStack,
  type UndoDraft,
  type UndoResult,
} from "./undo";
import type {
  MoveGuard,
  ReviewSource,
  Triage,
  TriageEffect,
  TriageOutcome,
} from "./plugins";
import { reviewedPr } from "./pr";
import {
  AgentState,
  IdeaStatus,
  Kind,
  MessageState,
  PROJECT_MOVE,
  Priority,
  ProjectStatus,
  SessionKind,
  TaskStatus,
  TimerKind,
  TimerState,
  TurnRole,
  Verdict,
  type MessageRow,
  type ProjectRow,
  type TaskRow,
  type TimerRow,
} from "./types";
import { addFollowup, addSchedule } from "./timers";
import {
  journalSwitch,
  storySwitch,
  switchColumn,
  switchWords,
  SwitchValue,
} from "./digests";
import { JournalSave, readJournal, saveJournalEdit } from "./journal";
import { editStory, pin, storyMarkdown, undoStory } from "./story";
import { errorMessage, logger } from "./log";

export { NoJump, type Jump } from "./projects";

const log = logger("desk");

export type RetriageResult =
  | { ok: true; outcome: TriageOutcome }
  | { ok: false; why: string };

// How the owner signs what they write on the Board.
const OWNER = "you";
const HOOKS_OFFERED = "hooks.offered";
const RAIL_FOLDS = "rail.folded";

export interface DeskOptions {
  drivers: Drivers;
  config: ConfigSource;
  // Fixture mode never touches your real settings (the hooks offer).
  offline?: boolean;
  onLearned?: (line: string) => void;
  // The inbox's judge (core/plugins.ts); without one, r and m say so.
  triage?: Triage;
  // The plugins' kinds of draft: how one is worded, edited and sent.
  drafts?: Drafts;
  // Moves that wait for the owner's yes (core/moves.ts asks each).
  guards?: readonly MoveGuard[];
  // Where the guide reads a PR's context, on a review asked of the owner.
  reviews?: ReviewSource;
}

export class Desk {
  readonly drafts: Drafts;

  constructor(private options: DeskOptions) {
    this.drafts = options.drafts ?? new Drafts();
  }

  private learnedNotice = (line: string) => this.options.onLearned?.(line);

  private get drivers(): Drivers {
    return this.options.drivers;
  }

  get offline(): boolean {
    return Boolean(this.options.offline);
  }

  // What a move must answer instead of running (held for a yes), if any.
  guardMove(
    verb: string,
    args: Record<string, string>,
    by: string,
  ): string | null {
    for (const guard of this.options.guards ?? []) {
      const held = guard(verb, args, by);
      if (held !== null) {
        return held;
      }
    }
    return null;
  }

  // ctrl+z: this session's moves, newest first (core/undo.ts).
  readonly undos = new UndoStack();

  async undo(): Promise<UndoResult> {
    const entry = this.undos.pop();
    if (!entry) {
      return { ok: false, text: "Nothing to undo" };
    }
    return revert(this.config(), entry);
  }

  // A change to one task, kept for ctrl+z with what the task was before.
  private onTask<T>(
    what: string,
    taskId: number,
    fn: () => T,
    at = new Date(),
  ): T {
    const day = localDay(at);
    const before = snapshot(taskId, day);
    return this.undos.track(fn, () => taskDraft(what, taskId, day, before));
  }

  // A move ctrl+z cannot take back: kept, so it says so rather than reach
  // past it to an older one.
  private cannot<T>(what: string, why: string, fn: () => T): T {
    return this.undos.track(fn, () => ({ type: "cannot", what, why }));
  }

  private cannotAsync<T>(
    what: string,
    why: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    return this.undos.trackAsync(fn, () => ({ type: "cannot", what, why }));
  }

  // Read each time a setting is used, so an edit to config.json (or a move
  // below) applies without a restart.
  config(): RikerConfig {
    return this.options.config.get();
  }

  // ── config ────────────────────────────────────────────────────────────

  // A noise pattern triage reads on the next message.
  addNoise(rule: NoiseRule): void {
    this.cannot("noise", "it is a filter in config.json: remove it there", () =>
      this.options.config.update((c) => ({
        ...c,
        triage: { ...c.triage, noise: [...c.triage.noise, rule] },
      })),
    );
  }

  // A noise filter made from an Inbox message: saved for the next message,
  // and this one filed as FYI under it. A pattern that does not compile is
  // answered now, not skipped at triage time.
  noiseFromMessage(messageId: number, rule: NoiseRule): string | null {
    if (!rule.reason.trim()) {
      return "a noise filter needs a reason";
    }
    if (!rule.author && !rule.title && !rule.body && !rule.githubReason) {
      return "a noise filter needs a pattern";
    }
    for (const field of ["author", "title", "body"] as const) {
      const pattern = rule[field];
      if (pattern === undefined) {
        continue;
      }
      try {
        new RegExp(pattern, "i");
      } catch {
        return `${field} is not a regex: ${pattern}`;
      }
    }
    this.addNoise(rule);
    const m = store.getMessage(messageId);
    if (m && m.task_id === null) {
      store.fileMessage(m.id, Verdict.fyi, rule.reason, null);
      store.markMessageRead(m.id);
    }
    return null;
  }

  // ── tasks ─────────────────────────────────────────────────────────────

  newTask(
    title: string,
    kind: Kind,
    summary = "",
    place: Pick<
      store.NewTask,
      "projectId" | "repo" | "fromTaskId" | "goalId"
    > = {},
  ): TaskRow {
    return this.undos.track(() => {
      const task = store.createTask({
        title,
        kind,
        summary,
        channel: "owner",
        ...place,
      });
      if (kind === Kind.coding) {
        holdForStart(task.id);
      }
      return store.getTask(task.id) ?? task;
    }, madeTask);
  }

  // The brief is what the agent starts from. Once it has started, a new
  // brief would say something the agent never read: tell it instead.
  briefEditable(taskId: number): boolean {
    return briefEditable(taskId);
  }

  editBrief(taskId: number, text: string): boolean {
    if (!text.trim() || !this.briefEditable(taskId)) {
      return false;
    }
    this.onTask("brief", taskId, () =>
      store.updateTask(taskId, { summary: text.trim() }),
    );
    return true;
  }

  // ── the task's agent ──────────────────────────────────────────────────

  // Typing always continues: same agent, same conversation, whether it is
  // working, finished or stopped. A closed task's chat reopens it. The line
  // is recorded as pending until the agent has it; a coding claude that is
  // not running hears it at its next start. True when the agent has it now.
  // `author` says where the line came from: a plugin's remote says
  // heardVia(place).
  async say(taskId: number, text: string, author = "you"): Promise<boolean> {
    const task = store.getTask(taskId);
    if (!task || !text.trim()) {
      return false;
    }
    // A SYSTEM task has no agent: what you type is notes on its proposal.
    if (task.kind === Kind.system) {
      void this.redraftDocs(taskId, text);
      return true;
    }
    store.batch(() => {
      if (task.status !== TaskStatus.open) {
        store.reopen(taskId);
      }
      store.addTurn({
        taskId,
        role: TurnRole.you,
        author,
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
    if (!task) {
      return { type: "failed", error: `no task ${taskId}` };
    }
    if (task.kind === Kind.system && !inTmux(task)) {
      return {
        type: "failed",
        error: "a System task has no agent: y accepts, x rejects",
      };
    }
    // A start can take seconds (a worktree, a window, claude's launch) with
    // nothing to show yet; a second one in that gap would launch another
    // agent. Held until the first answers, whatever it answers.
    if (this.startingTasks.has(taskId)) {
      return { type: "starting" };
    }
    this.setStarting(taskId, true);
    try {
      return await this.undos.trackAsync(
        () => this.drivers.for(task).start(task, opts),
        (r) =>
          r.type === "started" || r.type === "queued"
            ? {
                type: "cannot",
                what: `start ${store.taskRef(taskId)}`,
                why: "it started an agent",
              }
            : null,
      );
    } finally {
      this.setStarting(taskId, false);
    }
  }

  // Tasks whose start is in flight, in this process only: the TUI and the
  // moves both start through this desk, and a start never outlives it.
  private startingTasks = new Set<number>();
  private startingListeners = new Set<(ids: ReadonlySet<number>) => void>();

  isStarting(taskId: number): boolean {
    return this.startingTasks.has(taskId);
  }

  onStarting(listener: (ids: ReadonlySet<number>) => void): () => void {
    this.startingListeners.add(listener);
    return () => this.startingListeners.delete(listener);
  }

  private setStarting(taskId: number, on: boolean): void {
    if (on) {
      this.startingTasks.add(taskId);
    } else {
      this.startingTasks.delete(taskId);
    }
    const ids: ReadonlySet<number> = new Set(this.startingTasks);
    for (const listener of this.startingListeners) {
      listener(ids);
    }
  }

  // The owner's Stop: stopped, and Start resumes it.
  async stopAgent(taskId: number): Promise<void> {
    const task = store.getTask(taskId);
    if (task) {
      await this.cannotAsync(
        `stop ${store.taskRef(taskId)}`,
        "it stopped an agent: s starts it again",
        () => this.drivers.for(task).stop(task),
      );
    }
  }

  // What is not merged yet, for the owner's yes before done.
  async unmergedWork(taskId: number): Promise<NotMerged | null> {
    const task = store.getTask(taskId);
    return task ? unmergedWork(this.config(), task) : null;
  }

  // Mark done: the task closes first, then its agent's leavings go (a
  // coding task's window and worktree). Undone, it is open again; a project
  // it archived is not brought back, so that one cannot be undone.
  async close(taskId: number): Promise<CloseResult> {
    const task = store.getTask(taskId);
    if (!task) {
      return { warnings: [], archived: false };
    }
    const day = localDay(new Date());
    const before = snapshot(taskId, day);
    return this.undos.trackAsync(
      () => {
        taskClosed(taskId);
        return this.drivers.for(task).close(task);
      },
      (r) =>
        r.archived
          ? {
              type: "cannot",
              what: `done ${store.taskRef(taskId)}`,
              why: "it archived its project",
            }
          : taskDraft("done", taskId, day, before),
    );
  }

  // Whether an agent is at work on it now.
  isLive(task: TaskRow): boolean {
    return this.drivers.for(task).isLive(task);
  }

  // A task action (core/task-actions.ts): started now, its answer a turn on
  // the task. Nothing to undo: an action reads, and its turn stays.
  // `whole`: the guide on a PR asked of the owner reviews all of it, not
  // only what changed since their last review.
  runAction(
    taskId: number,
    name: string,
    opts: { whole?: boolean } = {},
  ):
    | { error: string }
    | { title: string; turnId?: number; done: Promise<ActionResult> } {
    const task = store.getTask(taskId);
    if (!task) {
      return { error: `no task ${store.taskRef(taskId)}` };
    }
    const config = this.config();
    const spec = actionNamed(config, name);
    if (!spec) {
      const names = registeredActions(config).map((a) => a.name);
      return {
        error: `no action ${name}: there are ${names.join(", ") || "none"}`,
      };
    }
    const why = whyNot(spec, task);
    if (why) {
      return { error: why };
    }
    return this.startAction(config, task, spec, undefined, opts.whole);
  }

  // What an action offered on a task still needs before runAction: its
  // worktree, made on the task's branch with no agent started (a review that
  // just arrived has none). `needs` asks the owner where the repo is checked
  // out, as Start does; the caller asks and calls again. Never run by itself:
  // the owner's key, the picker or a move asks for it.
  async prepareAction(
    taskId: number,
    name: string,
  ): Promise<
    | { type: "ready" }
    | { type: "needs"; need: PathNeed }
    | { type: "failed"; error: string }
  > {
    const task = store.getTask(taskId);
    if (!task) {
      return { type: "failed", error: `no task ${store.taskRef(taskId)}` };
    }
    const spec = actionNamed(this.config(), name);
    if (!spec) {
      return { type: "failed", error: `no action ${name}` };
    }
    const why = whyNotOffered(spec, task);
    if (why) {
      return { type: "failed", error: why };
    }
    if (!makesCheckout(spec, task)) {
      return { type: "ready" };
    }
    const made = await this.cannotAsync(
      `checkout ${store.taskRef(taskId)}`,
      "it made a worktree",
      () => projects.ensureCheckout(this.config(), taskId),
    );
    if (made.type === "needs-path") {
      return { type: "needs", need: made.need };
    }
    if (made.type === "failed") {
      return made;
    }
    return { type: "ready" };
  }

  // The task's last guide, reopened in Plannotator with its findings and no
  // model run (@riker/code-review-plannotator). Nothing to undo: it opens a review.
  hasGuideReview(taskId: number): boolean {
    const task = store.getTask(taskId);
    return !!task && hasGuideReview(task);
  }

  // A PR someone asked the owner to review (triage marked it), not their own.
  askedReview(taskId: number): boolean {
    const task = store.getTask(taskId);
    return !!task && reviewedPr(task) !== null;
  }

  guideReview(taskId: number): ActionResult | { error: string } {
    const task = store.getTask(taskId);
    if (!task) {
      return { error: `no task ${store.taskRef(taskId)}` };
    }
    return guideReview(task);
  }

  // A guide's review closed (`output` is what plannotator printed). A
  // review posted to GitHub is the end of an asked-for review: the task
  // closes. A bare Approve of your own work sends nothing, and says so on
  // the task. Notes go to the agent; one whose session ended is resumed
  // with them, since sending them is the owner's word to go on. Returns a
  // line for the toast.
  async finishReview(
    taskId: number,
    posts: "github" | undefined,
    output: string,
  ): Promise<{ text: string; failed?: boolean } | null> {
    const task = store.getTask(taskId);
    if (!task) {
      return null;
    }
    const ref = store.taskRef(taskId);
    const { end, notes, status } = reviewExit(posts, output);
    if (end === ReviewEnd.posted) {
      const closed = await this.close(taskId);
      const warn = closed.warnings.length
        ? ` (${closed.warnings.join("; ")})`
        : "";
      return { text: `${ref}: ${status}; closed${warn}` };
    }
    if (end === ReviewEnd.approved) {
      store.addTurn({ taskId, role: TurnRole.trigger, body: status! });
      return { text: `${ref}: ${status}` };
    }
    if (!notes) {
      return status ? { text: `${ref}: ${status}` } : null;
    }
    const heard = await this.say(
      taskId,
      `My notes from the guided review in Plannotator (with the review findings riker posted there that I kept):\n\n${notes}`,
    );
    if (heard) {
      return { text: `Your review notes went to ${ref}'s agent` };
    }
    const started = await this.startAgent(taskId);
    if (started.type === "started" || started.type === "queued") {
      return { text: `${ref}'s agent resumed with your review notes` };
    }
    if (started.type === "needs") {
      return {
        text: `Your review notes are on ${ref}: s starts its agent with them`,
      };
    }
    if (started.type === "starting") {
      return {
        text: `Your review notes are on ${ref}; its agent was already starting`,
      };
    }
    return {
      text: `Your review notes are on ${ref}, but its agent did not start: ${started.error}`,
      failed: true,
    };
  }

  private startAction(
    config: RikerConfig,
    task: TaskRow,
    spec: ActionSpec,
    event?: ActionEvent,
    whole = false,
  ):
    | { error: string }
    | { title: string; turnId?: number; done: Promise<ActionResult> } {
    if (spec.via === ActionVia.agent) {
      const text = invocation(spec, task);
      return {
        title: spec.title,
        done: this.say(task.id, text).then((ok) => ({
          ok,
          text: ok
            ? `${spec.title}: told the agent`
            : `${spec.name}: the agent did not get it`,
        })),
      };
    }
    const pr = reviewedPr(task);
    const run = startAction(
      config,
      task,
      spec,
      event,
      pr && this.options.reviews
        ? { pr, source: this.options.reviews, whole }
        : undefined,
    );
    if ("error" in run) {
      return run;
    }
    return { title: spec.title, turnId: run.turnId, done: run.done };
  }

  // Actions an event runs by itself (their `on` triggers): each once per
  // task, action and event (a run the spend cap or an error kept from
  // starting is not counted), one at a time behind each other. What it opens for the owner (the guide's review)
  // waits for them to open it. Returns the names queued.
  private autoRuns: Promise<void> = Promise.resolve();

  fireActions(
    event: ActionEvent,
    taskId: number,
    message?: MessageRow | null,
  ): string[] {
    const task = store.getTask(taskId);
    if (!task || task.kind === Kind.home) {
      return [];
    }
    const queued: string[] = [];
    for (const spec of triggeredBy(this.config(), event, task, message)) {
      if (!store.claimActionRun(taskId, spec.name, event)) {
        continue;
      }
      queued.push(spec.name);
      this.autoRuns = this.autoRuns
        .then(async () => {
          const config = this.config();
          const fresh = store.getTask(taskId);
          if (!fresh) {
            return;
          }
          // A run that never started is not kept as run: the next such
          // event tries again.
          if (capReached(config)) {
            store.releaseActionRun(taskId, spec.name, event);
            log.info("auto action skipped: spend cap", {
              task: taskId,
              action: spec.name,
              event,
            });
            return;
          }
          const started = this.startAction(config, fresh, spec, event);
          if ("error" in started) {
            store.releaseActionRun(taskId, spec.name, event);
            log.warn("auto action not started", {
              task: taskId,
              action: spec.name,
              event,
              error: started.error,
            });
            return;
          }
          await started.done;
        })
        .catch((err: unknown) =>
          log.error("auto action failed", {
            task: taskId,
            action: spec.name,
            err,
          }),
        );
    }
    return queued;
  }

  // Waits for the auto actions queued so far (tests, shutdown).
  actionsSettled(): Promise<void> {
    return this.autoRuns;
  }

  // What a triage outcome sets off: its effects, and the actions it
  // triggers. Not for the owner's own message on a thread.
  afterTriage(outcome: TriageOutcome, message: MessageRow | null): void {
    this.runEffects(outcome.effects);
    // Your own line and a timer are not something that came in.
    if (
      outcome.taskId === null ||
      outcome.verdict === "own" ||
      outcome.verdict === "timer"
    ) {
      return;
    }
    this.fireActions(ActionEvent.triaged, outcome.taskId, message);
  }

  // One line into the agent's window pointing it at its feedback.
  nudge(taskId: number): Promise<boolean> {
    return projects.nudge(taskId, nudgeText(taskId));
  }

  // ── projects ──────────────────────────────────────────────────────────

  createProject(name: string, repo?: string | null) {
    return this.cannotAsync(`project_new ${name}`, "it made a project", () =>
      projects.createProject(this.config(), { name, repo }),
    );
  }

  adoptableSessions() {
    return projects.adoptableSessions();
  }

  adoptSession(sessionId: string) {
    return this.cannotAsync("adopt", "it adopted a tmux session", () =>
      projects.adoptSession(sessionId),
    );
  }

  archiveProject(projectId: number) {
    const name = store.getProject(projectId)?.name ?? String(projectId);
    return this.cannotAsync(
      `project_archive ${name}`,
      "it archived a project",
      () => projects.archiveProject(projectId),
    );
  }

  // Claudes started outside Riker, and making one a task in a project.
  async strays(): Promise<Stray[]> {
    // The fixture day never reads your real claudes.
    return this.offline ? [] : findStrays();
  }

  async adoptStray(stray: Stray, projectId: number): Promise<TaskRow> {
    const project = store.getProject(projectId);
    if (!project) {
      throw new Error(`no project ${projectId}`);
    }
    return this.cannotAsync("adopt", "it adopted a claude", () =>
      adoptStray(this.config(), stray, project),
    );
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

  // A task triage made, moved to another project, teaches triage where
  // such work goes. A running agent's window moves with it; a task that
  // never started has no window to move or session to wake. A goal belongs
  // to one project: the task leaves it behind. Undone, it goes back, unless
  // the move archived the project it left.
  async moveTask(taskId: number, projectId: number): Promise<void> {
    const task = store.getTask(taskId);
    if (!task) {
      return;
    }
    const from = task.project_id ? store.getProject(task.project_id) : null;
    const day = localDay(new Date());
    const before = snapshot(taskId, day);
    await this.undos.trackAsync(
      () => this.placeTask(task, projectId),
      () =>
        from?.status === ProjectStatus.active &&
        store.getProject(from.id)?.status === ProjectStatus.archived
          ? {
              type: "cannot",
              what: `project ${store.taskRef(taskId)}`,
              why: `it archived project ${from.name}`,
            }
          : taskDraft("project", taskId, day, before),
    );
  }

  private async placeTask(task: TaskRow, projectId: number): Promise<void> {
    const taskId = task.id;
    if (
      task.triage_reason &&
      task.channel !== "owner" &&
      task.project_id !== projectId
    ) {
      const before = task.project_id
        ? store.getProject(task.project_id)?.name
        : null;
      correct(
        this.config(),
        {
          taskId,
          what: PROJECT_MOVE,
          before: before ?? "no project",
          after: store.getProject(projectId)?.name ?? String(projectId),
        },
        this.learnedNotice,
      );
    }
    if (store.latestSession(taskId)?.kind === SessionKind.tmux) {
      await projects.moveTask(this.config(), taskId, projectId);
    } else {
      store.updateTask(taskId, { project_id: projectId });
    }
    const goal = task.goal_id ? store.getGoal(task.goal_id) : null;
    if (goal && goal.project_id !== projectId) {
      store.updateTask(taskId, { goal_id: null });
    }
  }

  retitle(taskId: number, title: string): void {
    this.onTask("retitle", taskId, () =>
      store.updateTask(taskId, { title: title.trim() }),
    );
  }

  link(taskId: number, url: string, title: string | null, by: string) {
    return this.onTask("link", taskId, () =>
      store.addTaskLink(taskId, url, title, by),
    );
  }

  unlink(taskId: number, url: string): boolean {
    return this.onTask("unlink", taskId, () =>
      store.removeTaskLink(taskId, url),
    );
  }

  // ── a project's manager (core/manager.ts) ─────────────────────────────

  // The owner talks to a project on its row: its manager is made the first
  // time, and every line after continues the same conversation.
  async sayToProject(
    projectId: number,
    text: string,
    author = "you",
  ): Promise<boolean> {
    if (!text.trim() || !store.getProject(projectId)) {
      return false;
    }
    const manager = store.ensureManager(projectId);
    return this.say(manager.id, text, author);
  }

  ensureManager(projectId: number): TaskRow {
    return store.ensureManager(projectId);
  }

  // A task already overseeing the project (an overview, an epic) becomes its
  // manager, keeping its chat. Its agent turns headless from here, so a
  // running one is stopped first.
  promoteManager(
    taskId: number,
    by = "you",
  ): { ok: true; project: ProjectRow } | { ok: false; why: string } {
    const task = store.getTask(taskId);
    if (!task) {
      return { ok: false, why: `no task ${taskId}` };
    }
    const ref = store.taskRef(taskId);
    if (task.kind === Kind.manager) {
      return { ok: false, why: `${ref} is already a manager` };
    }
    if (task.kind === Kind.home || task.kind === Kind.system) {
      return { ok: false, why: `${ref} is Riker's own, not project work` };
    }
    const project = task.project_id ? store.getProject(task.project_id) : null;
    if (!project) {
      return {
        ok: false,
        why: `${ref} is in no project: move it into one first`,
      };
    }
    const had = store.managerOf(project.id);
    if (had) {
      return {
        ok: false,
        why: `${project.name} already has a manager (${store.taskRef(had.id)})`,
      };
    }
    if (this.drivers.for(task).isLive(task)) {
      return { ok: false, why: `${ref}'s agent is running: stop it first` };
    }
    this.onTask("make manager", taskId, () =>
      store.batch(() => {
        if (task.status !== TaskStatus.open) {
          store.reopen(taskId);
        }
        store.updateTask(taskId, {
          kind: Kind.manager,
          agent_state: AgentState.none,
          agent_says: null,
          unread_result: 0,
        });
        store.addTurn({
          taskId,
          role: TurnRole.trigger,
          body: `Made ${project.name}'s manager by ${by}`,
        });
      }),
    );
    return { ok: true, project };
  }

  // Where the project stands, in its manager's or the owner's words.
  setStanding(projectId: number, text: string, by = "you"): void {
    store.updateProject(projectId, {
      standing: text.trim(),
      standing_at: now(),
    });
    const manager = store.managerOf(projectId);
    if (manager && !by.startsWith("manager ")) {
      store.addTurn({
        taskId: manager.id,
        role: TurnRole.trigger,
        body: `${by} wrote the standing:\n${text.trim()}`,
      });
    }
  }

  // A project's doc off the project: only Riker's row goes.
  unlinkProject(projectId: number, url: string): boolean {
    return store.removeProjectLink(projectId, url);
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
    return this.cannotAsync(
      `send ${store.taskRef(taskId)}`,
      "it sent the draft",
      async () => {
        return sendPending(this.config(), taskId, this.drafts);
      },
    );
  }

  editDraft(taskId: number, text: string): boolean {
    const before = this.cannot(
      `edit ${store.taskRef(taskId)}`,
      "the draft is edited again, not undone",
      () => editPending(taskId, text, this.drafts),
    );
    if (before === null) {
      return false;
    }
    correct(
      this.config(),
      { taskId, what: "edited the draft before sending", before, after: text },
      this.learnedNotice,
    );
    return true;
  }

  redraft(taskId: number, instruction: string): void {
    this.cannot(
      `redraft ${store.taskRef(taskId)}`,
      "it asked the agent for a new draft",
      () => {
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
      },
    );
  }

  // ── the task's place on the rail ──────────────────────────────────────

  remind(taskId: number, days: number, by = this.undos.by()): string {
    return this.onTask("remind", taskId, () => {
      const at = new Date();
      at.setDate(at.getDate() + Math.max(1, Math.round(days)));
      at.setHours(7, 0, 0, 0);
      store.remindAt(taskId, at.toISOString(), by);
      return at.toISOString();
    });
  }

  // ── timers (core/timers.ts) ───────────────────────────────────────────

  // Wake the task's agent at a time, once, with what to do then.
  followup(
    taskId: number,
    at: Date,
    note: string,
    by = this.undos.by(),
  ): TimerRow {
    return this.onTask("follow-up", taskId, () =>
      addFollowup(taskId, at, note, by),
    );
  }

  // Wake it on a rule ("weekdays 09:00"), every time.
  schedule(
    taskId: number,
    rule: string,
    note: string,
    by = this.undos.by(),
  ): TimerRow {
    return this.onTask("schedule", taskId, () =>
      addSchedule(taskId, rule, note, by),
    );
  }

  // Its follow-ups and schedules, or one of them, cancelled. A reminder is
  // the owner's put-away: d brings the task back instead.
  unschedule(taskId: number, timerId?: number): TimerRow[] {
    return this.onTask("unschedule", taskId, () => {
      const gone = store
        .timersForTask(taskId)
        .filter(
          (t) =>
            t.kind !== TimerKind.remind &&
            (timerId === undefined || t.id === timerId),
        );
      for (const t of gone) {
        store.setTimerState(t.id, TimerState.cancelled);
      }
      return gone;
    });
  }

  watch(taskId: number, on: boolean): void {
    this.onTask(on ? "watch" : "unwatch", taskId, () => {
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
    });
  }

  // Ignore: dropped if nothing was done on it, otherwise Mark done. Either
  // way ctrl+z takes it back. Nothing is learned from it: what an ignore
  // teaches is the owner's to say, and learning from every x put lines in
  // LEARNED.md from tasks triage never saw.
  async ignore(taskId: number, why = ""): Promise<void> {
    const task = store.getTask(taskId);
    if (!task) {
      return;
    }
    const worked = store
      .turnsForTask(taskId)
      .some((t) => t.role === TurnRole.agent || t.role === TurnRole.you);
    if (worked) {
      await this.close(taskId);
      return;
    }
    this.onTask("ignore", taskId, () => {
      const by = this.undos.by();
      void this.drivers.for(task).stop(task);
      taskDropped(taskId, by, why);
      for (const m of store.messagesForTask(taskId)) {
        store.fileMessage(m.id, Verdict.fyi, `ignored by ${by}`, null);
      }
    });
  }

  // A done or dropped task open again. Its agent does not start: s does.
  reopen(taskId: number): string {
    const task = store.getTask(taskId);
    if (!task) {
      return `no task ${taskId}`;
    }
    const ref = store.taskRef(taskId);
    // Refused inside onTask too, so a reopen that changed nothing is no entry.
    return this.onTask("reopen", taskId, () => {
      if (
        task.status !== TaskStatus.done &&
        task.status !== TaskStatus.dropped
      ) {
        return `${ref} is not done or dropped`;
      }
      taskReopened(taskId, this.undos.by());
      return `${ref} is open again${inTmux(task) ? "; s starts its agent" : ""}`;
    });
  }

  setPriority(taskId: number, priority: Priority): void {
    this.onTask("priority", taskId, () => {
      const task = store.getTask(taskId);
      if (!task || task.priority === priority) {
        return;
      }
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
    });
  }

  setKind(taskId: number, kind: Kind): void {
    this.onTask("kind", taskId, () => {
      const task = store.getTask(taskId);
      if (!task || task.kind === kind) {
        return;
      }
      store.batch(() => {
        store.updateTask(taskId, { kind });
        if (kind === Kind.coding && task.agent_state === AgentState.none) {
          holdForStart(taskId);
        }
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
    });
  }

  // Today's Wins: at most MAX_WINS, pinned or unpinned by the owner.
  setWin(
    taskId: number,
    on: boolean,
    at = new Date(),
  ): { ok: boolean; text: string } {
    return this.onTask(
      on ? "win" : "unwin",
      taskId,
      () => {
        const day = localDay(at);
        const wins = store.winsOn(day);
        const ref = store.taskRef(taskId);
        if (!on) {
          if (!wins.includes(taskId)) {
            return { ok: true, text: `${ref} is not a Win today` };
          }
          store.removeWin(day, taskId);
          return { ok: true, text: `${ref} is no longer a Win today` };
        }
        if (wins.includes(taskId)) {
          return { ok: true, text: `${ref} is a Win today already` };
        }
        if (wins.length >= MAX_WINS) {
          return {
            ok: false,
            text: `Today has ${MAX_WINS} Wins: unpin one first`,
          };
        }
        store.addWin(day, taskId);
        return {
          ok: true,
          text: `${ref} is a Win today (${wins.length + 1}/${MAX_WINS})`,
        };
      },
      at,
    );
  }

  // A task's story on, off, or back to its project's and config's say.
  setStory(taskId: number, value: SwitchValue): string {
    return this.onTask("story", taskId, () => {
      store.updateTask(taskId, { story: switchColumn(value) });
      const task = store.getTask(taskId)!;
      return `${store.taskRef(taskId)} ${switchWords("story", storySwitch(this.config(), task))}`;
    });
  }

  // A project's journal, or the default for its tasks' stories.
  setProjectSwitch(
    projectId: number,
    which: "journal" | "story",
    value: SwitchValue,
  ): string {
    return this.cannot(
      which,
      "a project's switches are not kept for undo; set it back",
      () => {
        store.updateProject(projectId, { [which]: switchColumn(value) });
        const project = store.getProject(projectId)!;
        if (which === "journal") {
          return `${project.name} ${switchWords("journal", journalSwitch(this.config(), project))}`;
        }
        const said = value === SwitchValue.default ? "follows config" : value;
        return `${project.name}: its tasks' stories ${said} unless a task says otherwise`;
      },
    );
  }

  // The owner's line on a task's story, or one taken off. Each is a new
  // version; story_undo steps back.
  pinStory(taskId: number, line: string, off: boolean): string {
    return this.cannot(
      off ? "unpin" : "pin",
      "a story keeps every version; story_undo steps back one",
      () => {
        const v = pin(taskId, line, off);
        const ref = store.taskRef(taskId);
        if (!v) {
          return off ? `${ref}: no such pinned line` : `${ref}: pinned already`;
        }
        return off ? `${ref}: unpinned` : `${ref}: pinned`;
      },
    );
  }

  // The story as markdown for the owner's reader and $EDITOR, with when
  // and by whom; null when no session has been written up yet.
  storyDoc(taskId: number, all = false): { text: string; asOf: string } | null {
    const v = store.currentStory(taskId);
    if (!v) {
      return null;
    }
    return {
      text: storyMarkdown(v, all),
      asOf: `${v.at.slice(0, 16).replace("T", " ")} by ${v.by}`,
    };
  }

  // Every part's heading with nothing under it: a story the owner starts.
  storyTemplate(): string {
    return storyMarkdown(null, true);
  }

  // The owner's rewrite of a story, from $EDITOR: a new version.
  editStory(taskId: number, text: string): { ok: boolean; text: string } {
    return this.cannot(
      "story edit",
      "a story keeps every version; story_undo steps back one",
      () => {
        const ref = store.taskRef(taskId);
        const said = editStory(taskId, text);
        if ("error" in said) {
          return { ok: false, text: `${ref}: story not saved: ${said.error}` };
        }
        if (!said.version) {
          return { ok: true, text: `${ref}: story unchanged` };
        }
        return {
          ok: true,
          text: `${ref}: story saved as a new version (story_undo steps back)`,
        };
      },
    );
  }

  // A project's journal file and what it says, for the reader and $EDITOR.
  journal(projectId: number): { file: string; text: string } | null {
    const project = store.getProject(projectId);
    return project ? readJournal(project) : null;
  }

  // The owner's journal edit, made on a copy opened at `base`: laid over
  // the file as it is now, so an entry written meanwhile is kept.
  saveJournal(
    projectId: number,
    base: string,
    edited: string,
  ): { ok: boolean; text: string } {
    const project = store.getProject(projectId);
    if (!project) {
      return { ok: false, text: "That project is gone" };
    }
    return this.cannot(
      "journal edit",
      "it is a file: edit it again to take it back",
      () => {
        const said = saveJournalEdit(project, base, edited);
        const name = `${project.name} journal`;
        switch (said) {
          case JournalSave.unchanged:
            return { ok: true, text: `${name}: unchanged` };
          case JournalSave.saved:
            return { ok: true, text: `${name}: saved` };
          case JournalSave.merged:
            return {
              ok: true,
              text: `${name}: saved, with what Riker wrote while you edited`,
            };
          case JournalSave.conflict:
            return {
              ok: false,
              text: `${name}: not saved: Riker wrote to the lines you edited while you had it open`,
            };
        }
      },
    );
  }

  undoStory(taskId: number): string {
    return this.cannot(
      "story undo",
      "the version undone stays in the history",
      () => {
        const v = undoStory(taskId);
        const ref = store.taskRef(taskId);
        return v
          ? `${ref}: story back to the version before`
          : `${ref}: no earlier story version`;
      },
    );
  }

  toggleWin(taskId: number, at = new Date()): { ok: boolean; text: string } {
    return this.setWin(
      taskId,
      !store.winsOn(localDay(at)).includes(taskId),
      at,
    );
  }

  // A task waits on others; each is told nothing, the waiting one hears
  // when they close (lifecycle.blockerResolved).
  blockOn(taskId: number, blockerId: number, by: string): string {
    return this.onTask("block_on", taskId, () => {
      const task = store.getTask(taskId);
      const blocker = store.getTask(blockerId);
      if (!task || !blocker) {
        throw new Error(`no task ${store.taskRef(blockerId)}`);
      }
      if (taskId === blockerId) {
        throw new Error("a task cannot wait on itself");
      }
      if (
        blocker.status === TaskStatus.done ||
        blocker.status === TaskStatus.dropped
      ) {
        throw new Error(
          `${store.taskRef(blockerId)} is ${blocker.status} already`,
        );
      }
      if (waitsOn(blockerId, taskId)) {
        throw new Error(
          `${store.taskRef(blockerId)} already waits on ${store.taskRef(taskId)}`,
        );
      }
      store.batch(() => {
        store.addBlocker(taskId, blockerId, by);
        store.addTurn({
          taskId,
          role: TurnRole.trigger,
          body: `Blocked by ${store.taskRef(blockerId)}: ${blocker.title}`,
        });
      });
      return `${store.taskRef(taskId)} is blocked by ${store.taskRef(blockerId)}`;
    });
  }

  // No blocker: all of them.
  unblock(taskId: number, blockerId?: number): string {
    return this.onTask("unblock", taskId, () => {
      const had = store.blockersOf(taskId);
      const gone =
        blockerId === undefined ? had : had.filter((id) => id === blockerId);
      if (gone.length === 0) {
        return `${store.taskRef(taskId)} was not blocked by that`;
      }
      store.batch(() => {
        store.removeBlocker(taskId, blockerId);
        store.addTurn({
          taskId,
          role: TurnRole.trigger,
          body: `No longer blocked by ${gone.map((id) => store.taskRef(id)).join(", ")}`,
        });
      });
      return `${store.taskRef(taskId)} is no longer blocked by ${gone.map((id) => store.taskRef(id)).join(", ")}`;
    });
  }

  waitOn(taskId: number, who: string): void {
    this.onTask("wait_on", taskId, () => {
      store.updateTask(taskId, { waiting_on: who.trim() || null });
      store.addTurn({
        taskId,
        role: TurnRole.trigger,
        body: who.trim()
          ? `Waiting on ${who.trim()}`
          : "No longer waiting on anyone",
      });
    });
  }

  // The rail's folded projects outlive a restart. Stale ids are dropped on
  // the way in and out, so kv never keeps a project that is gone.
  foldedProjects(): Set<number> {
    return readFolds(store.kvGet(RAIL_FOLDS), this.activeProjectIds());
  }

  setFoldedProjects(folded: Set<number>): void {
    const live = new Set(this.activeProjectIds());
    store.kvSet(
      RAIL_FOLDS,
      writeFolds([...folded].filter((id) => live.has(id))),
    );
  }

  private activeProjectIds(): number[] {
    return store.listProjects().map((p) => p.id);
  }

  // The owner opened the task: a timer that fired on it stops ringing.
  seenTimers(taskId: number): void {
    store.silenceTimers(taskId);
  }

  readResult(taskId: number): void {
    const task = store.getTask(taskId);
    if (task?.unread_result) {
      store.updateTask(taskId, { unread_result: 0 });
    }
  }

  // ── FYIs and ideas ────────────────────────────────────────────────────

  // What triage asked for: wake the agents of the tasks it routed to.
  runEffects(effects: TriageEffect[]): void {
    for (const effect of effects) {
      const task = store.getTask(effect.taskId);
      if (!task) {
        continue;
      }
      if (effect.type === "timer") {
        this.timerFired(task, effect.turnId, effect.reason);
        continue;
      }
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

  // A follow-up or schedule came due (core/timers.ts): a chat agent runs a
  // turn on it; a coding agent hears its line in its window, or resumes
  // with it when it has a session to resume. One that never started keeps
  // the line for the owner's Start. A plain task has no agent to wake.
  private timerFired(task: TaskRow, turnId: number, reason: string): void {
    const driver = this.drivers.for(task);
    if (!inTmux(task)) {
      if (task.kind === Kind.general || task.kind === Kind.reply) {
        driver.wake(task, reason);
      }
      return;
    }
    store.setPending([turnId], true);
    if (driver.isLive(task)) {
      void driver.deliver(task);
    } else if (driver.resumes(task)) {
      void driver.start(task).catch((err: unknown) =>
        log.warn("timer resume failed", {
          task: task.id,
          err: errorMessage(err),
        }),
      );
    }
  }

  // Triage again, as a new run. A message on a task is refused: a second
  // pass could make a duplicate, and "ignore" is the way back. It is
  // claimed like the worker claims, so the two never triage it at once; a
  // failure here is the owner's to see, so it is not retried for them.
  async retriage(messageId: number): Promise<RetriageResult> {
    const message = store.getMessage(messageId);
    if (!message) {
      return { ok: false, why: "no such message" };
    }
    if (message.task_id !== null) {
      return {
        ok: false,
        why: `it is on ${store.taskRef(message.task_id)}: use ignore instead`,
      };
    }
    const judge = this.options.triage;
    if (!judge) {
      return { ok: false, why: "no triage is installed" };
    }
    if (!store.claimMessage(messageId)) {
      return { ok: false, why: "triage is running on it now" };
    }
    try {
      const outcome = await judge.again(message, this.config());
      this.afterTriage(outcome, message);
      return { ok: true, outcome };
    } catch (err) {
      store.settleMessage(messageId, MessageState.failed);
      throw err;
    }
  }

  // x on an Inbox message: read, so it leaves "actionable"; nothing else moves.
  readMessage(messageId: number): void {
    store.markMessageRead(messageId);
  }

  // A message triage held for you (no escalation rule named it): m makes the
  // task its verdict describes. Without one (an old run), it is made as an
  // FYI would be.
  heldToTask(messageId: number): TaskRow | null {
    return this.undos.track(() => {
      const message = store.getMessage(messageId);
      if (!message || message.task_id !== null) {
        return null;
      }
      const outcome = this.options.triage?.fromHeld(message, this.config());
      if (!outcome) {
        return this.fyiToTask(messageId);
      }
      this.afterTriage(outcome, message);
      return outcome.taskId === null ? null : store.getTask(outcome.taskId);
    }, madeTask);
  }

  // An FYI that was work after all: it becomes a task and teaches triage.
  fyiToTask(messageId: number): TaskRow | null {
    return this.undos.track(() => {
      const m = store.getMessage(messageId);
      if (!m) {
        return null;
      }
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
          before: m.verdict ?? "not triaged",
          after: "general",
        },
        this.learnedNotice,
      );
      return task;
    }, madeTask);
  }

  dismissIdea(ideaId: number): void {
    store.setIdeaStatus(ideaId, IdeaStatus.dismissed);
  }

  ideaToTask(ideaId: number): TaskRow | null {
    const idea = store.openIdeas().find((i) => i.id === ideaId);
    if (!idea) {
      return null;
    }
    const task = this.newTask(idea.title, Kind.task, idea.body);
    store.ideaTasked(ideaId, task.id);
    return task;
  }

  // ── brain docs (System tasks) ─────────────────────────────────────────

  // y on a System task: the onboarding offer starts its interview; anything
  // else writes the proposed docs.
  acceptDocs(taskId: number): string {
    return this.cannot(
      `accept ${store.taskRef(taskId)}`,
      "it wrote the proposed docs",
      () => {
        const task = store.getTask(taskId);
        if (!task || task.kind !== Kind.system) {
          return "not a System task";
        }
        if (!hasOpenProposals(taskId) && onboardingTask()?.id === taskId) {
          return this.onboard();
        }
        return this.closedDocs(task, acceptProposals(taskId));
      },
    );
  }

  rejectDocs(taskId: number): string {
    return this.cannot(
      `reject ${store.taskRef(taskId)}`,
      "it closed the proposal",
      () => {
        const task = store.getTask(taskId);
        if (!task || task.kind !== Kind.system) {
          return "not a System task";
        }
        return this.closedDocs(task, rejectProposals(taskId));
      },
    );
  }

  // A System task y or x closed takes its interview's window with it.
  private closedDocs(task: TaskRow, said: string): string {
    if (store.getTask(task.id)?.status !== TaskStatus.open && inTmux(task)) {
      void this.drivers.for(task).close(task);
    }
    return said;
  }

  // Your notes on a proposal (from revdiff, or typed on the task) go back to
  // be redrafted.
  redraftDocs(taskId: number, notes: string): Promise<string> {
    return redraftProposals(this.config(), taskId, notes);
  }

  // The onboarding interview: interactive claude in the System task's own
  // window (its Canvas shows it), which reads what it can, asks the rest,
  // and hands drafts in on the same task. Again, it resumes that session.
  onboard(): string {
    return this.cannot("onboard", "it started the interview", () => {
      let task = onboardingTask();
      if (!task) {
        task = systemTask(
          "Your docs: the interview",
          "riker interviews you in this task's terminal; its drafts land here.",
        );
        store.kvSet(ONBOARD_TASK, String(task.id));
      }
      const ref = store.taskRef(task.id);
      const started = task;
      void this.drivers
        .for(started)
        .start(started, { noWorktree: true })
        .then((result) => {
          if (result.type !== "failed" && result.type !== "needs") {
            return;
          }
          store.addTurn({
            taskId: started.id,
            role: TurnRole.trigger,
            body: `Could not start the interview: ${result.type === "failed" ? result.error : `it needs a ${result.need.what}`}. y tries again.`,
          });
        });
      return `the interview is starting in ${ref}`;
    });
  }

  // A line the owner said, written straight into LEARNED.md.
  remember(line: string): void {
    this.cannot("remember", "it wrote LEARNED.md: edit it there", () => {
      const text = readDoc(DocName.learned);
      const marker = "## What you care about";
      const at = text.indexOf(marker);
      const next =
        at === -1
          ? `${text.trimEnd()}\n\n${marker}\n- ${line}\n`
          : text.replace(marker, `${marker}\n- ${line}`);
      writeDoc(DocName.learned, next);
    });
  }

  // ── the Board's knowledge ─────────────────────────────────────────────

  addKnowledge(topic: string, title: string, body: string): void {
    store.addKnowledge(topic, title, body, OWNER);
  }

  // The hooks are offered once, with the first project made or adopted.
  offerHooksOnce(): boolean {
    if (store.kvGet(HOOKS_OFFERED)) {
      return false;
    }
    store.kvSet(HOOKS_OFFERED, "1");
    return true;
  }
}

// Whether from waits on to, directly or through the tasks it waits on.
// Making a task is not undone: ignore drops it.
function madeTask(task: TaskRow | null): UndoDraft | null {
  return task
    ? {
        type: "cannot",
        what: `new ${store.taskRef(task.id)}`,
        why: "a task made is not unmade: x (ignore) drops it",
      }
    : null;
}

function waitsOn(from: number, to: number, seen = new Set<number>()): boolean {
  if (from === to) {
    return true;
  }
  if (seen.has(from)) {
    return false;
  }
  seen.add(from);
  return store.blockersOf(from).some((id) => waitsOn(id, to, seen));
}
