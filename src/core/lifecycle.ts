// The agent lifecycle, once. A task's agent_state is a summary of its newest
// session, and both move together through a handful of named transitions.
// Everything that starts, hears from, ends or finishes an agent calls one of
// these; nothing else writes agent_state. The rules that used to be scattered
// live here: a finished agent stays finished while it winds down, closing a
// task saves whatever was live on it, and a session that vanishes on open
// work leaves the task stopped with Continue.

import { now } from "./db";
import * as store from "./store";
import {
  AgentState,
  TaskStatus,
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
  if (task?.agent_state === AgentState.queued)
    store.updateTask(taskId, {
      agent_state: AgentState.saved,
      queue_reason: null,
    });
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
    if (task && task.status !== TaskStatus.open) store.reopen(s.taskId);
    store.updateTask(s.taskId, {
      agent_state: AgentState.working,
      queue_reason: null,
      agent_says: null,
      unread_result: 0,
    });
    return store.getSession(s.id)!;
  });
}

// A live agent did something: a tool, a question, a notification, its prompt.
// Once it has said it is finished, its winding down is not news.
export function sessionActivity(
  ref: AgentRef,
  state: typeof AgentState.working | typeof AgentState.blocked,
  says: string | null,
  lastTool?: string,
): void {
  const task = store.getTask(ref.taskId);
  if (!task) return;
  if (task.agent_state === AgentState.agentdone && state !== AgentState.working)
    return;
  store.batch(() => {
    store.updateSession(ref.sessionId, {
      state,
      says,
      ...(lastTool ? { last_tool: lastTool } : {}),
    });
    store.updateTask(ref.taskId, { agent_state: state, agent_says: says });
  });
}

// How a session came to an end. "saved" is the owner's Stop: it resumes.
// "stopped" is anything else: it crashed, its window went, claude exited. A
// task whose agent had already finished keeps that; closed work is left as
// closing left it.
export type SessionEnd = typeof AgentState.saved | typeof AgentState.stopped;

export function sessionEnded(ref: AgentRef, how: SessionEnd): void {
  const task = store.getTask(ref.taskId);
  const finished = task?.agent_state === AgentState.agentdone;
  store.batch(() => {
    store.updateSession(ref.sessionId, {
      state: finished ? AgentState.agentdone : how,
      ended_at: now(),
    });
    if (!task || finished || task.status === TaskStatus.done) return;
    store.updateTask(ref.taskId, { agent_state: how, agent_says: null });
  });
}

// A chat turn came back: the agent is finished, or waiting on an answer.
export function turnFinished(
  ref: AgentRef,
  outcome: { asking: string | null; at?: string },
): void {
  const at = outcome.at ?? now();
  store.batch(() => {
    store.updateTask(ref.taskId, {
      agent_state: outcome.asking ? AgentState.blocked : AgentState.agentdone,
      agent_says: outcome.asking,
    });
    store.updateSession(ref.sessionId, {
      state: AgentState.agentdone,
      ended_at: at,
    });
  });
}

// A coding agent said it is done. Its session keeps running until claude
// exits (sessionEnded then leaves the finish in place). The task is finished
// and, when nothing waits on the owner, closed by the agent; either way it
// stays on the rail until the result is read.
export function workFinished(
  ref: AgentRef,
  outcome: { summary: string; closes: boolean },
): void {
  const task = store.getTask(ref.taskId);
  if (!task) return;
  store.batch(() => {
    store.updateSession(ref.sessionId, {
      state: AgentState.agentdone,
      result: outcome.summary,
    });
    store.updateTask(ref.taskId, {
      agent_state: AgentState.agentdone,
      agent_says: null,
      unread_result: 1,
      ...(outcome.closes
        ? { status: TaskStatus.done, closed_at: now(), closed_by: "agent" }
        : {}),
    });
    if (task.status !== TaskStatus.done)
      store.tellFromTask(
        task,
        outcome.closes ? "finished" : "finished; it waits for the owner",
        outcome.summary,
      );
  });
}

// Mark done always does the same things: closed, unsent draft retired, any
// live agent saved (the caller stops its process), off the rail.
export function taskClosed(taskId: number, by = "you"): void {
  store.batch(() => {
    store.retirePendingActions(taskId);
    const task = store.getTask(taskId);
    if (task && task.status !== TaskStatus.done)
      store.tellFromTask(
        task,
        `marked done by ${by}`,
        store.latestSession(taskId)?.result ?? null,
      );
    const agentLive =
      task &&
      (task.agent_state === AgentState.working ||
        task.agent_state === AgentState.blocked ||
        task.agent_state === AgentState.queued);
    store.updateTask(taskId, {
      status: TaskStatus.done,
      closed_at: now(),
      closed_by: by,
      unread_result: 0,
      watching: 0,
      remind_at: null,
      ...(agentLive ? { agent_state: AgentState.saved } : {}),
    });
    for (const session of store
      .liveSessions()
      .filter((s) => s.task_id === taskId))
      store.updateSession(session.id, {
        ended_at: now(),
        state: AgentState.saved,
      });
  });
}

// New work landed on a task whose agent had finished: that finish is read,
// and the task is nobody's until an agent picks it up again.
export function finishSuperseded(taskId: number): void {
  const task = store.getTask(taskId);
  if (task?.agent_state === AgentState.agentdone)
    store.updateTask(taskId, {
      agent_state: AgentState.none,
      unread_result: 0,
    });
}

// The draft an agent was waiting on went out: it is no longer asking.
export function draftSent(taskId: number): void {
  const task = store.getTask(taskId);
  if (task?.agent_state === AgentState.blocked)
    store.updateTask(taskId, { agent_says: null });
}

// Sessions alive when aug last quit are not alive now, except in tmux, which
// keeps coding agents up across restarts (reconcile asks it which still are).
// A chat turn cut off reads as stopped, with Continue.
export function recoverAtBoot(
  isRunning: (taskId: number) => boolean,
  survives: (session: SessionRow) => boolean,
): void {
  store.batch(() => {
    for (const s of store.liveSessions()) {
      if (survives(s)) continue;
      sessionEnded({ taskId: s.task_id, sessionId: s.id }, AgentState.stopped);
    }
    for (const task of store.listTasks()) {
      // The queue that held it waiting its turn died with the last aug.
      if (
        task.agent_state === AgentState.queued &&
        task.queue_reason !== HELD_FOR_START
      )
        holdForStart(task.id);
      if (
        task.agent_state === AgentState.working &&
        !store.liveSessions().some((s) => s.task_id === task.id) &&
        !isRunning(task.id)
      )
        store.updateTask(task.id, { agent_state: AgentState.stopped });
    }
  });
}
