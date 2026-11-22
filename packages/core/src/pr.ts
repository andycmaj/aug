// A task's pull request: which one it is, and the few words the rail and
// the Canvas show for what GitHub last said about it (pr_status). The owner
// opens ghdash on it (components/use-pr-dash); @riker/github reads it on
// its clock (pr-status.ts).

import { parsePrUrl } from "./feedback";
import type { Tone } from "./lanes";
import { messageMeta } from "./meta";
import * as store from "./store";
import {
  PrChecks,
  PrMergeable,
  PrQueue,
  PrReview,
  PrState,
  type PrStatusRow,
  type TaskRow,
} from "./types";

export interface PrRef {
  repo: string;
  number: number;
  url: string;
}

const THREAD = /^github:([^/#]+\/[^/#]+)#(\d+)$/;

function fromThread(key: string): PrRef | null {
  const m = key.match(THREAD);
  if (!m) return null;
  const number = Number(m[2]);
  return { repo: m[1], number, url: prUrl(m[1], number) };
}

export function prUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/pull/${number}`;
}

function fromUrl(url: string | null): PrRef | null {
  const pr = url ? parsePrUrl(url) : null;
  return pr ? { ...pr, url: prUrl(pr.repo, pr.number) } : null;
}

// The PR the work is about, most specific first: one its agent linked or
// its branch pushed (task_threads only ever holds PRs), its own URL, the
// thread it came from when that thread is a PR (a review request), then a
// PR link attached by hand.
export function taskPr(task: TaskRow): PrRef | null {
  const linked = store
    .threadsForTask(task.id)
    .filter((k) => k !== task.thread_key);
  for (const key of linked.reverse()) {
    const pr = fromThread(key);
    if (pr) return pr;
  }
  const own = fromUrl(task.url);
  if (own) return own;
  if (task.thread_key) {
    const pr = fromThread(task.thread_key);
    const first = pr ? store.firstMessageOnThread(task.thread_key) : null;
    if (pr && first) {
      const meta = messageMeta(first);
      if (meta.channel === "github" && meta.type === "PullRequest") return pr;
    }
  }
  for (const link of store.linksForTask(task.id).reverse()) {
    const pr = fromUrl(link.url);
    if (pr) return pr;
  }
  return null;
}

// The merge queue's mark: past review, on its way to merged.
export const QUEUE_MARK = "↠";

// The one thing worth knowing at a glance, for a rail row, along the ladder
// draft, in review, changes, approved, in the merge queue, merged: where it
// ended first, then the queue (a PR in it has left review), then what is in
// the way, then what is pending, then ready. Short, so the sub line stays
// one line at the rail's width. When the last read failed, what it says is
// old news, and it says so.
export function prChip(s: PrStatusRow): { text: string; tone: Tone } {
  const say = (word: string, tone: Tone) =>
    s.error
      ? { text: `#${s.number} ${word} · stale`, tone: "muted" as const }
      : { text: `#${s.number} ${word}`, tone };
  if (s.state === PrState.merged) return say("merged", "accent");
  if (s.state === PrState.closed) return say("✗ closed", "muted");
  if (s.queue === PrQueue.failing) return say("✗ MQ", "error");
  if (s.queue === PrQueue.queued)
    return say(
      s.queue_position
        ? `${QUEUE_MARK} MQ ${s.queue_position}`
        : `${QUEUE_MARK} MQ`,
      "info",
    );
  if (s.queue === PrQueue.removed) return say("✗ out of MQ", "error");
  if (s.mergeable === PrMergeable.conflict) return say("✗ conflict", "error");
  if (s.checks === PrChecks.fail) return say("✗ ci", "error");
  if (s.review === PrReview.changes) return say("✗ changes", "error");
  if (s.checks === PrChecks.pending) return say("● ci", "warning");
  if (s.state === PrState.draft) return say("draft", "muted");
  if (s.review === PrReview.approved) return say("✓ approved", "success");
  if (s.review === PrReview.required) return say("● in review", "warning");
  return say("✓ ci", "success");
}

// What the rail's review lane says instead of "PR in review" once the PR
// has moved on to the queue, or been put out of it.
export function prQueueWord(s: PrStatusRow | null): string | null {
  if (!s || s.state === PrState.merged || s.state === PrState.closed)
    return null;
  if (s.queue === PrQueue.queued) return "in merge queue";
  if (s.queue === PrQueue.failing) return "failing in merge queue";
  if (s.queue === PrQueue.removed) return "out of merge queue";
  return null;
}

const CHECK_WORDS: Record<PrChecks, string> = {
  pass: "checks pass",
  fail: "checks failing",
  pending: "checks running",
  none: "no checks",
};
const REVIEW_WORDS: Record<PrReview, string> = {
  approved: "approved",
  changes: "changes requested",
  required: "review required",
  none: "",
};

function queueWords(s: PrStatusRow): string {
  if (s.queue === PrQueue.queued)
    return s.queue_position
      ? `in merge queue, position ${s.queue_position}`
      : "in merge queue";
  if (s.queue === PrQueue.failing) return "in merge queue, failing";
  if (s.queue === PrQueue.removed)
    return s.queue_reason
      ? `removed from merge queue: ${s.queue_reason.toLowerCase()}`
      : "removed from merge queue";
  return "";
}

// The whole of it, for the Canvas's header.
export function prLine(s: PrStatusRow): string {
  const open = s.state === PrState.open || s.state === PrState.draft;
  return [
    `PR ${s.repo}#${s.number}`,
    s.state,
    open ? queueWords(s) : "",
    open ? CHECK_WORDS[s.checks] : "",
    open ? REVIEW_WORDS[s.review] : "",
    open && s.mergeable === PrMergeable.conflict ? "conflicts" : "",
    s.error ? `stale, last read failed: ${s.error}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// The PR and its last read, when the read is of that PR.
export function taskPrStatus(
  task: TaskRow,
): { pr: PrRef; status: PrStatusRow | null } | null {
  const pr = taskPr(task);
  if (!pr) return null;
  const status = store.prStatus(task.id);
  return { pr, status: status?.url === pr.url ? status : null };
}
