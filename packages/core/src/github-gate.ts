// When Riker may call GitHub next. Riker shares the owner's API budget with
// their own gh and their agents', so a rate limit pauses that budget's calls
// until GitHub says it is back, and Riker stops short of draining it
// (GRAPHQL_RESERVE). A 5xx or a dropped connection backs off, doubling each
// time it happens again, until a call works; one PR that keeps failing backs
// off on its own without holding up the rest.

// The two budgets Riker spends: REST (notifications) and GraphQL (PR status).
export const GhBudget = { rest: "core", graphql: "graphql" } as const;
export type GhBudget = (typeof GhBudget)[keyof typeof GhBudget];

export const GhTrouble = {
  rateLimit: "rate_limit",
  transient: "transient",
  other: "other",
} as const;
export type GhTrouble = (typeof GhTrouble)[keyof typeof GhTrouble];

// gh says "API rate limit exceeded", "API rate limit already exceeded",
// "You have exceeded a secondary rate limit", or just the status.
const RATE_LIMIT = /rate limit|HTTP 429|abuse detection/i;
const TRANSIENT =
  /HTTP 5\d\d|\b50[0234]\b|no server is currently available|connection reset|ECONNRESET|ETIMEDOUT|timed? ?out|unexpected EOF|TLS handshake|could not resolve host|no such host|network is unreachable|connection refused|something went wrong/i;

export function ghTrouble(message: string): GhTrouble {
  if (RATE_LIMIT.test(message)) return GhTrouble.rateLimit;
  if (TRANSIENT.test(message)) return GhTrouble.transient;
  return GhTrouble.other;
}

// What GitHub left of a budget, from rateLimit in a GraphQL answer.
export interface GhRemaining {
  remaining: number;
  resetAt: string;
}

// Below this many GraphQL points Riker stops reading PR status until the
// reset, so the owner's own gh and their agents keep the rest.
export const GRAPHQL_RESERVE = 1000;
// A secondary rate limit says no reset time; GitHub asks for a minute or
// more. Without any answer at all, wait a while.
export const SECONDARY_PAUSE_MS = 5 * 60_000;
export const UNKNOWN_RESET_PAUSE_MS = 15 * 60_000;
export const BACKOFF_CAP_MS = 30 * 60_000;

export const PauseWhy = {
  rateLimit: "rate limited",
  reserve: "saving budget",
} as const;
export type PauseWhy = (typeof PauseWhy)[keyof typeof PauseWhy];

export interface Pause {
  until: number;
  why: PauseWhy;
}

export interface GateClock {
  now(): number;
  random(): number;
}

const realClock: GateClock = { now: Date.now, random: Math.random };

export class GithubGate {
  private paused = new Map<GhBudget, Pause>();
  private failures = 0;
  private backoffUntil = 0;
  private lastError: string | null = null;
  private prs = new Map<string, { n: number; until: number }>();

  // baseMs is the poll interval: the first backoff is about two of them.
  constructor(
    private baseMs: () => number,
    private clock: GateClock = realClock,
  ) {}

  pause(budget: GhBudget): Pause | null {
    const p = this.paused.get(budget);
    if (!p) return null;
    if (p.until > this.clock.now()) return p;
    this.paused.delete(budget);
    return null;
  }

  // Pauses only ever lengthen: a later, shorter answer does not cut one.
  hold(budget: GhBudget, until: number, why: PauseWhy): void {
    const had = this.pause(budget);
    if (had && had.until >= until) return;
    this.paused.set(budget, { until, why });
  }

  // While backing off, when the next poll may run and what failed last.
  backoff(): { until: number; error: string } | null {
    if (this.backoffUntil <= this.clock.now()) return null;
    return { until: this.backoffUntil, error: this.lastError ?? "failed" };
  }

  failed(error: string): number {
    this.failures++;
    this.lastError = error;
    this.backoffUntil = this.clock.now() + this.delay(this.failures);
    return this.backoffUntil;
  }

  succeeded(): void {
    this.failures = 0;
    this.backoffUntil = 0;
    this.lastError = null;
  }

  prAllowed(url: string): boolean {
    const p = this.prs.get(url);
    return !p || p.until <= this.clock.now();
  }

  prFailed(url: string): void {
    const n = (this.prs.get(url)?.n ?? 0) + 1;
    this.prs.set(url, { n, until: this.clock.now() + this.delay(n) });
  }

  prSucceeded(url: string): void {
    this.prs.delete(url);
  }

  // Doubling from twice the poll interval, capped, with equal jitter so a
  // restart of several clients does not line up on the same second.
  private delay(n: number): number {
    const full = Math.min(this.baseMs() * 2 ** n, BACKOFF_CAP_MS);
    return full / 2 + (this.clock.random() * full) / 2;
  }
}

// gh api rate_limit: free, and counts against nothing.
export interface GhRateLimit {
  resources?: Partial<
    Record<GhBudget, { remaining?: number; reset?: number } | undefined>
  >;
}

// When a rate-limited budget is back: its reset when it is spent, a short
// wait when it is not (a secondary limit), a longer one when nothing said.
export function limitedUntil(
  budget: GhBudget,
  limits: GhRateLimit | null,
  now: number,
): number {
  const r = limits?.resources?.[budget];
  if (!r || typeof r.reset !== "number") return now + UNKNOWN_RESET_PAUSE_MS;
  if ((r.remaining ?? 0) > 0) return now + SECONDARY_PAUSE_MS;
  return Math.max(r.reset * 1000, now + 60_000);
}

export function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}
