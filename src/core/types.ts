// The domain, as stored. Row shapes mirror the SQLite tables one to one so the
// store can hand them out without mapping.

export const Channel = {
  github: "github",
  slack: "slack",
  // Typed by the owner (a new task, a line in a chat).
  owner: "owner",
} as const;
export type Channel = (typeof Channel)[keyof typeof Channel];

// Triage's five roads plus watch. fyi creates no task; the rest are task kinds.
export const Verdict = {
  fyi: "fyi",
  reply: "reply",
  general: "general",
  coding: "coding",
  task: "task",
  watch: "watch",
} as const;
export type Verdict = (typeof Verdict)[keyof typeof Verdict];

export const Kind = {
  reply: "reply",
  general: "general",
  coding: "coding",
  task: "task",
  // The one Home thread: you and the Assistant. Not work, never closes.
  home: "home",
} as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

export const TaskStatus = {
  open: "open",
  later: "later",
  done: "done",
  dropped: "dropped",
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const Priority = {
  urgent: "urgent",
  important: "important",
  regular: "regular",
} as const;
export type Priority = (typeof Priority)[keyof typeof Priority];

// The six states an agent can be in, plus "none" for a task nobody handed to
// an agent. One word and one mark each, everywhere (see lanes.ts).
export const AgentState = {
  none: "none",
  queued: "queued",
  working: "working",
  blocked: "blocked",
  saved: "saved",
  stopped: "stopped",
  agentdone: "agentdone",
} as const;
export type AgentState = (typeof AgentState)[keyof typeof AgentState];

export interface TaskRow {
  id: number;
  title: string;
  summary: string;
  kind: Kind;
  status: TaskStatus;
  priority: Priority;
  // A hand-set priority is never raised again by triage.
  priority_pinned: number;
  watching: number;
  remind_at: string | null;
  waiting_on: string | null;
  repo: string | null;
  thread_key: string | null;
  channel: Channel;
  url: string | null;
  agent_state: AgentState;
  // What the agent said when it stopped to wait (a question, an approval).
  agent_says: string | null;
  // Why it waits to start ("held for you", "waiting its turn").
  queue_reason: string | null;
  triage_reason: string | null;
  // An agent-closed task stays on the rail until the owner has read it.
  unread_result: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  closed_by: string | null;
  project_id: number | null;
  // Set once the task has a worktree; (repo, branch) is how a PR finds it.
  branch: string | null;
  worktree: string | null;
  // The task this one was made from (a handoff), which hears when it ends.
  from_task_id: number | null;
  // The project goal this task works toward.
  goal_id: number | null;
}

export const ProjectStatus = {
  active: "active",
  archived: "archived",
} as const;
export type ProjectStatus = (typeof ProjectStatus)[keyof typeof ProjectStatus];

export const GoalStatus = {
  open: "open",
  met: "met",
  dropped: "dropped",
} as const;
export type GoalStatus = (typeof GoalStatus)[keyof typeof GoalStatus];

export const MoveStatus = {
  pending: "pending",
  running: "running",
  done: "done",
  failed: "failed",
} as const;
export type MoveStatus = (typeof MoveStatus)[keyof typeof MoveStatus];

export interface MoveRow {
  id: number;
  verb: string;
  // JSON object of string args, as aug-tools passed them.
  args: string;
  asked_by: string;
  status: MoveStatus;
  result: string | null;
  created_at: string;
  finished_at: string | null;
}

// One tmux session. The session carries @aug_project; tmux_session is only
// the name it had when aug last looked.
export interface ProjectRow {
  id: number;
  name: string;
  tmux_session: string;
  // JSON array of owner/repo keys.
  repos: string;
  status: ProjectStatus;
  // Made for one inbound task; archived when it empties.
  solo: number;
  // What the project is for, in the owner's words; every task in it reads it.
  brief: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface GoalRow {
  id: number;
  project_id: number;
  title: string;
  status: GoalStatus;
  created_at: string;
  updated_at: string;
  met_at: string | null;
}

export interface ProjectLinkRow {
  id: number;
  project_id: number;
  url: string;
  title: string | null;
  added_by: string;
  created_at: string;
}

export interface MessageRow {
  id: number;
  channel: Channel;
  external_id: string;
  thread_key: string;
  author: string;
  author_name: string;
  title: string;
  body: string;
  url: string | null;
  received_at: string;
  task_id: number | null;
  verdict: Verdict | null;
  reason: string | null;
  read_at: string | null;
  from_me: number;
  // Channel-specific coordinates an outbound reply needs (slack channel +
  // thread_ts, github repo + number + subject type).
  meta: string;
}

export const TurnRole = {
  // Something that came in: a message on the thread.
  incoming: "in",
  // What the owner typed into the task's chat.
  you: "you",
  // Short notes aug itself adds ("Sent the reply", "Reminded today").
  trigger: "trigger",
  agent: "agent",
} as const;
export type TurnRole = (typeof TurnRole)[keyof typeof TurnRole];

export const ActionState = {
  pending: "pending",
  sent: "sent",
  // A newer turn drafted again, or the task closed with it unsent.
  retired: "retired",
  failed: "failed",
} as const;
export type ActionState = (typeof ActionState)[keyof typeof ActionState];

export const TurnStatus = {
  running: "running",
  done: "done",
  failed: "failed",
} as const;
export type TurnStatus = (typeof TurnStatus)[keyof typeof TurnStatus];

export interface TurnRow {
  id: number;
  task_id: number;
  role: TurnRole;
  message_id: number | null;
  author: string;
  body: string;
  // The agent turn's three sections; body holds the raw text when the agent
  // ignored the format.
  about: string | null;
  did: string | null;
  next: string | null;
  action: string | null;
  action_state: ActionState | null;
  action_result: string | null;
  // JSON array of one-line tool steps, live while the turn runs.
  steps: string;
  // JSON array of MadeFile: what the turn left in the task's scratch folder.
  files: string;
  // An owner line a coding agent has not heard yet: its claude was not
  // running. The next start hands it over.
  pending: number;
  status: TurnStatus;
  session_id: string | null;
  started_at: string;
  finished_at: string | null;
}

export const SessionKind = {
  // claude -p turns resumed by id: a general task's chat.
  chat: "chat",
  // Interactive claude in a window of the project's tmux session.
  tmux: "tmux",
} as const;
export type SessionKind = (typeof SessionKind)[keyof typeof SessionKind];

export interface SessionRow {
  id: string;
  task_id: number;
  kind: SessionKind;
  cwd: string;
  state: AgentState;
  says: string | null;
  // The tool the agent touched last, for "what is it doing right now".
  last_tool: string | null;
  started_by: "owner" | "aug";
  started_at: string;
  last_event_at: string;
  ended_at: string | null;
  result: string | null;
  // The tmux window id (@12) for a tmux session.
  tmux_window: string | null;
}

export const NoteLabel = {
  note: "note",
  workingOn: "working on",
  blocked: "blocked",
  ready: "ready to push",
} as const;
export type NoteLabel = (typeof NoteLabel)[keyof typeof NoteLabel];

export interface NoteRow {
  id: number;
  author: string;
  label: NoteLabel;
  body: string;
  task_id: number | null;
  read_by: string;
  created_at: string;
}

export interface TaskLinkRow {
  id: number;
  task_id: number;
  url: string;
  title: string | null;
  // "you", "assistant", or "agent AUG-0012".
  added_by: string;
  created_at: string;
}

export interface KnowledgeRow {
  id: number;
  topic: string;
  title: string;
  body: string;
  author: string;
  parent_id: number | null;
  created_at: string;
}

export const IdeaStatus = {
  open: "open",
  dismissed: "dismissed",
  tasked: "tasked",
} as const;
export type IdeaStatus = (typeof IdeaStatus)[keyof typeof IdeaStatus];

export interface IdeaRow {
  id: number;
  title: string;
  body: string;
  task_id: number | null;
  status: IdeaStatus;
  created_at: string;
}

export interface CorrectionRow {
  id: number;
  task_id: number | null;
  message_id: number | null;
  what: string;
  before: string | null;
  after: string | null;
  note: string | null;
  learned: string | null;
  created_at: string;
}

// The action an agent sets up for one press. Nothing in it runs until the
// owner sends it.
export type DraftAction =
  | {
      type: "slack_reply";
      channel: string;
      thread_ts?: string;
      to?: string;
      text: string;
    }
  | {
      type: "github_comment";
      repo: string;
      number: number;
      body: string;
      // The close-out riding with the comment, done in the same press.
      close?: "issue" | "merge" | "approve";
    };
