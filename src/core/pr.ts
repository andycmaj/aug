// A task's pull request: which one it is, what GitHub says about it, and the
// few words the rail and the table show for it. The owner opens ghdash on it
// (components/use-pr-dash); the engine refreshes the status on its GitHub
// clock.

import { parsePrUrl } from "./feedback";
import type { Tone } from "./lanes";
import { errorMessage, logger } from "./log";
import { messageMeta } from "./meta";
import * as store from "./store";
import {
  PrChecks,
  PrMergeable,
  PrReview,
  PrState,
  TaskStatus,
  type PrStatusRow,
  type TaskRow,
} from "./types";

const log = logger("pr");

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

// What `gh pr view --json` gives for the fields asked.
export interface GhPrView {
  state?: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  mergeable?: string;
  statusCheckRollup?: {
    __typename?: string;
    status?: string;
    conclusion?: string | null;
    state?: string;
  }[];
}

export const PR_FIELDS =
  "state,isDraft,reviewDecision,mergeable,statusCheckRollup";

const FAILED = new Set([
  "FAILURE",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
  "ERROR",
]);

function rollup(checks: GhPrView["statusCheckRollup"]): PrChecks {
  if (!checks?.length) return PrChecks.none;
  let pending = false;
  for (const c of checks) {
    // A check run has status + conclusion; a commit status has state.
    const verdict = c.conclusion ?? c.state ?? "";
    if (FAILED.has(verdict)) return PrChecks.fail;
    const done =
      c.__typename === "StatusContext"
        ? c.state !== "PENDING" && c.state !== "EXPECTED"
        : c.status === "COMPLETED";
    if (!done) pending = true;
  }
  return pending ? PrChecks.pending : PrChecks.pass;
}

export function readPrView(
  view: GhPrView,
): Pick<PrStatusRow, "state" | "checks" | "review" | "mergeable"> {
  const state =
    view.state === "MERGED"
      ? PrState.merged
      : view.state === "CLOSED"
        ? PrState.closed
        : view.isDraft
          ? PrState.draft
          : PrState.open;
  const review =
    view.reviewDecision === "APPROVED"
      ? PrReview.approved
      : view.reviewDecision === "CHANGES_REQUESTED"
        ? PrReview.changes
        : view.reviewDecision === "REVIEW_REQUIRED"
          ? PrReview.required
          : PrReview.none;
  const mergeable =
    view.mergeable === "MERGEABLE"
      ? PrMergeable.clean
      : view.mergeable === "CONFLICTING"
        ? PrMergeable.conflict
        : PrMergeable.unknown;
  return { state, checks: rollup(view.statusCheckRollup), review, mergeable };
}

export type PrViewer = (url: string) => Promise<GhPrView>;

export async function ghPrView(url: string): Promise<GhPrView> {
  const proc = Bun.spawn(["gh", "pr", "view", url, "--json", PR_FIELDS], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(err.trim() || `gh pr view exited ${code}`);
  return JSON.parse(out) as GhPrView;
}

export async function refreshPrStatus(
  task: TaskRow,
  view: PrViewer = ghPrView,
): Promise<PrStatusRow | null> {
  const pr = taskPr(task);
  if (!pr) return null;
  const row: PrStatusRow = {
    task_id: task.id,
    ...pr,
    ...readPrView(await view(pr.url)),
    fetched_at: new Date().toISOString(),
  };
  store.setPrStatus(row);
  return row;
}

// Work still in front of the owner, whose PR can still change. A merged PR
// is read once more only if the task now points at another PR.
function wantsRefresh(task: TaskRow): boolean {
  if (task.status !== TaskStatus.open && task.status !== TaskStatus.later)
    return false;
  const pr = taskPr(task);
  if (!pr) return false;
  const last = store.prStatus(task.id);
  return !(last && last.url === pr.url && last.state === PrState.merged);
}

// One at a time: a dozen PRs is a dozen gh calls, not a burst.
export async function refreshPrStatuses(
  view: PrViewer = ghPrView,
): Promise<number> {
  let n = 0;
  for (const task of store.listTasks()) {
    if (!wantsRefresh(task)) continue;
    try {
      await refreshPrStatus(task, view);
      n++;
    } catch (err) {
      log.warn("pr status failed", {
        task: task.id,
        error: errorMessage(err),
      });
    }
  }
  return n;
}

// The one thing worth knowing at a glance, for a rail row: what is in the
// way first, then what is pending, then ready.
export function prChip(s: PrStatusRow): { text: string; tone: Tone } {
  const say = (word: string, tone: Tone) => ({
    text: `#${s.number} ${word}`,
    tone,
  });
  if (s.state === PrState.merged) return say("merged", "muted");
  if (s.state === PrState.closed) return say("closed", "muted");
  if (s.mergeable === PrMergeable.conflict) return say("✗ conflict", "error");
  if (s.checks === PrChecks.fail) return say("✗ ci", "error");
  if (s.review === PrReview.changes) return say("✗ changes", "error");
  if (s.checks === PrChecks.pending) return say("● ci", "warning");
  if (s.state === PrState.draft) return say("draft", "muted");
  if (s.review === PrReview.approved) return say("✓ ready", "success");
  if (s.review === PrReview.required) return say("● review", "warning");
  return say("✓ ci", "success");
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

// The whole of it, for the table's header.
export function prLine(s: PrStatusRow): string {
  const open = s.state === PrState.open || s.state === PrState.draft;
  return [
    `PR ${s.repo}#${s.number}`,
    s.state,
    open ? CHECK_WORDS[s.checks] : "",
    open ? REVIEW_WORDS[s.review] : "",
    open && s.mergeable === PrMergeable.conflict ? "conflicts" : "",
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
