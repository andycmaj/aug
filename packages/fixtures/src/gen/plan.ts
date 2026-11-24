// The review activity generator plays the other side of a code review for
// dogfooding: it opens PRs that ask the owner (or their team) to review, and
// answers their reviews the way an author would. This file is its whole
// judgement, with no I/O: given its PRs and the clock, what to do next.

export const Ask = { me: "me", team: "team" } as const;
export type Ask = (typeof Ask)[keyof typeof Ask];

export const PrState = { open: "open", closed: "closed", merged: "merged" } as const;
export type PrState = (typeof PrState)[keyof typeof PrState];

export const Verdict = {
  approved: "APPROVED",
  changes: "CHANGES_REQUESTED",
  commented: "COMMENTED",
} as const;
export type Verdict = (typeof Verdict)[keyof typeof Verdict];

// One of the generator's own PRs, as its target reads it back.
export interface GenPr {
  number: number;
  url: string;
  state: PrState;
  // Last activity of anyone's on it.
  updatedAt: string;
  // The head commit's time: a review after it has not been answered.
  pushedAt: string;
  // The owner's latest review, if they have reviewed it.
  mine: { verdict: Verdict; at: string } | null;
  // When the generator last answered a review that was not a change (a
  // comment), so it answers each once.
  repliedAt: string | null;
}

export interface Limits {
  // At most this many of its PRs open at once.
  maxOpen: number;
  // A new PR at most this often.
  everyMs: number;
  // Local hours it opens new PRs in, [from, to).
  hours: [number, number];
  // An open PR nobody touched this long is closed.
  staleMs: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxOpen: 5,
  everyMs: 30 * 60_000,
  hours: [9, 18],
  staleMs: 7 * 24 * 3600_000,
};

export type Move =
  // A new PR asking a review.
  | { type: "open"; ask: Ask }
  // Changes were asked: push a follow-up, reply, and ask again.
  | { type: "follow-up"; pr: number }
  // A comment review: answer it once, ask nothing.
  | { type: "reply"; pr: number }
  | { type: "merge"; pr: number }
  | { type: "close"; pr: number };

export interface Clock {
  now: Date;
  // When it last opened a PR (null: never).
  lastOpened: string | null;
  // Who the next new PR asks.
  nextAsk: Ask;
  // Whether a team is set up to ask; without one, every PR asks the owner.
  hasTeam: boolean;
}

const after = (a: string, b: string) => Date.parse(a) > Date.parse(b);

// What to do for one open PR, by the owner's latest review: approve merges
// it, changes get a follow-up, a comment gets one reply; untouched for too
// long, it is closed.
export function answer(pr: GenPr, now: Date, limits: Limits = DEFAULT_LIMITS): Move | null {
  if (pr.state !== PrState.open) return null;
  const mine = pr.mine;
  if (mine && after(mine.at, pr.pushedAt)) {
    if (mine.verdict === Verdict.approved) return { type: "merge", pr: pr.number };
    if (mine.verdict === Verdict.changes) return { type: "follow-up", pr: pr.number };
    if (mine.verdict === Verdict.commented && !(pr.repliedAt && after(pr.repliedAt, mine.at)))
      return { type: "reply", pr: pr.number };
  }
  if (now.getTime() - Date.parse(pr.updatedAt) > limits.staleMs) return { type: "close", pr: pr.number };
  return null;
}

// Whether a new PR is due: inside its hours, under its cap, and long enough
// since the last one.
export function openDue(prs: GenPr[], clock: Clock, limits: Limits = DEFAULT_LIMITS): boolean {
  const hour = clock.now.getHours();
  const [from, to] = limits.hours;
  if (hour < from || hour >= to) return false;
  if (prs.filter((p) => p.state === PrState.open).length >= limits.maxOpen) return false;
  return !clock.lastOpened || clock.now.getTime() - Date.parse(clock.lastOpened) >= limits.everyMs;
}

// One tick of the stream: answer every PR, then maybe open one.
export function plan(prs: GenPr[], clock: Clock, limits: Limits = DEFAULT_LIMITS): Move[] {
  const moves = prs.flatMap((p) => {
    const m = answer(p, clock.now, limits);
    return m ? [m] : [];
  });
  // A PR merged or closed this tick frees its place.
  const leaving = new Set(moves.filter((m) => m.type === "merge" || m.type === "close").map((m) => m.pr));
  const staying = prs.filter((p) => !leaving.has(p.number));
  if (openDue(staying, clock, limits))
    moves.push({ type: "open", ask: clock.hasTeam ? clock.nextAsk : Ask.me });
  return moves;
}

export function nextAsk(ask: Ask): Ask {
  return ask === Ask.me ? Ask.team : Ask.me;
}
