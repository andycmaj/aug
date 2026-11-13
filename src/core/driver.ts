// One seam for "the task's agent", whichever kind it is. A general task's
// agent is a chat: headless claude turns run by the AgentPool. A coding
// task's agent is interactive claude in a tmux window (projects.ts). The
// engine, the moves and the TUI ask the task's driver to start, stop, close
// or tell it, and never branch on the kind themselves.

import type { AgentPool, CodingLaunch } from "./agents";
import { startCancelled } from "./lifecycle";
import { logger } from "./log";
import * as projects from "./projects";
import { repoChoices, repoPath } from "./repos";
import * as store from "./store";
import {
  Kind,
  SessionKind,
  TurnRole,
  type ProjectRow,
  type TaskRow,
} from "./types";

export interface StartOptions {
  // A line for the agent, typed with Start.
  note?: string;
  // Coding: the branch (new, existing, or pr:N). Left out, the driver asks.
  branch?: string;
  // Coding: work in a scratch folder with no worktree.
  noWorktree?: boolean;
}

// What a coding start still needs from the owner before it can run. The
// TUI turns each into a dialog, a move into words; neither decides it.
export type StartNeed =
  | { what: "repo"; choices: string[] }
  | { what: "path"; repo: string }
  | { what: "branch"; suggested: string };

export type StartResult =
  | { type: "started"; project: ProjectRow | null }
  // Agents at once is reached: it starts by itself when a slot frees.
  | { type: "queued"; reason: string }
  | { type: "needs"; need: StartNeed }
  | { type: "failed"; error: string };

export type CloseResult = projects.CloseResult;

export interface AgentDriver {
  start(task: TaskRow, opts?: StartOptions): Promise<StartResult>;
  // The owner's Stop: whatever is running ends, and Start resumes it.
  stop(task: TaskRow): Promise<void>;
  // After the task is closed: its processes and their leavings go.
  close(task: TaskRow): Promise<CloseResult>;
  // Hands the task's pending owner lines to the agent. True when it has
  // them now; false when they wait for the next start.
  deliver(task: TaskRow): Promise<boolean>;
  // Something arrived on the thread: aug runs the agent by itself, within
  // the pool's limit. A coding agent reads its thread when it asks to.
  wake(task: TaskRow, reason: string): void;
  // Whether an agent is at work on it right now, as far as aug knows
  // without asking tmux.
  isLive(task: TaskRow): boolean;
  // The session a Start would continue, if there is one.
  resumes(task: TaskRow): string | undefined;
}

export interface DriverOptions {
  pool: AgentPool;
  // Fixture mode has no checkouts: coding windows open in scratch.
  noWorktrees?: boolean;
  // Replaces the coding agent's command line (fixture mode's fake claude).
  launchOverride?: (task: TaskRow, launch: CodingLaunch) => CodingLaunch;
}

const NO_RESULT: CloseResult = { warnings: [], archived: false };
const log = logger("driver");

// Headless claude turns: general, reply, task, and Home (the Assistant).
export class ChatDriver implements AgentDriver {
  constructor(private pool: AgentPool) {}

  async start(task: TaskRow, opts: StartOptions = {}): Promise<StartResult> {
    // Home's agent answers what the owner says; Start would run it with
    // nothing new to answer.
    if (task.kind === Kind.home)
      return { type: "failed", error: "Home has nothing to start: type to it" };
    const note = opts.note?.trim();
    if (note)
      store.addTurn({
        taskId: task.id,
        role: TurnRole.you,
        author: "you",
        body: note,
      });
    this.heard(task);
    void this.pool.request(
      task.id,
      note ? "the owner sent it with a note" : "the owner pressed Start",
      "owner",
    );
    return { type: "started", project: null };
  }

  async stop(task: TaskRow): Promise<void> {
    this.pool.stop(task.id);
    startCancelled(task.id);
  }

  async close(task: TaskRow): Promise<CloseResult> {
    this.pool.stop(task.id);
    return NO_RESULT;
  }

  // A chat turn reads the whole conversation, so a line is heard as soon as
  // the next turn runs; typing starts one.
  async deliver(task: TaskRow): Promise<boolean> {
    this.heard(task);
    void this.pool.request(task.id, "the owner typed in the chat", "owner");
    return true;
  }

  wake(task: TaskRow, reason: string): void {
    void this.pool.request(task.id, reason, "aug");
  }

  isLive(task: TaskRow): boolean {
    return this.pool.isRunning(task.id);
  }

  resumes(task: TaskRow): string | undefined {
    return this.pool.resumes(task.id);
  }

  private heard(task: TaskRow): void {
    store.setPending(
      store.pendingTurns(task.id).map((t) => t.id),
      false,
    );
  }
}

// Interactive claude in a window of the task's project session.
export class TmuxDriver implements AgentDriver {
  constructor(private options: DriverOptions) {}

  private get pool(): AgentPool {
    return this.options.pool;
  }

  async start(task: TaskRow, opts: StartOptions = {}): Promise<StartResult> {
    const resume = this.resumes(task);
    const noWorktree = opts.noWorktree || Boolean(this.options.noWorktrees);
    // Resuming never asks again: the first start settled repo and branch.
    if (!noWorktree && !resume && !task.worktree) {
      if (!task.repo)
        return {
          type: "needs",
          need: { what: "repo", choices: repoChoices(task) },
        };
      if (!repoPath(task.repo))
        return { type: "needs", need: { what: "path", repo: task.repo } };
      if (opts.branch === undefined)
        return {
          type: "needs",
          need: {
            what: "branch",
            suggested: task.branch ?? projects.defaultBranch(task),
          },
        };
    }
    // A claude already running only hears the note: no new agent, no slot.
    if (this.isLive(task)) return this.launch(task, opts, noWorktree, resume);
    // Past Agents at once it waits its turn. The note waits as a pending
    // line, which the start that runs later sends in.
    let waited = false;
    const run = this.pool.claim(task.id, async () => {
      if (!waited) return this.launch(task, opts, noWorktree, resume);
      const result = await this.launch(
        task,
        { ...opts, note: undefined },
        noWorktree,
        this.resumes(task),
      );
      if (result.type !== "started") this.startFailed(task, result);
      return result;
    });
    if (run) return run;
    waited = true;
    const note = opts.note?.trim();
    if (note)
      store.addTurn({
        taskId: task.id,
        role: TurnRole.you,
        author: "you",
        body: note,
        pending: true,
      });
    return { type: "queued", reason: this.pool.waitReason() };
  }

  // A start that waited its turn has no one to answer: what stopped it goes
  // on the thread, and the task is left for the owner's Start.
  private startFailed(task: TaskRow, result: StartResult): void {
    const why =
      result.type === "failed"
        ? result.error
        : result.type === "needs"
          ? `it needs a ${result.need.what}`
          : "";
    log.error("queued start failed", { task: task.id, why });
    startCancelled(task.id);
    store.addTurn({
      taskId: task.id,
      role: TurnRole.trigger,
      body: `Could not start after waiting its turn: ${why}. Press Start to try again.`,
    });
  }

  private async launch(
    task: TaskRow,
    opts: StartOptions,
    noWorktree: boolean,
    resume: string | undefined,
  ): Promise<StartResult> {
    // What the owner typed while claude was not running goes in with the note.
    const pending = store.pendingTurns(task.id);
    const note = [...pending.map((t) => t.body), opts.note?.trim()]
      .filter(Boolean)
      .join("\n\n");
    const result = await projects.startTask(task.id, {
      note: note || undefined,
      branch: opts.branch?.trim() || undefined,
      noWorktree,
      resume,
      launchOverride: this.options.launchOverride,
    });
    switch (result.type) {
      case "started":
        store.setPending(
          pending.map((t) => t.id),
          false,
        );
        return { type: "started", project: result.project };
      case "needs-repo-path":
        return { type: "needs", need: { what: "path", repo: result.repo } };
      case "failed":
        return result;
    }
  }

  // A start still waiting its turn is taken back, as a chat's is.
  async stop(task: TaskRow): Promise<void> {
    if (this.pool.isWaiting(task.id)) {
      this.pool.stop(task.id);
      startCancelled(task.id);
    }
    await projects.stopTask(task.id);
  }

  close(task: TaskRow): Promise<CloseResult> {
    this.pool.stop(task.id);
    return projects.closeTask(task.id);
  }

  // Claimed before sending, so two lines typed at once are sent once.
  async deliver(task: TaskRow): Promise<boolean> {
    if (!(await projects.claudeWindow(task.id))) return false;
    const turns = store.pendingTurns(task.id);
    if (turns.length === 0) return true;
    const ids = turns.map((t) => t.id);
    store.setPending(ids, false);
    try {
      if (await projects.tell(task.id, turns.map((t) => t.body).join("\n\n")))
        return true;
    } catch {
      // The window went between the check and the send: the lines wait.
    }
    store.setPending(ids, true);
    return false;
  }

  // Its thread reaches it through `aug-tools feedback`, on the owner's nudge.
  wake(): void {}

  isLive(task: TaskRow): boolean {
    const latest = store.latestSession(task.id);
    return latest?.kind === SessionKind.tmux && !latest.ended_at;
  }

  resumes(task: TaskRow): string | undefined {
    const prior = store.latestSession(task.id);
    return prior?.kind === SessionKind.tmux ? prior.id : undefined;
  }
}

export class Drivers {
  private chat: ChatDriver;
  private tmux: TmuxDriver;

  constructor(options: DriverOptions) {
    this.chat = new ChatDriver(options.pool);
    this.tmux = new TmuxDriver(options);
  }

  for(task: TaskRow): AgentDriver {
    return task.kind === Kind.coding ? this.tmux : this.chat;
  }
}
