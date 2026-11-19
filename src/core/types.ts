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
  // aug asking about its own install: a brain doc proposal, a shipped doc
  // you did not get, the onboarding offer. No agent; accept or reject.
  system: "system",
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
// an agent. One word and one mark each, everywhere (see lanes.ts and
// docs/rail-status-design.md). Working is a turn running; idle is a turn
// over with nothing asked; waiting is the agent needing the owner's answer;
// ready is its work finished and waiting on the owner to review, push or
// close it (or, on a task it closed itself, to read the result).
export const AgentState = {
  none: "none",
  queued: "queued",
  working: "working",
  idle: "idle",
  waiting: "waiting",
  stopped: "stopped",
  ready: "ready",
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
  // Its branch landed (a merged PR, or merged into the base by hand): ready
  // to clean up, not done.
  merged_at: string | null;
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

// The author of an owner line that came from Slack (core/slack/remote.ts):
// the Assistant answers it short, since it is read in Slack.
export const SLACK_AUTHOR = "you via Slack";

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
  // Why it ended, in a few words ("you stopped it", "its window closed").
  end_reason: string | null;
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

export const PrState = {
  open: "open",
  draft: "draft",
  merged: "merged",
  closed: "closed",
} as const;
export type PrState = (typeof PrState)[keyof typeof PrState];

export const PrChecks = {
  pass: "pass",
  fail: "fail",
  pending: "pending",
  none: "none",
} as const;
export type PrChecks = (typeof PrChecks)[keyof typeof PrChecks];

export const PrReview = {
  approved: "approved",
  changes: "changes",
  required: "required",
  none: "none",
} as const;
export type PrReview = (typeof PrReview)[keyof typeof PrReview];

export const PrMergeable = {
  clean: "clean",
  conflict: "conflict",
  unknown: "unknown",
} as const;
export type PrMergeable = (typeof PrMergeable)[keyof typeof PrMergeable];

// Where an open PR stands with GitHub's merge queue: not in it, in it
// (its entry's checks running or passed), in it but going to be kicked
// (unmergeable), or taken out without merging since its last commit.
export const PrQueue = {
  none: "none",
  queued: "queued",
  failing: "failing",
  removed: "removed",
} as const;
export type PrQueue = (typeof PrQueue)[keyof typeof PrQueue];

export interface PrStatusRow {
  task_id: number;
  repo: string;
  number: number;
  url: string;
  state: PrState;
  checks: PrChecks;
  review: PrReview;
  mergeable: PrMergeable;
  queue: PrQueue;
  // Its place in the queue (1 is next), while queued.
  queue_position: number | null;
  // Why it left the queue, when removed.
  queue_reason: string | null;
  fetched_at: string;
  // Why the last read failed; the rest is from the read before it.
  error: string | null;
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

// The correction a move of a triaged task records; triage reads the recent
// ones back as examples of where such work goes.
export const PROJECT_MOVE = "Triage project: filed it under another project";

export interface ProjectMove {
  title: string;
  before: string;
  after: string;
}

export interface IdeaRow {
  id: number;
  title: string;
  body: string;
  // The task the idea is about.
  task_id: number | null;
  status: IdeaStatus;
  // The task approving it made.
  made_task_id: number | null;
  created_at: string;
}

// Where a doc proposal came from.
export const ProposalSource = {
  // A new shipped version of a doc the owner edited.
  shipped: "shipped",
  // The Advisor's daily pass: a lesson worth a place in a doc, or a shrink.
  evolve: "evolve",
  // The onboarding interview's drafts.
  onboard: "onboard",
} as const;
export type ProposalSource = (typeof ProposalSource)[keyof typeof ProposalSource];

export const ProposalStatus = {
  open: "open",
  accepted: "accepted",
  rejected: "rejected",
} as const;
export type ProposalStatus = (typeof ProposalStatus)[keyof typeof ProposalStatus];

// A whole new text for one brain doc, waiting on the owner in a SYSTEM task.
export interface DocProposalRow {
  id: number;
  task_id: number;
  doc: string;
  source: ProposalSource;
  // The file as it was when proposed: the diff's left side.
  base: string;
  proposed: string;
  reason: string;
  // JSON array: LEARNED.md lines that leave for the archive on accept.
  absorbs: string;
  status: ProposalStatus;
  created_at: string;
  updated_at: string;
}

// A rule in the triage chain either claims the message or passes it on.
export const StepDecision = {
  pass: "pass",
  claim: "claim",
} as const;
export type StepDecision = (typeof StepDecision)[keyof typeof StepDecision];

// What a triage run ended in: a verdict, or how a gate routed it.
// The reason a message triage held for the owner is filed with (no
// escalation rule named it); the Inbox reads it back.
export const HELD = "held: ";

export type TriageVerdict = Verdict | "attached" | "own" | "opener" | "failed" | "held";

export interface TriageRunRow {
  id: number;
  message_id: number;
  // JSON: what every rule saw (DM or not, the thread's open and last task).
  input: string;
  // JSON of the model's verdict, null when no rule asked for it.
  verdict: string | null;
  // The rule that claimed it.
  rule: string;
  outcome: TriageVerdict | null;
  task_id: number | null;
  project_id: number | null;
  reason: string;
  at: string;
}

export interface TriageStepRow {
  id: number;
  run_id: number;
  seq: number;
  rule: string;
  decision: StepDecision;
  reason: string;
  at: string;
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

// Who a model call was for, on its spend row (core/spend.ts).
export const SpendRole = {
  triage: "triage",
  advisor: "advisor",
  docPass: "doc-pass",
  learn: "learn",
  redraft: "redraft",
  assistant: "assistant",
  general: "general",
  slack: "slack",
  other: "other",
} as const;
export type SpendRole = (typeof SpendRole)[keyof typeof SpendRole];

export interface SpendTotal {
  cost: number;
  calls: number;
  tokens: number;
}

export interface SpendByRole extends SpendTotal {
  role: SpendRole;
}

export interface SpendByDay extends SpendTotal {
  day: string;
}

export interface SpendByTask extends SpendTotal {
  task_id: number;
}

// What happened to a task (task_events, written by triggers in db.ts).
export const TaskEventKind = {
  created: "created",
  done: "done",
  dropped: "dropped",
  later: "later",
  reopened: "reopened",
  merged: "merged",
  unmerged: "unmerged",
  // Its agent said it was done (aug-tools done); detail is the summary.
  finished: "finished",
} as const;
export type TaskEventKind = (typeof TaskEventKind)[keyof typeof TaskEventKind];

export interface TaskEventRow {
  id: number;
  task_id: number;
  kind: TaskEventKind;
  // done/dropped: who closed it; finished: the agent's summary; created: kind.
  detail: string | null;
  at: string;
}
