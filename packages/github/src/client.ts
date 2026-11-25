// The one door to gh. Every call Riker makes to GitHub (notifications, PR
// status, a review's context, a Send) goes through here, so GitHub's own
// word on its budgets is read in one place: `gh api -i` prints the status
// and headers, success or not. A call into a paused budget is refused
// before it reaches gh; a call that comes back rate limited pauses its
// budget (gate.ts) and is thrown as GhThrottled, whose message says until
// when. Nothing here retries: the connector's clock is the only retry.

import * as store from "@riker/core/store";
import { errorMessage, logger } from "@riker/core/log";
import {
  clockTime,
  GhBudget,
  ghTrouble,
  GhTrouble,
  GithubGate,
  PauseWhy,
  UNKNOWN_RESET_PAUSE_MS,
  type GateClock,
  type GhLimit,
  type GhRateLimit,
  type Pause,
} from "./gate";

const log = logger("github");

export interface GhRaw {
  code: number;
  stdout: string;
  stderr: string;
}

// Runs gh with these arguments. The real one spawns it; tests hand a fake.
export type GhRun = (args: string[]) => Promise<GhRaw>;

export async function spawnGh(args: string[]): Promise<GhRaw> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export interface GhResponse {
  // null when gh printed no status line (a plain gh command, or it never
  // reached GitHub).
  status: number | null;
  headers: Map<string, string>;
  body: string;
  stderr: string;
  code: number;
}

// `gh api -i` output: "HTTP/2.0 403 Forbidden", headers, a blank line, the
// body. A response that is not one passes through as body.
export function parseIncluded(raw: GhRaw): GhResponse {
  const headers = new Map<string, string>();
  let status: number | null = null;
  let body = raw.stdout;
  while (/^HTTP\/[\d.]+ \d{3}/.test(body)) {
    const end = body.search(/\r?\n\r?\n/);
    const head = end < 0 ? body : body.slice(0, end);
    body = end < 0 ? "" : body.slice(end).replace(/^\r?\n\r?\n/, "");
    const [statusLine, ...lines] = head.split(/\r?\n/);
    status = Number(statusLine!.split(" ")[1]);
    headers.clear();
    for (const line of lines) {
      const i = line.indexOf(":");
      if (i > 0) headers.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
    }
  }
  return { status, headers, body, stderr: raw.stderr, code: raw.code };
}

export interface RateHeaders {
  // The budget the headers are about (x-ratelimit-resource), when it is one
  // Riker spends; search and the rest are not tracked.
  budget: GhBudget | null;
  remaining: number | null;
  resetAt: number | null;
  retryAfterMs: number | null;
}

function num(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function rateHeaders(headers: Map<string, string>): RateHeaders {
  const resource = headers.get("x-ratelimit-resource");
  const budget =
    resource === GhBudget.rest ? GhBudget.rest : resource === GhBudget.graphql ? GhBudget.graphql : null;
  const reset = num(headers.get("x-ratelimit-reset"));
  const retry = num(headers.get("retry-after"));
  return {
    budget,
    remaining: num(headers.get("x-ratelimit-remaining")),
    resetAt: reset === null ? null : reset * 1000,
    retryAfterMs: retry === null ? null : retry * 1000,
  };
}

// GraphQL answers a spent budget with 200 and an error of type RATE_LIMITED.
function graphqlLimited(body: string): string | null {
  if (!body.includes("RATE_LIMITED")) return null;
  try {
    const answer = JSON.parse(body) as { errors?: { type?: string; message?: string }[] };
    const e = answer.errors?.find((x) => x.type === "RATE_LIMITED");
    return e ? (e.message ?? "rate limited") : null;
  } catch {
    return null;
  }
}

const SECONDARY = /secondary rate limit|abuse detection/i;

// Whether this response is GitHub saying slow down, and which kind. A 403
// alone is a permission, not a limit: it needs a spent budget, a
// retry-after or GitHub's words for one. `budget` is the one the call
// spent, for when the headers do not name it.
export function readLimit(res: GhResponse, budget: GhBudget): GhLimit | null {
  const h = rateHeaders(res.headers);
  const said = `${res.stderr}\n${res.status !== null && res.status >= 400 ? res.body : ""}`;
  const gqlLimited = graphqlLimited(res.body);
  const refused = res.status === 403 || res.status === 429;
  const words = ghTrouble(said) === GhTrouble.rateLimit;
  if (!refused && !gqlLimited && !(res.status === null && words)) return null;
  if (refused && !words && h.remaining !== 0 && h.retryAfterMs === null && res.status === 403)
    return null;
  const on = h.budget ?? budget;
  if (h.retryAfterMs !== null) return { kind: "secondary", budget: on, retryAfterMs: h.retryAfterMs };
  if (h.remaining === 0) return { kind: "primary", budget: on, resetAt: h.resetAt };
  if (SECONDARY.test(said) || (h.remaining !== null && h.remaining > 0))
    return { kind: "secondary", budget: on, retryAfterMs: null };
  // Limited, but nothing said which way: the free rate_limit call settles it.
  return { kind: "primary", budget: on, resetAt: null };
}

export function throttledWords(p: Pause): string {
  const at = clockTime(p.until);
  if (p.why === PauseWhy.secondary) return `GitHub secondary rate limit, waiting until ${at}`;
  if (p.why === PauseWhy.reserve) return `GitHub rate limit budget low, saving it until ${at}`;
  return `GitHub rate limited until ${at}`;
}

// A call refused for a rate limit, now or before it was made. Its message
// reads as a rate limit to ghTrouble, so every caller's limit path takes it.
export class GhThrottled extends Error {
  constructor(
    readonly budget: GhBudget,
    readonly pause: Pause,
  ) {
    super(throttledWords(pause));
  }
}

export interface CallOptions {
  // The owner's own press (Send, a guide): it may spend into the reserve,
  // never past a rate limit.
  owner?: boolean;
}

export interface GithubClientOptions {
  run?: GhRun;
  clock?: GateClock;
}

const PAUSE_KEY = (budget: GhBudget) => `github.pause.${budget}`;

export class GithubClient {
  private theGate: GithubGate | null = null;
  private baseMs: () => number = () => 120_000;
  private run: GhRun;
  private clock: GateClock | undefined;

  constructor(options: GithubClientOptions = {}) {
    this.run = options.run ?? spawnGh;
    this.clock = options.clock;
  }

  // The poll interval, which the gate's backoff steps from.
  pollEvery(baseMs: () => number): void {
    this.baseMs = baseMs;
  }

  // Made on first use, once the store is open. A pause outlives a restart:
  // GitHub's reset does not move because Riker did.
  gate(): GithubGate {
    if (this.theGate) return this.theGate;
    const gate = new GithubGate(() => this.baseMs(), this.clock);
    for (const budget of Object.values(GhBudget)) {
      try {
        const saved = store.kvGet(PAUSE_KEY(budget));
        if (!saved) continue;
        const p = JSON.parse(saved) as Pause;
        gate.hold(budget, p.until, p.why);
      } catch {
        // A pause that cannot be read is no pause.
      }
    }
    this.theGate = gate;
    return gate;
  }

  hold(budget: GhBudget, until: number, why: Pause["why"]): Pause | null {
    const gate = this.gate();
    gate.hold(budget, until, why);
    return this.saved(budget);
  }

  limited(limit: GhLimit): Pause {
    const p = this.gate().limited(limit);
    this.saved(limit.budget);
    log.warn("github throttled", {
      budget: limit.budget,
      kind: limit.kind,
      why: p.why,
      until: new Date(p.until).toISOString(),
    });
    return p;
  }

  private saved(budget: GhBudget): Pause | null {
    const p = this.gate().pause(budget);
    if (p) store.kvSet(PAUSE_KEY(budget), JSON.stringify(p));
    return p;
  }

  private now(): number {
    return this.clock ? this.clock.now() : Date.now();
  }

  // A REST call; GET unless fields say otherwise (gh posts with -f).
  async api(path: string, fields: Record<string, string> = {}, options: CallOptions = {}): Promise<unknown> {
    const args = ["api", "-i", path];
    for (const [k, v] of Object.entries(fields)) args.push("-f", `${k}=${v}`);
    const res = await this.call(GhBudget.rest, args, options);
    return JSON.parse(res.body || "null") as unknown;
  }

  // A GraphQL call. The answer comes back whole, errors and all: gh exits
  // 1 when part of it failed (one PR deleted), and the caller reads which.
  async graphql(
    query: string,
    vars: Record<string, string | number> = {},
    options: CallOptions = {},
  ): Promise<unknown> {
    const args = ["api", "graphql", "-i", "-f", `query=${query}`];
    for (const [k, v] of Object.entries(vars)) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
    const res = await this.call(GhBudget.graphql, args, options);
    return JSON.parse(res.body) as unknown;
  }

  // A gh command that is not `gh api` (gh pr merge, gh pr review): no
  // headers, so only its words say it was limited. gh's own commands
  // speak GraphQL.
  async cli(args: string[], options: CallOptions = {}): Promise<string> {
    const res = await this.call(GhBudget.graphql, args, options);
    return res.body.trim();
  }

  private async call(budget: GhBudget, args: string[], options: CallOptions): Promise<GhResponse> {
    const gate = this.gate();
    const held = gate.pause(budget);
    if (held && !(options.owner && held.why === PauseWhy.reserve)) throw new GhThrottled(budget, held);
    const res = parseIncluded(await this.run(args));
    const limit = readLimit(res, budget);
    if (limit) {
      const settled =
        limit.kind === "primary" && limit.resetAt === null ? await this.settle(limit.budget) : limit;
      throw new GhThrottled(settled.budget, this.limited(settled));
    }
    const h = rateHeaders(res.headers);
    if (h.budget && h.remaining !== null && h.resetAt !== null) {
      const p = gate.observe(h.budget, h.remaining, h.resetAt);
      if (p) {
        this.saved(h.budget);
        log.info("github budget low", { budget: h.budget, remaining: h.remaining });
      }
    }
    // A 2xx is an answer even when gh exits 1 (a GraphQL answer with errors).
    const ok = res.status === null ? res.code === 0 : res.status < 300;
    if (!ok) {
      const said = res.stderr.trim();
      throw new Error(said || `gh ${args[0]} ${args[1] ?? ""} exited ${res.code}`.trim());
    }
    return res;
  }

  // Asked past any pause, for a limit gh said in words only: whether the
  // budget is spent (wait for its reset) or not (a secondary limit). The
  // live headers first: gh api rate_limit's body has been seen saying
  // thousands of GraphQL points left while GraphQL's own headers said 0.
  // A rateLimit-only query still answers when the budget is spent.
  private async settle(budget: GhBudget): Promise<GhLimit> {
    const args =
      budget === GhBudget.graphql
        ? ["api", "graphql", "-i", "-f", "query={ rateLimit { remaining resetAt } }"]
        : ["api", "-i", "rate_limit"];
    try {
      const res = parseIncluded(await this.run(args));
      const h = rateHeaders(res.headers);
      let remaining = h.budget === budget ? h.remaining : null;
      let resetAt = h.budget === budget ? h.resetAt : null;
      if (remaining === null || resetAt === null) {
        const r = (JSON.parse(res.body) as GhRateLimit).resources?.[budget];
        remaining = r?.remaining ?? null;
        resetAt = typeof r?.reset === "number" ? r.reset * 1000 : null;
      }
      if (remaining !== null && resetAt !== null) {
        if (remaining > 0) return { kind: "secondary", budget, retryAfterMs: null };
        return { kind: "primary", budget, resetAt };
      }
    } catch (err) {
      log.warn("rate limit lookup failed", { err: errorMessage(err) });
    }
    return { kind: "primary", budget, resetAt: this.now() + UNKNOWN_RESET_PAUSE_MS };
  }
}
