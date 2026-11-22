import { describe, expect, test } from "bun:test";
import {
  BACKOFF_CAP_MS,
  GhBudget,
  ghTrouble,
  GithubGate,
  limitedUntil,
  PauseWhy,
  SECONDARY_PAUSE_MS,
  UNKNOWN_RESET_PAUSE_MS,
} from "../src/gate";

describe("what went wrong", () => {
  test("rate limits, by what gh says", () => {
    for (const said of [
      "GraphQL: API rate limit already exceeded for user ID 97470.",
      "gh: API rate limit exceeded for user ID 1. (HTTP 403)",
      "You have exceeded a secondary rate limit. Please wait a few minutes",
      "HTTP 429: Too Many Requests",
    ])
      expect(ghTrouble(said)).toBe("rate_limit");
  });

  test("server errors and dropped connections pass", () => {
    for (const said of [
      "HTTP 502: Bad Gateway (https://api.github.com/graphql)",
      "HTTP 503: No server is currently available to service your request.",
      'Post "https://api.github.com/graphql": read tcp: connection reset by peer',
      "net/http: TLS handshake timeout",
    ])
      expect(ghTrouble(said)).toBe("transient");
    expect(ghTrouble("Could not resolve to a PullRequest")).toBe("other");
  });
});

describe("the gate", () => {
  const clock = (random = 1) => {
    const c = { t: 1_000_000, now: () => c.t, random: () => random };
    return c;
  };

  test("backs off doubling, capped, and opens again on success", () => {
    const c = clock();
    const gate = new GithubGate(() => 120_000, c);
    expect(gate.backoff()).toBeNull();
    expect(gate.failed("502") - c.t).toBe(240_000);
    expect(gate.failed("502") - c.t).toBe(480_000);
    for (let i = 0; i < 10; i++) gate.failed("502");
    expect(gate.failed("502") - c.t).toBe(BACKOFF_CAP_MS);
    expect(gate.backoff()?.error).toBe("502");
    gate.succeeded();
    expect(gate.backoff()).toBeNull();
    expect(gate.failed("502") - c.t).toBe(240_000);
  });

  test("jitter waits at least half the step", () => {
    const c = clock(0);
    const gate = new GithubGate(() => 120_000, c);
    expect(gate.failed("reset") - c.t).toBe(120_000);
  });

  test("a pause holds one budget until it ends, and only lengthens", () => {
    const c = clock();
    const gate = new GithubGate(() => 120_000, c);
    gate.hold(GhBudget.graphql, c.t + 60_000, PauseWhy.rateLimit);
    gate.hold(GhBudget.graphql, c.t + 10_000, PauseWhy.reserve);
    expect(gate.pause(GhBudget.graphql)).toEqual({
      until: c.t + 60_000,
      why: PauseWhy.rateLimit,
    });
    expect(gate.pause(GhBudget.rest)).toBeNull();
    c.t += 60_000;
    expect(gate.pause(GhBudget.graphql)).toBeNull();
  });
});

describe("when a rate limit ends", () => {
  const now = 1_000_000;
  test("the spent budget's reset", () => {
    const limits = { resources: { graphql: { remaining: 0, reset: 5_000 } } };
    expect(limitedUntil(GhBudget.graphql, limits, now)).toBe(5_000_000);
  });
  test("a secondary limit (budget left) waits a few minutes", () => {
    const limits = { resources: { core: { remaining: 3000, reset: 5_000 } } };
    expect(limitedUntil(GhBudget.rest, limits, now)).toBe(now + SECONDARY_PAUSE_MS);
  });
  test("no answer waits longer", () => {
    expect(limitedUntil(GhBudget.rest, null, now)).toBe(now + UNKNOWN_RESET_PAUSE_MS);
  });
});
