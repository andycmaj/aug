// THE vocabulary, once: what a piece of live work is called and how it is
// marked, on the rail, the task view and the Board alike. Taskuary's
// lanes.json, cut to what GitHub and Slack work produces. A lane reads two
// axes, the task's lifecycle (its phase) and its agent's state; the order in
// laneOf is the rule (docs/rail-status-design.md).

import { AgentState, Kind, PrState, TaskStatus, type TaskRow } from "./types";

export const Lane = {
  waiting: "waiting",
  approve: "approve",
  working: "working",
  queued: "queued",
  merged: "merged",
  review: "review",
  blocked: "blocked",
  idle: "idle",
  stopped: "stopped",
  agentdone: "agentdone",
  asked: "asked",
  yours: "yours",
  theirs: "theirs",
  watching: "watching",
  later: "later",
  done: "done",
} as const;
export type Lane = (typeof Lane)[keyof typeof Lane];

// Single-cell glyphs only: emoji are two cells wide and drift columns in
// terminals that disagree about their width.
export const LANE_META: Record<
  Lane,
  { word: string; mark: string; tone: Tone }
> = {
  waiting: { word: "agent waiting on you", mark: "◆", tone: "warning" },
  approve: { word: "ready to send", mark: "↑", tone: "success" },
  working: { word: "agent working", mark: "◐", tone: "info" },
  queued: { word: "waiting to start", mark: "◌", tone: "muted" },
  merged: { word: "merged, clean up", mark: "»", tone: "success" },
  review: { word: "PR in review", mark: "◎", tone: "secondary" },
  blocked: { word: "blocked by a task", mark: "⊘", tone: "muted" },
  idle: { word: "agent idle", mark: "◇", tone: "secondary" },
  stopped: { word: "agent stopped", mark: "■", tone: "muted" },
  agentdone: { word: "agent finished", mark: "✓", tone: "success" },
  asked: { word: "asked you", mark: "?", tone: "primary" },
  yours: { word: "on you", mark: "•", tone: "text" },
  theirs: { word: "waiting on them", mark: "→", tone: "muted" },
  watching: { word: "watching", mark: "○", tone: "muted" },
  later: { word: "for later", mark: "◷", tone: "muted" },
  done: { word: "done", mark: "✓", tone: "muted" },
};

export type Tone =
  | "warning"
  | "success"
  | "info"
  | "muted"
  | "primary"
  | "text"
  | "error"
  | "secondary";

export interface LaneFacts {
  hasPendingAction: boolean;
  // Its PR's last read state, if it has one.
  prState?: string | null;
  // How many open tasks it waits on.
  blockers?: number;
}

// Where an open task is in its life, from facts already stored: nothing to
// keep in step, nothing to go stale.
export const Phase = {
  open: "open",
  blocked: "blocked",
  review: "review",
  merged: "merged",
  later: "later",
  done: "done",
  dropped: "dropped",
} as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

export function phaseOf(task: TaskRow, facts: LaneFacts): Phase {
  if (task.status !== TaskStatus.open) return task.status;
  if (task.merged_at) return Phase.merged;
  if (facts.prState === PrState.open || facts.prState === PrState.draft)
    return Phase.review;
  if ((facts.blockers ?? 0) > 0) return Phase.blocked;
  return Phase.open;
}

// Which lane a task is in. The first row that holds wins, top to bottom:
// what needs you now, what is moving, where the work is, the agent at rest,
// then whose it is.
export function laneOf(task: TaskRow, facts: LaneFacts): Lane {
  if (task.status === TaskStatus.done) {
    return task.agent_state === AgentState.agentdone && task.unread_result
      ? Lane.agentdone
      : Lane.done;
  }
  if (task.status === TaskStatus.later) return Lane.later;
  if (task.agent_state === AgentState.waiting) return Lane.waiting;
  if (facts.hasPendingAction) return Lane.approve;
  if (task.agent_state === AgentState.working) return Lane.working;
  if (task.agent_state === AgentState.queued) return Lane.queued;
  const phase = phaseOf(task, facts);
  if (phase === Phase.merged) return Lane.merged;
  if (phase === Phase.review) return Lane.review;
  if (phase === Phase.blocked) return Lane.blocked;
  if (task.agent_state === AgentState.idle) return Lane.idle;
  if (task.agent_state === AgentState.stopped) return Lane.stopped;
  if (task.agent_state === AgentState.agentdone) return Lane.agentdone;
  if (task.watching) return Lane.watching;
  if (task.waiting_on) return Lane.theirs;
  if (task.kind === Kind.task) return Lane.yours;
  return task.channel === "owner" ? Lane.yours : Lane.asked;
}

// The Board's columns are the agent's states.
export const BoardColumn = {
  queued: "queued",
  working: "working",
  waiting: "waiting",
  idle: "idle",
  left: "left",
  agentdone: "agentdone",
} as const;
export type BoardColumn = (typeof BoardColumn)[keyof typeof BoardColumn];

export const BOARD_COLUMNS: { key: BoardColumn; title: string; tone: Tone }[] =
  [
    // { key: "queued", title: "waiting to start", tone: "muted" },
    { key: "working", title: "agent working", tone: "info" },
    { key: "waiting", title: "waiting on you", tone: "warning" },
    { key: "idle", title: "agent idle", tone: "secondary" },
    { key: "left", title: "agent stopped", tone: "muted" },
    { key: "agentdone", title: "agent finished", tone: "success" },
  ];

export function boardColumnOf(
  task: TaskRow,
  facts: LaneFacts,
  today: string,
): BoardColumn | null {
  if (task.kind === Kind.task || task.kind === Kind.reply) return null;
  if (task.status === TaskStatus.dropped) return null;
  switch (task.agent_state) {
    case AgentState.queued:
      return BoardColumn.queued;
    case AgentState.working:
      return facts.hasPendingAction ? BoardColumn.waiting : BoardColumn.working;
    case AgentState.waiting:
      return BoardColumn.waiting;
    case AgentState.idle:
      return facts.hasPendingAction ? BoardColumn.waiting : BoardColumn.idle;
    case AgentState.stopped:
      return task.status === TaskStatus.done ? null : BoardColumn.left;
    case AgentState.agentdone:
      // Done is a today column: yesterday's finished work is history.
      if (task.status !== TaskStatus.done) {
        return facts.hasPendingAction
          ? BoardColumn.waiting
          : BoardColumn.agentdone;
      }
      return (task.closed_at ?? "").slice(0, 10) === today
        ? BoardColumn.agentdone
        : null;
    default:
      return null;
  }
}
