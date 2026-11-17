// The Inbox: every message triage saw and every Advisor idea, newest first,
// each with where it went. Message bodies can be private, so a row carries
// a short subject and the view shows a capped body unless asked.

import * as store from "./store";
import {
  IdeaStatus,
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
  fyi: "FYI",
  failed: "triage failed",
  untriaged: "not triaged",
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
    }
  | {
      type: "idea";
      key: string;
      at: string;
      source: "advisor";
      from: "Advisor";
      subject: string;
      result: InboxResult;
      // The task the idea is about.
      taskId: number | null;
      read: boolean;
      idea: IdeaRow;
    };

// Where a message went, from what the message says now: an owner's move
// after triage (not a task, make it a task) changes it, and the row follows.
export function messageResult(m: MessageRow): InboxResult {
  if (m.from_me) return InboxResult.own;
  if (m.task_id !== null)
    return m.verdict && m.verdict !== Verdict.fyi
      ? InboxResult.task
      : InboxResult.attached;
  if (m.verdict === Verdict.fyi)
    return m.reason?.startsWith("awaiting AI triage")
      ? InboxResult.failed
      : InboxResult.fyi;
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
    taskId: idea.task_id,
    read: idea.status !== IdeaStatus.open,
    idea,
  };
}

// On the owner until they act: an open idea, or a message triage could not
// place. What the rail's badge counts.
export function needsAttention(row: InboxRow): boolean {
  return (
    row.result === InboxResult.idea ||
    row.result === InboxResult.failed ||
    row.result === InboxResult.untriaged
  );
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
      // Your own messages, greetings, read FYIs and handled ideas are kept
      // for "all": none asks anything more of you.
      return (
        needsAttention(row) ||
        row.result === InboxResult.task ||
        row.result === InboxResult.attached ||
        (row.result === InboxResult.fyi && !row.read)
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

export function buildInbox(messages: MessageRow[], ideas: IdeaRow[]): InboxRow[] {
  return [...messages.map(messageRow), ...ideas.map(ideaRow)].sort((a, b) =>
    a.at < b.at ? 1 : a.at > b.at ? -1 : a.key < b.key ? 1 : -1,
  );
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
