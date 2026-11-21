// The simulator's GitHub: one JSON file in the scratch home that `bun run
// sim:do` and the scenarios write, and that the fake `gh api` and GraphQL
// batch below read on every call. Its answers are typed as the shapes
// core/ingest/github.ts and core/pr.ts parse, and the PR batch goes through
// the real readPrBatch, so aug polls this exactly as it polls GitHub.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type {
  GhApi,
  GhItem,
  GhNotification,
  GhPull,
} from "../../core/ingest/github";
import {
  readPrBatch,
  type GqlAnswer,
  type GqlPr,
  type PrFetch,
  type PrRef,
} from "../../core/pr";

export const SIM_REPO = "sim/aug";
export const SIM_ME = "you";

export const CheckStatus = {
  queued: "QUEUED",
  running: "IN_PROGRESS",
  done: "COMPLETED",
} as const;
export type CheckStatus = (typeof CheckStatus)[keyof typeof CheckStatus];

export interface SimCheck {
  name: string;
  status: CheckStatus;
  conclusion: "SUCCESS" | "FAILURE" | null;
}

export const ReviewState = {
  approved: "APPROVED",
  changes: "CHANGES_REQUESTED",
  commented: "COMMENTED",
} as const;
export type ReviewState = (typeof ReviewState)[keyof typeof ReviewState];

export interface SimReview {
  id: number;
  user: string;
  state: ReviewState;
  body: string;
  at: string;
  comments: number[];
}

export interface SimComment {
  id: number;
  pr: number;
  user: string;
  body: string;
  at: string;
  // A line comment belongs to a review and sits on a file of the diff.
  review?: number;
  path?: string;
  line?: number;
}

export const PullState = {
  open: "OPEN",
  closed: "CLOSED",
  merged: "MERGED",
} as const;
export type PullState = (typeof PullState)[keyof typeof PullState];

export interface SimPull {
  number: number;
  title: string;
  body: string;
  author: string;
  head: string;
  base: string;
  state: PullState;
  draft: boolean;
  createdAt: string;
  updatedAt: string;
  headCommittedAt: string;
  mergedAt: string | null;
  requested: string[];
  checks: SimCheck[];
  reviews: SimReview[];
  // The files its diff touches, and the new-side lines a review may comment on.
  files: string[];
  lines: { path: string; line: number }[];
  // Why the owner hears about it (GitHub's notification reason), once they do.
  subscribed: string | null;
}

// GitHub keeps one notification per thread: a new event bumps its time,
// reason and latest comment, so two events between polls are heard as one.
export interface SimNotification {
  id: string;
  pr: number;
  reason: string;
  updatedAt: string;
  latest: string | null;
}

export interface SimState {
  me: string;
  repo: string;
  // The scratch clone PR branches live in, and the owner's work there.
  checkout: string | null;
  base: string;
  commits: string[];
  work: { taskId: number | null; branch: string; path: string } | null;
  next: number;
  pulls: SimPull[];
  comments: SimComment[];
  notifications: SimNotification[];
  log: { at: string; line: string }[];
}

export function emptyState(over: Partial<SimState> = {}): SimState {
  return {
    me: SIM_ME,
    repo: SIM_REPO,
    checkout: null,
    base: "main",
    commits: [],
    work: null,
    next: 1,
    pulls: [],
    comments: [],
    notifications: [],
    log: [],
    ...over,
  };
}

export function statePath(home: string): string {
  return join(home, "sim", "github.json");
}

export function loadState(file: string): SimState {
  if (!existsSync(file)) return emptyState();
  return {
    ...emptyState(),
    ...(JSON.parse(readFileSync(file, "utf8")) as Partial<SimState>),
  };
}

// Written whole and renamed in, so a poll never reads half a file.
export function saveState(file: string, state: SimState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}

const API = "https://api.github.com";
const WEB = "https://github.com";

export const pullApi = (s: SimState, n: number) =>
  `${API}/repos/${s.repo}/pulls/${n}`;
export const pullWeb = (s: SimState, n: number) => `${WEB}/${s.repo}/pull/${n}`;
export const issueCommentApi = (s: SimState, id: number) =>
  `${API}/repos/${s.repo}/issues/comments/${id}`;
export const reviewApi = (s: SimState, n: number, id: number) =>
  `${API}/repos/${s.repo}/pulls/${n}/reviews/${id}`;

// ── REST (`gh api <path>`) ───────────────────────────────────────────────

export function toNotification(
  s: SimState,
  n: SimNotification,
): GhNotification {
  const pull = s.pulls.find((p) => p.number === n.pr);
  return {
    id: n.id,
    reason: n.reason,
    updated_at: n.updatedAt,
    subject: {
      title: pull?.title ?? `#${n.pr}`,
      url: pullApi(s, n.pr),
      latest_comment_url: n.latest,
      type: "PullRequest",
    },
    repository: { full_name: s.repo, html_url: `${WEB}/${s.repo}` },
  };
}

export function toPull(
  s: SimState,
  p: SimPull,
): GhPull & { title: string; draft: boolean; merged: boolean } {
  return {
    number: p.number,
    title: p.title,
    body: p.body,
    user: { login: p.author },
    html_url: pullWeb(s, p.number),
    created_at: p.createdAt,
    updated_at: p.updatedAt,
    state: p.state === PullState.open ? "open" : "closed",
    draft: p.draft,
    merged: p.state === PullState.merged,
    head: { ref: p.head },
    requested_reviewers: p.requested.map((login) => ({ login })),
    requested_teams: [],
  };
}

export function toComment(
  s: SimState,
  c: SimComment,
): GhItem & { path?: string; line?: number } {
  return {
    user: { login: c.user },
    body: c.body,
    html_url: `${pullWeb(s, c.pr)}#${c.review ? `discussion_r${c.id}` : `issuecomment-${c.id}`}`,
    created_at: c.at,
    updated_at: c.at,
    ...(c.path ? { path: c.path, line: c.line } : {}),
  };
}

// A review's notification carries its line comments in the body, so what
// aug reads off it (and hands an agent through `aug-tools feedback`) has
// them; GitHub would need one more call per comment.
export function toReview(s: SimState, pr: number, r: SimReview): GhItem {
  const lines = r.comments
    .map((id) => s.comments.find((c) => c.id === id))
    .filter((c): c is SimComment => Boolean(c))
    .map((c) => `${c.path}:${c.line}: ${c.body}`);
  return {
    user: { login: r.user },
    body: [r.body, ...lines].filter(Boolean).join("\n"),
    html_url: `${pullWeb(s, pr)}#pullrequestreview-${r.id}`,
    created_at: r.at,
    updated_at: r.at,
    state: r.state,
  };
}

function notFound(path: string): Error {
  return new Error(`HTTP 404: Not Found (the sim has no ${path})`);
}

export function answerRest(s: SimState, path: string): unknown {
  const [route, query = ""] = path.replace(`${API}/`, "").split("?");
  if (route === "user") return { login: s.me };
  if (route === "rate_limit") {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    return {
      resources: {
        core: { limit: 5000, remaining: 5000, reset },
        graphql: { limit: 5000, remaining: 5000, reset },
      },
    };
  }
  if (route === "notifications") {
    const since = new URLSearchParams(query).get("since");
    return s.notifications
      .filter((n) => !since || n.updatedAt >= since)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((n) => toNotification(s, n));
  }
  const prefix = `repos/${s.repo}/`;
  if (!route.startsWith(prefix)) throw notFound(path);
  const rest = route.slice(prefix.length).split("/");
  const num = (i: number) => Number(rest[i]);
  const pull = (n: number) => {
    const p = s.pulls.find((x) => x.number === n);
    if (!p) throw notFound(path);
    return p;
  };
  const comment = (id: number) => {
    const c = s.comments.find((x) => x.id === id);
    if (!c) throw notFound(path);
    return toComment(s, c);
  };
  const [a, b, c, d] = rest;
  if ((a === "issues" || a === "pulls") && b === "comments" && c)
    return comment(num(2));
  if (a === "pulls" && b && !c) return toPull(s, pull(num(1)));
  if (a === "issues" && b && !c) return toPull(s, pull(num(1)));
  if (a === "pulls" && c === "reviews") {
    const p = pull(num(1));
    if (!d) return p.reviews.map((r) => toReview(s, p.number, r));
    const r = p.reviews.find((x) => x.id === num(3));
    if (!r) throw notFound(path);
    return toReview(s, p.number, r);
  }
  if (a === "pulls" && c === "comments")
    return s.comments
      .filter((x) => x.pr === num(1) && x.review)
      .map((x) => toComment(s, x));
  if (a === "issues" && c === "comments")
    return s.comments
      .filter((x) => x.pr === num(1) && !x.review)
      .map((x) => toComment(s, x));
  if (a === "pulls" && c === "files")
    return pull(num(1)).files.map((filename) => ({
      filename,
      status: "modified",
    }));
  throw notFound(path);
}

// The fake `gh api`, reading the file each call.
export function simApi(file: string): GhApi {
  return async (path) => answerRest(loadState(file), path);
}

// ── GraphQL (the PR status batch) ────────────────────────────────────────

// What GitHub's reviewDecision would say: each reviewer's last approval or
// change request counts, a comment does not.
export function reviewDecision(p: SimPull): string {
  const last = new Map<string, ReviewState>();
  for (const r of p.reviews)
    if (r.state !== ReviewState.commented) last.set(r.user, r.state);
  const verdicts = [...last.values()];
  if (verdicts.includes(ReviewState.changes)) return "CHANGES_REQUESTED";
  if (verdicts.includes(ReviewState.approved)) return "APPROVED";
  return "REVIEW_REQUIRED";
}

export function toGqlPr(p: SimPull): GqlPr {
  return {
    state: p.state,
    isDraft: p.draft,
    reviewDecision: reviewDecision(p),
    mergeable: p.state === PullState.open ? "MERGEABLE" : "UNKNOWN",
    isInMergeQueue: false,
    mergeQueueEntry: null,
    timelineItems: { nodes: [] },
    commits: {
      nodes: [
        {
          commit: {
            committedDate: p.headCommittedAt,
            statusCheckRollup: p.checks.length
              ? {
                  contexts: {
                    nodes: p.checks.map((c) => ({
                      __typename: "CheckRun",
                      status: c.status,
                      conclusion: c.conclusion,
                    })),
                  },
                }
              : null,
          },
        },
      ],
    },
  };
}

// The answer GitHub's GraphQL gives the batch query (prBatchQuery): one
// alias per PR, null with an error beside it for one that is not there.
export function answerGraphql(s: SimState, prs: PrRef[]): GqlAnswer {
  const data: Record<string, unknown> = {
    rateLimit: {
      remaining: 5000,
      resetAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  };
  const errors: NonNullable<GqlAnswer["errors"]> = [];
  prs.forEach((pr, i) => {
    const alias = `p${i}`;
    if (pr.repo !== s.repo) {
      data[alias] = null;
      errors.push({
        message: `Could not resolve to a Repository with the name '${pr.repo}'.`,
        path: [alias],
      });
      return;
    }
    const p = s.pulls.find((x) => x.number === pr.number);
    data[alias] = { pullRequest: p ? toGqlPr(p) : null };
    if (!p)
      errors.push({
        message: `Could not resolve to a PullRequest with the number of ${pr.number}.`,
        path: [alias, "pullRequest"],
      });
  });
  return { data, ...(errors.length ? { errors } : {}) };
}

export function simPrFetch(file: string): PrFetch {
  return async (prs) => readPrBatch(prs, answerGraphql(loadState(file), prs));
}
