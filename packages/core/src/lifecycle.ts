// The agent lifecycle, once. A task's agent_state is a summary of its newest
// session, and both move together through a handful of named transitions.
// Everything that starts, hears from, ends or finishes an agent calls one of
// these; nothing else writes agent_state. Its rules: an agent ready for
// review stays so while it winds down, closing a task stops whatever was live
// on it, and a session that ends for any reason leaves the task stopped with
// Continue. docs/rail-status-design.md has the states and how they move.

import { now } from "./db";
import * as store from "./store";
import {
  AgentState,
  TaskStatus,
  TimerKind,
  TurnRole,
  type SessionKind,
  type SessionRow,
} from "./types";

// A task and the session acting on it: what every hook and turn knows.
export interface AgentRef {
  taskId: number;
  sessionId: string;
}

export const HELD_FOR_START = "held for you: press Start";

// A coding task waits for the owner's Start; nothing runs it by itself.
export function holdForStart(taskId: number): void {
  store.updateTask(taskId, {
    agent_state: AgentState.queued,
    queue_reason: HELD_FOR_START,
  });
}

// The hold a kind change put on, taken back (ctrl+z): it never started, so
// there is nothing to continue.
export function holdReleased(taskId: number): void {
  const task = store.getTask(taskId);
  if (
    task?.agent_state === AgentState.queued &&
    task.queue_reason === HELD_FOR_START
  ) {
    store.updateTask(taskId, {
      agent_state: AgentState.none,
      queue_reason: null,
    });
  }
}

// Held back by the pool's limit, with the reason the rail shows.
export function queued(taskId: number, reason: string): void {
  store.updateTask(taskId, {
    agent_state: AgentState.queued,
    queue_reason: reason,
  });
}

// Start was taken back before it ran: nothing to continue, nothing lost.
export function startCancelled(taskId: number): void {
  const task = store.getTask(taskId);
  if (task?.agent_state === AgentState.queued) {
    store.updateTask(taskId, {
      agent_state: AgentState.stopped,
      queue_reason: null,
    });
  }
}

export interface StartedSession {
  id: string;
  taskId: number;
  kind: SessionKind;
  cwd: string;
  startedBy: SessionRow["started_by"];
  tmuxWindow?: string | null;
}

// A session begins, or a saved one is picked up again under the same id. The
// task is working from here, open again if it had been put away.
export function sessionStarted(s: StartedSession): SessionRow {
  return store.batch(() => {
    if (store.getSession(s.id)) {
      store.updateSession(s.id, {
        state: AgentState.working,
        ended_at: null,
        says: null,
        kind: s.kind,
        cwd: s.cwd,
        tmux_window: s.tmuxWindow ?? null,
        end_reason: null,
      });
    } else {
      store.createSession({
        id: s.id,
        taskId: s.taskId,
        kind: s.kind,
        cwd: s.cwd,
        startedBy: s.startedBy,
        tmuxWindow: s.tmuxWindow,
      });
    }
    const task = store.getTask(s.taskId);
    if (task && task.status !== TaskStatus.open) {
      store.reopen(s.taskId);
    }
    store.updateTask(s.taskId, {
      agent_state: AgentState.working,
      queue_reason: null,
      agent_says: null,
      unread_result: 0,
    });
    return store.getSession(s.id)!;
  });
}

// A live agent did something: a tool, a question, a notification, its prompt,
// or its turn ended. Once it has said it is finished (ready for review), its
// winding down is not news; only new work (working) takes it out of ready.
export type LiveState =
  | typeof AgentState.working
  | typeof AgentState.idle
  | typeof AgentState.waiting;

export function sessionActivity(
  ref: AgentRef,
  state: LiveState,
  says: string | null,
  lastTool?: string,
): void {
  const task = store.getTask(ref.taskId);
  if (!task) {
    return;
  }
  if (task.agent_state === AgentState.ready && state !== AgentState.working) {
    return;
  }
  store.batch(() => {
    store.updateSession(ref.sessionId, {
      state,
      says,
      ...(lastTool ? { last_tool: lastTool } : {}),
    });
    store.updateTask(ref.taskId, { agent_state: state, agent_says: says });
  });
}

// A turn is over: the agent asks something (waiting) or rests at its prompt
// (idle).
export function turnEnded(ref: AgentRef, asking: string | null): void {
  sessionActivity(ref, asking ? AgentState.waiting : AgentState.idle, asking);
}

// Why a session came to an end. However it ended, the task is stopped and s
// resumes it; the reason is what the Canvas and the row say about it.
export const EndReason = {
  stop: "you stopped it",
  closed: "you closed the task",
  window: "its window closed",
  exited: "claude exited",
  restart: "Riker restarted",
  cancelled: "start taken back",
  adopted: "running outside Riker",
} as const;

// A task whose agent had already finished keeps ready: the result still
// waits on the owner. Closed work is left as closing left it.
export function sessionEnded(ref: AgentRef, reason: string): void {
  const task = store.getTask(ref.taskId);
  const finished = task?.agent_state === AgentState.ready;
  store.batch(() => {
    store.updateSession(ref.sessionId, {
      state: finished ? AgentState.ready : AgentState.stopped,
      ended_at: now(),
      end_reason: reason,
    });
    if (!task || finished || task.status === TaskStatus.done) {
      return;
    }
    store.updateTask(ref.taskId, {
      agent_state: AgentState.stopped,
      agent_says: null,
    });
  });
}

// A chat turn came back: the agent's answer is ready for review, or it is
// waiting on an answer.
// A chat agent has no idle: its process is gone once the turn is.
export function turnFinished(
  ref: AgentRef,
  outcome: { asking: string | null; at?: string },
): void {
  const at = outcome.at ?? now();
  store.batch(() => {
    store.updateTask(ref.taskId, {
      agent_state: outcome.asking ? AgentState.waiting : AgentState.ready,
      agent_says: outcome.asking,
    });
    store.updateSession(ref.sessionId, {
      state: AgentState.ready,
      ended_at: at,
    });
  });
}

// A coding agent said it is done: ready for review. Its session keeps
// running until claude exits (sessionEnded then leaves ready in place). When
// nothing waits on the owner the agent closes the task, and it stays on the
// rail until the result is read; otherwise it is open and ready until the
// owner closes it (or new work starts the agent again).
export function workFinished(
  ref: AgentRef,
  outcome: { summary: string; closes: boolean },
): void {
  const task = store.getTask(ref.taskId);
  if (!task) {
    return;
  }
  store.batch(() => {
    store.updateSession(ref.sessionId, {
      state: AgentState.ready,
      result: outcome.summary,
    });
    store.updateTask(ref.taskId, {
      agent_state: AgentState.ready,
      agent_says: null,
      unread_result: 1,
      ...(outcome.closes
        ? { status: TaskStatus.done, closed_at: now(), closed_by: "agent" }
        : {}),
    });
    if (task.status !== TaskStatus.done) {
      store.tellFromTask(
        task,
        outcome.closes ? "finished" : "finished; it waits for the owner",
        outcome.summary,
      );
    }
    if (outcome.closes) {
      blockerResolved(ref.taskId);
    }
  });
}

// Mark done always does the same things: closed, unsent draft retired, any
// live agent stopped (the caller stops its process), off the rail.
export function taskClosed(taskId: number, by = "you"): void {
  store.batch(() => {
    store.retirePendingActions(taskId);
    const task = store.getTask(taskId);
    if (task && task.status !== TaskStatus.done) {
      store.tellFromTask(
        task,
        `marked done by ${by}`,
        store.latestSession(taskId)?.result ?? null,
      );
    }
    const agentLive =
      task &&
      (task.agent_state === AgentState.working ||
        task.agent_state === AgentState.idle ||
        task.agent_state === AgentState.waiting ||
        task.agent_state === AgentState.queued);
    store.updateTask(taskId, {
      status: TaskStatus.done,
      closed_at: now(),
      closed_by: by,
      unread_result: 0,
      watching: 0,
      remind_at: null,
      ...(agentLive ? { agent_state: AgentState.stopped } : {}),
    });
    // The work is over: what it was waiting to do goes with it. A schedule
    // stays, and opens it again on its next time.
    store.cancelTimers(taskId, [TimerKind.followup, TimerKind.remind]);
    for (const session of store
      .liveSessions()
      .filter((s) => s.task_id === taskId)) {
      store.updateSession(session.id, {
        ended_at: now(),
        state: AgentState.stopped,
        end_reason: EndReason.closed,
      });
    }
    blockerResolved(taskId);
  });
}

// Not a task after all: gone from the rail, and nothing waits on it. Its
// chat says who dropped it and why, since the rail no longer shows it.
export function taskDropped(taskId: number, by = "you", why = ""): void {
  store.batch(() => {
    store.updateTask(taskId, {
      status: TaskStatus.dropped,
      closed_at: now(),
      closed_by: by,
    });
    store.cancelTimers(taskId, [
      TimerKind.followup,
      TimerKind.schedule,
      TimerKind.remind,
    ]);
    store.addTurn({
      taskId,
      role: TurnRole.trigger,
      body: `Dropped by ${by} (ignore)${why.trim() ? `: ${why.trim()}` : ""}. d reopens it.`,
    });
    blockerResolved(taskId);
  });
}

// Open again, by the owner's say: no agent starts (Start does that).
export function taskReopened(taskId: number, by = "you"): void {
  const task = store.getTask(taskId);
  if (!task) {
    return;
  }
  const was = task.status;
  store.batch(() => {
    store.reopen(taskId);
    store.addTurn({
      taskId,
      role: TurnRole.trigger,
      body: `Reopened by ${by} (was ${was})`,
    });
  });
}

// New work landed on a task whose agent was ready for review: that result is
// read, and the task is nobody's until an agent picks it up again.
export function finishSuperseded(taskId: number): void {
  const task = store.getTask(taskId);
  if (task?.agent_state === AgentState.ready) {
    store.updateTask(taskId, {
      agent_state: AgentState.none,
      unread_result: 0,
    });
  }
}

// A task others wait on is done or dropped: each of them hears it, and is
// unblocked by it. What still blocks one is named.
export function blockerResolved(blockerId: number): void {
  const blocker = store.getTask(blockerId);
  if (!blocker) {
    return;
  }
  const how = blocker.status === TaskStatus.dropped ? "dropped" : "done";
  store.batch(() => {
    for (const dependent of store.dependentsOf(blockerId)) {
      store.removeBlocker(dependent, blockerId);
      const left = store.blockersOf(dependent).map((id) => store.taskRef(id));
      store.addTurn({
        taskId: dependent,
        role: TurnRole.trigger,
        body: `${store.taskRef(blockerId)} ${how}: ${blocker.title}; ${
          left.length
            ? `still blocked by ${left.join(", ")}`
            : "nothing blocks this now"
        }`,
      });
    }
  });
}

// Its branch landed: ready to clean up, and still the owner's to close.
export function workMerged(taskId: number, how: string): void {
  store.batch(() => {
    store.updateTask(taskId, { merged_at: now() });
    store.addTurn({
      taskId,
      role: TurnRole.trigger,
      body: `Merged ${how}; ready to clean up (d marks it done and removes its worktree)`,
    });
  });
}

// New work on a branch that had landed: open again.
export function mergeUndone(taskId: number): void {
  store.batch(() => {
    store.updateTask(taskId, { merged_at: null });
    store.addTurn({
      taskId,
      role: TurnRole.trigger,
      body: "Its branch has work that is not merged yet",
    });
  });
}

// The draft an agent was waiting on went out: it is no longer asking.
export function draftSent(taskId: number): void {
  const task = store.getTask(taskId);
  if (task?.agent_state === AgentState.waiting) {
    store.updateTask(taskId, { agent_says: null });
  }
}

// Sessions alive when Riker last quit are not alive now, except in tmux, which
// keeps coding agents up across restarts (reconcile asks it which still are).
// A chat turn cut off reads as stopped, with Continue.
export function recoverAtBoot(
  isRunning: (taskId: number) => boolean,
  survives: (session: SessionRow) => boolean,
): void {
  store.batch(() => {
    for (const s of store.liveSessions()) {
      if (survives(s)) {
        continue;
      }
      sessionEnded({ taskId: s.task_id, sessionId: s.id }, EndReason.restart);
    }
    for (const task of store.listTasks()) {
      // The queue that held it waiting its turn died with the last Riker.
      if (
        task.agent_state === AgentState.queued &&
        task.queue_reason !== HELD_FOR_START
      ) {
        holdForStart(task.id);
      }
      if (
        task.agent_state === AgentState.working &&
        !store.liveSessions().some((s) => s.task_id === task.id) &&
        !isRunning(task.id)
      ) {
        store.updateTask(task.id, { agent_state: AgentState.stopped });
      }
    }
  });
}
