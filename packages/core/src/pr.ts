// A task's pull request: which one it is, what GitHub says about it, and the
// few words the rail and the Canvas show for it. The owner opens ghdash on it
// (components/use-pr-dash); the engine refreshes the status on its GitHub
// clock.

import { parsePrUrl } from "./feedback";
import {
  ghTrouble,
  GhTrouble,
  GRAPHQL_RESERVE,
  type GhRemaining,
  type GithubGate,
} from "./github-gate";
import type { Tone } from "./lanes";
import { errorMessage, logger } from "./log";
import { messageMeta } from "./meta";
import * as store from "./store";
import {
  PrChecks,
  PrMergeable,
  PrQueue,
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

// A PR as GitHub's GraphQL describes it, statusCheckRollup flattened to
// its contexts (what `gh pr view --json` calls it), and its last merge
// queue event and head commit's date flattened beside it.
export interface GhPrView {
  state?: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  mergeable?: string;
  isInMergeQueue?: boolean;
  // GitHub's MergeQueueEntryState: QUEUED, AWAITING_CHECKS, MERGEABLE,
  // UNMERGEABLE, LOCKED.
  mergeQueueEntry?: { position?: number; state?: string } | null;
  lastQueueEvent?: GhQueueEvent | null;
  headCommittedAt?: string | null;
  statusCheckRollup?: {
    __typename?: string;
    status?: string;
    conclusion?: string | null;
    state?: string;
  }[];
}

export interface GhQueueEvent {
  __typename?: string;
  createdAt?: string;
  reason?: string | null;
}

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

type QueueFields = Pick<PrStatusRow, "queue" | "queue_position" | "queue_reason">;

const NOT_QUEUED: QueueFields = {
  queue: PrQueue.none,
  queue_position: null,
  queue_reason: null,
};

// In the queue is what its entry says. Out of it, a removal is news only
// until the next commit: a push after it is the owner's answer to it, and
// the PR is back to its checks and reviews.
function readQueue(view: GhPrView): QueueFields {
  const entry = view.mergeQueueEntry;
  if (entry || view.isInMergeQueue)
    return {
      queue:
        entry?.state === "UNMERGEABLE" ? PrQueue.failing : PrQueue.queued,
      queue_position: entry?.position ?? null,
      queue_reason: null,
    };
  const last = view.lastQueueEvent;
  if (last?.__typename !== "RemovedFromMergeQueueEvent") return NOT_QUEUED;
  const at = Date.parse(last.createdAt ?? "");
  const pushed = Date.parse(view.headCommittedAt ?? "");
  if (Number.isFinite(at) && Number.isFinite(pushed) && pushed > at)
    return NOT_QUEUED;
  return {
    queue: PrQueue.removed,
    queue_position: null,
    queue_reason: last.reason?.trim() || null,
  };
}

export function readPrView(
  view: GhPrView,
): Pick<
  PrStatusRow,
  "state" | "checks" | "review" | "mergeable" | keyof QueueFields
> {
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
  const open = state === PrState.open || state === PrState.draft;
  return {
    state,
    checks: rollup(view.statusCheckRollup),
    review,
    mergeable,
    ...(open ? readQueue(view) : NOT_QUEUED),
  };
}

// What one call for several PRs came back with: each PR's view or why it
// could not be read, and what is left of the GraphQL budget. A fetch that
// throws failed as a whole (a rate limit, a 502, a dropped connection).
export interface PrBatch {
  views: Map<string, GhPrView | Error>;
  budget: GhRemaining | null;
}

export type PrFetch = (prs: PrRef[]) => Promise<PrBatch>;

// One GraphQL query reads a batch, where `gh pr view` costs a call per PR.
// The merge queue rides in the same query: its entry is a field, and its
// last event one more node per PR, so a batch of 25 still costs 1 point.
export const PR_BATCH = 25;

const PR_FRAGMENT = `fragment pr on PullRequest {
  state isDraft reviewDecision mergeable
  isInMergeQueue mergeQueueEntry { position state }
  timelineItems(last: 1, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT]) { nodes {
    __typename
    ... on AddedToMergeQueueEvent { createdAt }
    ... on RemovedFromMergeQueueEvent { createdAt reason }
  } }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { status conclusion }
    ... on StatusContext { state }
  } } } } } }
}`;

export function prBatchQuery(prs: PrRef[]): string {
  const fields = prs.map((p, i) => {
    const [owner, name] = p.repo.split("/");
    return `p${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${p.number}) { ...pr } }`;
  });
  return `query {\n  rateLimit { remaining resetAt }\n  ${fields.join("\n  ")}\n}\n${PR_FRAGMENT}`;
}

// The raw shapes, exported so the offline simulator (@riker/fixtures sim)
// builds its answers against them and cannot drift from what is parsed.
export interface GqlPr
  extends Omit<
    GhPrView,
    "statusCheckRollup" | "lastQueueEvent" | "headCommittedAt"
  > {
  timelineItems?: { nodes?: GhQueueEvent[] } | null;
  commits?: {
    nodes?: {
      commit?: {
        committedDate?: string;
        statusCheckRollup?: {
          contexts?: { nodes?: GhPrView["statusCheckRollup"] };
        } | null;
      };
    }[];
  };
}

export interface GqlAnswer {
  data?: Record<string, unknown> | null;
  errors?: { message?: string; path?: (string | number)[] }[];
}

export function readPrBatch(prs: PrRef[], answer: GqlAnswer): PrBatch {
  const errors = answer.errors ?? [];
  const data = answer.data;
  if (!data) {
    const said = errors.map((e) => e.message).filter(Boolean).join("; ");
    throw new Error(said || "GitHub answered with no data");
  }
  const views = new Map<string, GhPrView | Error>();
  prs.forEach((pr, i) => {
    const alias = `p${i}`;
    const repo = data[alias] as { pullRequest?: GqlPr | null } | null;
    const node = repo?.pullRequest;
    if (node) {
      const { commits, timelineItems, ...rest } = node;
      const head = commits?.nodes?.[0]?.commit;
      views.set(pr.url, {
        ...rest,
        statusCheckRollup: head?.statusCheckRollup?.contexts?.nodes ?? [],
        lastQueueEvent: timelineItems?.nodes?.at(-1) ?? null,
        headCommittedAt: head?.committedDate ?? null,
      });
      return;
    }
    const said = errors.find((e) => e.path?.[0] === alias)?.message;
    views.set(pr.url, new Error(said ?? "not found"));
  });
  const budget = data.rateLimit as GhRemaining | null | undefined;
  return { views, budget: budget ?? null };
}

export async function ghPrBatch(prs: PrRef[]): Promise<PrBatch> {
  const proc = Bun.spawn(
    ["gh", "api", "graphql", "-f", `query=${prBatchQuery(prs)}`],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  // gh exits 1 when any PR in the batch errs (one deleted, one private) but
  // still prints the answer; only an answer with no data failed as a whole.
  let answer: GqlAnswer | null = null;
  try {
    answer = JSON.parse(out) as GqlAnswer;
  } catch {
    answer = null;
  }
  if (answer?.data) return readPrBatch(prs, answer);
  if (code === 0 && answer) return readPrBatch(prs, answer);
  throw new Error(err.trim() || `gh api graphql exited ${code}`);
}

function setFromView(task: TaskRow, pr: PrRef, view: GhPrView): PrStatusRow {
  const row: PrStatusRow = {
    task_id: task.id,
    ...pr,
    ...readPrView(view),
    fetched_at: new Date().toISOString(),
    error: null,
  };
  store.setPrStatus(row);
  return row;
}

export async function refreshPrStatus(
  task: TaskRow,
  fetch: PrFetch = ghPrBatch,
): Promise<PrStatusRow | null> {
  const pr = taskPr(task);
  if (!pr) return null;
  const got = (await fetch([pr])).views.get(pr.url);
  if (!got) throw new Error("not found");
  if (got instanceof Error) throw got;
  return setFromView(task, pr, got);
}

// A closed PR can be reopened, but rarely: it is read again now and then.
const CLOSED_EVERY_MS = 30 * 60_000;

// Work still in front of the owner, whose PR can still change. A merged PR
// is read once more only if the task now points at another PR.
function wantsRefresh(task: TaskRow): PrRef | null {
  if (task.status !== TaskStatus.open && task.status !== TaskStatus.later)
    return null;
  const pr = taskPr(task);
  if (!pr) return null;
  const last = store.prStatus(task.id);
  if (!last || last.url !== pr.url) return pr;
  if (last.state === PrState.merged) return null;
  if (
    last.state === PrState.closed &&
    !last.error &&
    Date.now() - Date.parse(last.fetched_at) < CLOSED_EVERY_MS
  )
    return null;
  return pr;
}

// How a round of PR reads went, for the GitHub status line.
export interface PrRefresh {
  asked: number;
  ok: number;
  failed: number;
  // PRs left for later: backing off one by one, or the round stopped early.
  skipped: number;
  error: string | null;
  // The rate limit that stopped the round.
  limited: string | null;
  budget: GhRemaining | null;
}

export interface PrRefreshOptions {
  fetch?: PrFetch;
  gate?: GithubGate;
  reserve?: number;
}

// A batch at a time, and each answer says how much budget is left: under
// the reserve, the round stops, and so does one that hit a rate limit.
export async function refreshPrStatuses(
  options: PrRefreshOptions = {},
): Promise<PrRefresh> {
  const fetch = options.fetch ?? ghPrBatch;
  const reserve = options.reserve ?? GRAPHQL_RESERVE;
  const gate = options.gate;
  const out: PrRefresh = {
    asked: 0,
    ok: 0,
    failed: 0,
    skipped: 0,
    error: null,
    limited: null,
    budget: null,
  };
  // Two tasks can be about the same PR; it is read once.
  const byUrl = new Map<string, { pr: PrRef; tasks: TaskRow[] }>();
  for (const task of store.listTasks()) {
    const pr = wantsRefresh(task);
    if (!pr) continue;
    if (gate && !gate.prAllowed(pr.url)) {
      out.skipped++;
      continue;
    }
    const entry = byUrl.get(pr.url) ?? { pr, tasks: [] };
    entry.tasks.push(task);
    byUrl.set(pr.url, entry);
  }
  const wanted = [...byUrl.values()];
  for (let i = 0; i < wanted.length; i += PR_BATCH) {
    const chunk = wanted.slice(i, i + PR_BATCH);
    if (out.limited || (out.budget && out.budget.remaining < reserve)) {
      out.skipped += chunk.length;
      continue;
    }
    out.asked += chunk.length;
    let batch: PrBatch;
    try {
      batch = await fetch(chunk.map((c) => c.pr));
    } catch (err) {
      const message = errorMessage(err);
      log.warn("pr status failed", { prs: chunk.length, error: message });
      if (ghTrouble(message) === GhTrouble.rateLimit) {
        out.limited = message;
        out.asked -= chunk.length;
        out.skipped += chunk.length;
        continue;
      }
      out.failed += chunk.length;
      out.error = message;
      for (const c of chunk)
        for (const t of c.tasks) store.markPrStale(t.id, message);
      continue;
    }
    if (batch.budget) out.budget = batch.budget;
    for (const { pr, tasks } of chunk) {
      const got = batch.views.get(pr.url) ?? new Error("not in the answer");
      if (got instanceof Error) {
        log.warn("pr status failed", { pr: pr.url, error: got.message });
        out.failed++;
        out.error = got.message;
        gate?.prFailed(pr.url);
        for (const t of tasks) store.markPrStale(t.id, got.message);
        continue;
      }
      gate?.prSucceeded(pr.url);
      for (const t of tasks) setFromView(t, pr, got);
      out.ok++;
    }
  }
  return out;
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
