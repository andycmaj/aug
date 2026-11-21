// The Inbox: every message triage saw and every Advisor idea, newest first,
// each with where it went. Message bodies can be private, so a row carries
// a short subject and the view shows a capped body unless asked.

import * as store from "./store";
import {
  HELD,
  IdeaStatus,
  MessageState,
  Verdict,
  type IdeaRow,
  type MessageRow,
  type TriageRunRow,
  type TriageStepRow,
} from "./types";

export const SUBJECT_CHARS = 80;
export const BODY_CHARS = 280;
// The newest this many messages: enough to scroll, few enough to read fast.
export const INBOX_LIMIT = 1000;

export const InboxResult = {
  // A message
  task: "task",
  attached: "attached",
  held: "held",
  fyi: "fyi",
  failed: "failed",
  untriaged: "untriaged",
  greeting: "greeting",
  own: "own",
  // An Advisor idea
  idea: "idea",
  tasked: "tasked",
  dismissed: "dismissed",
} as const;
export type InboxResult = (typeof InboxResult)[keyof typeof InboxResult];

export const RESULT_WORDS: Record<InboxResult, string> = {
  task: "made a task",
  attached: "joined a task",
  held: "held for you",
  fyi: "FYI",
  failed: "triage failed",
  untriaged: "awaiting triage",
  greeting: "greeting",
  own: "your message",
  idea: "idea",
  tasked: "made a task",
  dismissed: "dismissed",
};

export const InboxFilter = {
  actionable: "actionable",
  attention: "attention",
  task: "task",
  fyi: "fyi",
  all: "all",
} as const;
export type InboxFilter = (typeof InboxFilter)[keyof typeof InboxFilter];

export const INBOX_FILTERS: { filter: InboxFilter; word: string }[] = [
  { filter: "actionable", word: "actionable" },
  { filter: "attention", word: "needs you" },
  { filter: "task", word: "made a task" },
  { filter: "fyi", word: "FYI" },
  { filter: "all", word: "all" },
];

export type InboxRow =
  | {
      type: "message";
      key: string;
      at: string;
      source: string;
      from: string;
      subject: string;
      result: InboxResult;
      // The task it made or joined.
      taskId: number | null;
      read: boolean;
      message: MessageRow;
      // Older messages that joined the same task, folded into this row
      // (newest first): one row per task, not one per message.
      folded: MessageRow[];
    }
  | {
      type: "idea";
      key: string;
      at: string;
      source: "advisor";
      from: "Advisor";
      subject: string;
      result: InboxResult;
      // The task approving it made, else the task it is about.
      taskId: number | null;
      read: boolean;
      idea: IdeaRow;
    };

// Where a message went, from what the message says now: an owner's move
// after triage (ignore, make it a task) changes it, and the row follows.
export function messageResult(m: MessageRow): InboxResult {
  if (m.from_me) return InboxResult.own;
  if (m.task_id !== null)
    return m.verdict && m.verdict !== Verdict.fyi
      ? InboxResult.task
      : InboxResult.attached;
  if (m.state === MessageState.new || m.state === MessageState.triaging)
    return InboxResult.untriaged;
  if (m.state === MessageState.failed) return InboxResult.failed;
  if (m.reason?.startsWith(HELD)) return InboxResult.held;
  if (m.verdict === Verdict.fyi) return InboxResult.fyi;
  if (m.reason?.startsWith("a greeting")) return InboxResult.greeting;
  return InboxResult.untriaged;
}

function ideaResult(idea: IdeaRow): InboxResult {
  if (idea.status === IdeaStatus.tasked) return InboxResult.tasked;
  if (idea.status === IdeaStatus.dismissed) return InboxResult.dismissed;
  return InboxResult.idea;
}

// One line, cut with an ellipsis: a row never wraps.
export function clip(text: string, chars: number): string {
  return text.length <= chars ? text : `${text.slice(0, chars - 1)}…`;
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim())?.trim() ?? "";
}

// A GitHub title names the issue or PR; a Slack title is only where it
// was ("DM with Sam"), so the body's first line says more.
export function subjectOf(m: MessageRow): string {
  const text = m.channel === "github" && m.title ? m.title : firstLine(m.body) || m.title;
  return clip(text.replace(/\s+/g, " "), SUBJECT_CHARS);
}

export function messageRow(m: MessageRow): InboxRow {
  return {
    type: "message",
    key: `m${m.id}`,
    at: m.received_at,
    source: m.channel,
    from: m.author_name,
    subject: subjectOf(m),
    result: messageResult(m),
    taskId: m.task_id,
    read: m.read_at !== null,
    message: m,
    folded: [],
  };
}

export function ideaRow(idea: IdeaRow): InboxRow {
  return {
    type: "idea",
    key: `i${idea.id}`,
    at: idea.created_at,
    source: "advisor",
    from: "Advisor",
    subject: clip(idea.title, SUBJECT_CHARS),
    result: ideaResult(idea),
    taskId: idea.made_task_id ?? idea.task_id,
    read: idea.status !== IdeaStatus.open,
    idea,
  };
}

// On the owner until they act: an open idea, a message triage held for
// them, or one it gave up on (no retry left), until they dismiss it. One
// still waiting for the worker is not theirs yet. What the rail's badge
// counts (store.unplacedMessages).
export function needsAttention(row: InboxRow): boolean {
  if (row.read) return false;
  if (row.result === InboxResult.failed)
    return row.type === "message" && row.message.next_at === null;
  return row.result === InboxResult.idea || row.result === InboxResult.held;
}

export function inFilter(row: InboxRow, filter: InboxFilter): boolean {
  switch (filter) {
    case InboxFilter.all:
      return true;
    case InboxFilter.attention:
      return needsAttention(row);
    case InboxFilter.task:
      return row.result === InboxResult.task || row.result === InboxResult.tasked;
    case InboxFilter.fyi:
      return row.result === InboxResult.fyi;
    case InboxFilter.actionable:
      // Your own messages, greetings, handled ideas and whatever you have
      // dismissed (x marks it read) are kept for "all": none asks anything
      // more of you. One triage has yet to place (or will retry) shows here
      // without asking for you.
      return (
        needsAttention(row) ||
        (!row.read &&
          (row.result === InboxResult.task ||
            row.result === InboxResult.attached ||
            row.result === InboxResult.fyi ||
            row.result === InboxResult.untriaged ||
            row.result === InboxResult.failed))
      );
  }
}

// Search reads the subject, who sent it, where it came from and the result.
export function matchesQuery(row: InboxRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.subject, row.from, row.source, RESULT_WORDS[row.result]]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

const newestFirst = (a: InboxRow, b: InboxRow) =>
  a.at < b.at ? 1 : a.at > b.at ? -1 : a.key < b.key ? 1 : -1;

// Every message that joined a task is one row, the newest, carrying the
// rest: a busy thread would otherwise be a row per reply. It is read once
// all of them are.
function foldJoined(rows: InboxRow[]): InboxRow[] {
  const byTask = new Map<number, Extract<InboxRow, { type: "message" }>>();
  const out: InboxRow[] = [];
  for (const row of rows) {
    if (row.type !== "message" || row.result !== InboxResult.attached || row.taskId === null) {
      out.push(row);
      continue;
    }
    const top = byTask.get(row.taskId);
    if (!top) {
      byTask.set(row.taskId, row);
      out.push(row);
      continue;
    }
    top.folded.push(row.message);
    top.read = top.read && row.read;
  }
  return out;
}

export function buildInbox(messages: MessageRow[], ideas: IdeaRow[]): InboxRow[] {
  return foldJoined([...messages.map(messageRow), ...ideas.map(ideaRow)].sort(newestFirst));
}

// A row's messages, itself first: what x dismisses.
export function rowMessages(row: InboxRow): MessageRow[] {
  return row.type === "message" ? [row.message, ...row.folded] : [];
}

export function nextFilter(filter: InboxFilter): InboxFilter {
  const i = INBOX_FILTERS.findIndex((f) => f.filter === filter);
  return INBOX_FILTERS[(i + 1) % INBOX_FILTERS.length]!.filter;
}

// The body as the expanded row shows it: capped unless revealed.
export function shownBody(body: string, revealed: boolean): string {
  return revealed ? body : clip(body, BODY_CHARS);
}

// ── reads (the read model names their tables) ─────────────────────────────

export function inboxRows(): InboxRow[] {
  return buildInbox(store.recentMessages(INBOX_LIMIT), store.allIdeas());
}

export function inboxCount(): number {
  return store.openIdeas().length + store.unplacedMessages();
}

export interface InboxRun {
  run: TriageRunRow;
  steps: TriageStepRow[];
}

// Newest run first.
export function inboxRuns(messageId: number): InboxRun[] {
  return store
    .triageRunsFor(messageId)
    .map((run) => ({ run, steps: store.triageSteps(run.id) }));
}
