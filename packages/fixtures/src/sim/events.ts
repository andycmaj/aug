// What happens on the simulator's GitHub: each event changes the state file
// the way the real one would, notifications included. `bun run sim:do`
// applies one; a scenario is a list of them with waits between.

import { diffLines, makeBranch } from "./checkout";
import {
  CheckStatus,
  loadState,
  pullApi,
  PullState,
  issueCommentApi,
  reviewApi,
  ReviewState,
  saveState,
  type SimPull,
  type SimState,
} from "./github";

export const Verdict = {
  approve: "approve",
  changes: "changes",
  comment: "comment",
} as const;
export type Verdict = (typeof Verdict)[keyof typeof Verdict];

export type SimEvent =
  | {
      type: "pr-open";
      by?: string;
      title?: string;
      body?: string;
      // The owner's own PR (from the sim's work branch), asking `reviewer`.
      mine?: boolean;
      reviewer?: string;
      // Ask a team (a slug in the repo's org) instead of a person.
      team?: string;
    }
  // Ask the owner's review again (after they reviewed, or of the team).
  | { type: "rerequest"; pr?: number; by?: string }
  | { type: "close"; pr?: number; by?: string }
  | { type: "comment"; pr?: number; by?: string; body?: string }
  | { type: "mention"; pr?: number; by?: string; body?: string }
  | {
      type: "review";
      pr?: number;
      by?: string;
      verdict: Verdict;
      comments?: number;
      body?: string;
    }
  | { type: "ci"; pr?: number; result: "fail" | "pass" | "pending" }
  | { type: "push"; pr?: number; by?: string }
  | { type: "merge"; pr?: number; by?: string };

export type EventType = SimEvent["type"];

export interface Applied {
  said: string;
  opened?: SimPull;
}

const now = () => new Date().toISOString();

const SAYINGS: Record<Verdict, string[]> = {
  approve: ["Looks good to me.", "LGTM, ship it."],
  changes: ["A few things to fix before this goes in.", "Needs another pass."],
  comment: ["Some thoughts, nothing blocking.", "Left a couple of questions."],
};

const LINE_SAYINGS = [
  "Can this be simpler?",
  "This needs a test.",
  "Why is this needed here?",
  "Nit: naming.",
  "What happens when this is empty?",
  "Could this be a constant?",
];

function pick<T>(list: T[], i: number): T {
  return list[i % list.length];
}

// The PR an event is about: the one named, else the newest still open.
function target(s: SimState, n: number | undefined): SimPull {
  const p =
    n === undefined
      ? [...s.pulls].reverse().find((x) => x.state === PullState.open)
      : s.pulls.find((x) => x.number === n);
  if (!p)
    throw new Error(
      n === undefined ? "no open PR: open one with pr-open" : `no PR #${n}`,
    );
  return p;
}

// GitHub tells the owner about a thread they take part in, never about
// their own doing: one notification per PR, bumped by each event.
function notify(
  s: SimState,
  p: SimPull,
  by: string,
  latest: string | null,
  reason?: string,
): void {
  if (by === s.me) return;
  const why = reason ?? p.subscribed;
  if (!why) return;
  p.subscribed ??= why;
  const at = now();
  const id = String(1000 + p.number);
  const existing = s.notifications.find((n) => n.id === id);
  const next = { id, pr: p.number, reason: why, updatedAt: at, latest };
  if (existing) Object.assign(existing, next);
  else s.notifications.push(next);
}

function touch(p: SimPull): void {
  p.updatedAt = now();
}

function openPr(
  s: SimState,
  e: Extract<SimEvent, { type: "pr-open" }>,
): Applied {
  const number = (s.pulls.at(-1)?.number ?? 0) + 1;
  const mine = Boolean(e.mine);
  const author = mine ? s.me : (e.by ?? "bob");
  const reviewer = e.team ? null : (e.reviewer ?? (mine ? "alice" : s.me));
  let head = mine && s.work ? s.work.branch : `sim/pr-${number}`;
  if (!mine && s.checkout && s.commits.length)
    makeBranch(s.checkout, head, s.commits, number - 1, s.base);
  if (!s.checkout) head = mine ? "sim/work" : head;
  const diff = s.checkout
    ? diffLines(s.checkout, s.base, head)
    : { files: [], lines: [] };
  const at = now();
  const p: SimPull = {
    number,
    title:
      e.title ??
      (mine
        ? "Simulated work from the riker checkout"
        : `Simulated change #${number}`),
    body:
      e.body ??
      `What this PR changes (${diff.files.length} files). Simulated: nothing here is on GitHub.`,
    author,
    head,
    base: s.base,
    state: PullState.open,
    draft: false,
    createdAt: at,
    updatedAt: at,
    headCommittedAt: at,
    mergedAt: null,
    requested: reviewer ? [reviewer] : [],
    teams: e.team ? [e.team] : [],
    checks: [{ name: "test", status: CheckStatus.running, conclusion: null }],
    reviews: [],
    files: diff.files,
    lines: diff.lines,
    subscribed: mine ? "author" : null,
  };
  s.pulls.push(p);
  // GitHub tells the owner of a team's ask too, when they are on it.
  if (reviewer === s.me || e.team)
    notify(s, p, author, pullApi(s, number), "review_requested");
  return {
    said: `#${number} opened by ${author}, review asked of ${e.team ? `team ${e.team}` : reviewer}${mine ? ` (head ${head})` : ""}`,
    opened: p,
  };
}

function comment(
  s: SimState,
  e: { pr?: number; by?: string; body?: string },
  mention: boolean,
): Applied {
  const p = target(s, e.pr);
  const by = e.by ?? (p.author === s.me ? "alice" : p.author);
  const id = s.next++;
  const body =
    e.body ??
    (mention
      ? `@${s.me} can you take a look at this?`
      : "Thanks, one question on the approach.");
  s.comments.push({ id, pr: p.number, user: by, body, at: now() });
  if (by === s.me) p.subscribed ??= "comment";
  touch(p);
  notify(s, p, by, issueCommentApi(s, id), mention ? "mention" : undefined);
  return {
    said: `${by} ${mention ? "mentioned you" : "commented"} on #${p.number}`,
  };
}

function review(
  s: SimState,
  e: Extract<SimEvent, { type: "review" }>,
): Applied {
  const p = target(s, e.pr);
  const by = e.by ?? (p.author === s.me ? (p.requested[0] ?? "alice") : s.me);
  const id = s.next++;
  const count = e.comments ?? (e.verdict === Verdict.approve ? 0 : 2);
  const ids: number[] = [];
  const at = now();
  for (let i = 0; i < count; i++) {
    const spot = p.lines.length
      ? p.lines[Math.floor(((i + 0.5) * p.lines.length) / count)]
      : {
          path: p.files[i % Math.max(1, p.files.length)] ?? "README.md",
          line: 1,
        };
    const cid = s.next++;
    s.comments.push({
      id: cid,
      pr: p.number,
      user: by,
      body: pick(LINE_SAYINGS, cid),
      at,
      review: id,
      ...spot,
    });
    ids.push(cid);
  }
  const state =
    e.verdict === Verdict.approve
      ? ReviewState.approved
      : e.verdict === Verdict.changes
        ? ReviewState.changes
        : ReviewState.commented;
  p.reviews.push({
    id,
    user: by,
    state,
    body: e.body ?? pick(SAYINGS[e.verdict], id),
    at,
    comments: ids,
  });
  p.requested = p.requested.filter((r) => r !== by);
  touch(p);
  notify(s, p, by, reviewApi(s, p.number, id));
  return {
    said: `${by} reviewed #${p.number}: ${state.toLowerCase()}, ${count} line comment${count === 1 ? "" : "s"}`,
  };
}

function ci(s: SimState, e: Extract<SimEvent, { type: "ci" }>): Applied {
  const p = target(s, e.pr);
  p.checks = p.checks.map((c) =>
    e.result === "pending"
      ? { ...c, status: CheckStatus.running, conclusion: null }
      : {
          ...c,
          status: CheckStatus.done,
          conclusion: e.result === "pass" ? "SUCCESS" : "FAILURE",
        },
  );
  if (!p.checks.length)
    p.checks = [
      {
        name: "test",
        status: CheckStatus.done,
        conclusion: e.result === "pass" ? "SUCCESS" : "FAILURE",
      },
    ];
  touch(p);
  return { said: `CI on #${p.number}: ${e.result}` };
}

function push(s: SimState, e: Extract<SimEvent, { type: "push" }>): Applied {
  const p = target(s, e.pr);
  p.headCommittedAt = now();
  p.checks = p.checks.map((c) => ({
    ...c,
    status: CheckStatus.running,
    conclusion: null,
  }));
  touch(p);
  return { said: `pushed to #${p.number}: CI running again` };
}

function rerequest(s: SimState, e: Extract<SimEvent, { type: "rerequest" }>): Applied {
  const p = target(s, e.pr);
  const by = e.by ?? p.author;
  if (!p.requested.includes(s.me)) p.requested.push(s.me);
  touch(p);
  notify(s, p, by, pullApi(s, p.number), "review_requested");
  return { said: `${by} asked your review of #${p.number} again` };
}

function close(s: SimState, e: Extract<SimEvent, { type: "close" }>): Applied {
  const p = target(s, e.pr);
  p.state = PullState.closed;
  p.requested = [];
  p.teams = [];
  touch(p);
  return { said: `#${p.number} closed by ${e.by ?? p.author}` };
}

function merge(s: SimState, e: Extract<SimEvent, { type: "merge" }>): Applied {
  const p = target(s, e.pr);
  p.state = PullState.merged;
  p.mergedAt = now();
  p.requested = [];
  touch(p);
  return { said: `#${p.number} merged by ${e.by ?? p.author}` };
}

export function applyEvent(s: SimState, e: SimEvent): Applied {
  const done = (() => {
    switch (e.type) {
      case "pr-open":
        return openPr(s, e);
      case "comment":
        return comment(s, e, false);
      case "mention":
        return comment(s, e, true);
      case "review":
        return review(s, e);
      case "ci":
        return ci(s, e);
      case "push":
        return push(s, e);
      case "merge":
        return merge(s, e);
      case "rerequest":
        return rerequest(s, e);
      case "close":
        return close(s, e);
    }
  })();
  s.log.push({ at: now(), line: done.said });
  return done;
}

// Read, change, write: the file is the only state, shared by processes.
export function applyToFile(file: string, e: SimEvent): Applied {
  const s = loadState(file);
  const done = applyEvent(s, e);
  saveState(file, s);
  return done;
}

// ── scenarios ────────────────────────────────────────────────────────────

export interface Scenario {
  about: string;
  // Each step waits this long (ms) after the one before.
  steps: { wait: number; event: SimEvent }[];
}

export const SCENARIOS: Record<string, Scenario> = {
  "review-cycle": {
    about:
      "Your PR from the work task: changes asked with line comments, CI red, a push, CI green, approved, merged",
    steps: [
      {
        wait: 2_000,
        event: { type: "pr-open", mine: true, reviewer: "alice" },
      },
      {
        wait: 4_000,
        event: {
          type: "review",
          by: "alice",
          verdict: Verdict.changes,
          comments: 3,
        },
      },
      { wait: 4_000, event: { type: "ci", result: "fail" } },
      { wait: 6_000, event: { type: "push" } },
      { wait: 4_000, event: { type: "ci", result: "pass" } },
      {
        wait: 4_000,
        event: { type: "review", by: "alice", verdict: Verdict.approve },
      },
      { wait: 4_000, event: { type: "merge", by: "you" } },
    ],
  },
  "review-ask": {
    about:
      "bob asks your review, then pings you, CI passes, carol approves, bob merges",
    steps: [
      {
        wait: 2_000,
        event: {
          type: "pr-open",
          by: "bob",
          title: "Tidy the rail's sub line",
        },
      },
      { wait: 5_000, event: { type: "ci", result: "pass" } },
      { wait: 5_000, event: { type: "mention", by: "bob" } },
      {
        wait: 5_000,
        event: { type: "review", by: "carol", verdict: Verdict.approve },
      },
      { wait: 5_000, event: { type: "merge", by: "bob" } },
    ],
  },
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function playScenario(
  name: string,
  file: string,
  opts: {
    speed?: number;
    onApplied?: (done: Applied, e: SimEvent) => void;
  } = {},
): Promise<void> {
  const scenario = SCENARIOS[name];
  if (!scenario)
    throw new Error(
      `no scenario "${name}" (one of ${Object.keys(SCENARIOS).join(", ")})`,
    );
  for (const step of scenario.steps) {
    await sleep(step.wait * (opts.speed ?? 1));
    const done = applyToFile(file, step.event);
    opts.onApplied?.(done, step.event);
  }
}
