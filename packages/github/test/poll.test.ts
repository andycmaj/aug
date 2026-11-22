import { beforeEach, describe, expect, test } from "bun:test";
import { Engine } from "@riker/core/engine";
import { linkPr } from "@riker/core/feedback";
import { GhBudget } from "../src/gate";
import { setMux } from "@riker/core/mux";
import type { PrFetch } from "../src/pr-status";
import { githubPlugin } from "../src/index";
import * as store from "@riker/core/store";
import { Kind } from "@riker/core/types";
import { FakeMux } from "@riker/core/test/support/fake-mux";
import { freshHome, testConfig } from "@riker/core/test/support/helpers";

beforeEach(() => {
  freshHome();
  setMux(new FakeMux());
});

function prTask(n: number) {
  const t = store.createTask({
    title: `PR ${n}`,
    kind: Kind.coding,
    channel: "github",
    repo: "acme/ledger",
  });
  linkPr(t.id, `https://github.com/acme/ledger/pull/${n}`);
  return t;
}

const reset = 2_000_000;

function fakeGithub(options: {
  notifications?: () => unknown;
  prs: PrFetch;
}) {
  const clock = { t: 1_000_000_000, now: () => clock.t, random: () => 1 };
  const calls: string[] = [];
  const api = async (path: string) => {
    calls.push(path.split("?")[0]);
    if (path === "user") return { login: "me" };
    if (path === "rate_limit")
      return {
        resources: {
          core: { remaining: 4000, reset },
          graphql: { remaining: 0, reset },
        },
      };
    return options.notifications ? options.notifications() : [];
  };
  const prs: PrFetch = async (refs) => {
    calls.push("graphql");
    return options.prs(refs);
  };
  const github = githubPlugin({ api, prs, clock });
  const engine = new Engine({
    config: testConfig(),
    offline: true,
    plugins: [github],
  });
  return { engine, github: github.connector, calls, clock };
}

const open: PrFetch = async (refs) => ({
  views: new Map(refs.map((r) => [r.url, { state: "OPEN" }])),
  budget: { remaining: 4000, resetAt: new Date(reset * 1000).toISOString() },
});

describe("the GitHub status line", () => {
  test("PRs that could not be read are not 'up to date'", async () => {
    for (let n = 1; n <= 3; n++) prTask(n);
    const { engine, github } = fakeGithub({
      prs: async (refs) => ({
        views: new Map(
          refs.map((r) => [
            r.url,
            r.url.endsWith("/1") ? { state: "OPEN" } : new Error("HTTP 502: Bad Gateway"),
          ]),
        ),
        budget: null,
      }),
    });
    await github.poll();
    expect(engine.status.github.state).toBe("ok");
    expect(engine.status.github.detail).toBe(
      "up to date · 2 PRs failed: HTTP 502: Bad Gateway",
    );
  });

  test("every PR failing is an error, and the next poll backs off", async () => {
    prTask(1);
    const { engine, github, calls, clock } = fakeGithub({
      prs: async () => {
        throw new Error("HTTP 503: No server is currently available");
      },
    });
    await github.poll();
    expect(engine.status.github.state).toBe("error");
    expect(engine.status.github.detail).toMatch(
      /^up to date · 1 PR failed: HTTP 503: No server is currently available · retry \d+:\d\d$/,
    );
    calls.length = 0;
    await github.poll();
    expect(calls).toEqual([]);
    clock.t += 4 * 60_000 + 1;
    await github.poll();
    expect(calls).toContain("graphql");
  });

  test("a rate limit says until when, and pauses that budget's calls", async () => {
    prTask(1);
    let limited = true;
    const { engine, github, calls, clock } = fakeGithub({
      prs: async (refs) => {
        if (limited)
          throw new Error("GraphQL: API rate limit already exceeded for user ID 1.");
        return open(refs);
      },
    });
    await github.poll();
    expect(engine.status.github.state).toBe("error");
    expect(engine.status.github.detail).toMatch(
      /^up to date · PR status rate limited until \d+:\d\d$/,
    );
    expect(calls).toContain("rate_limit");
    // Survives a restart: the reset does not move because Riker did.
    expect(store.kvGet(`github.pause.${GhBudget.graphql}`)).toContain(
      String(reset * 1000),
    );
    calls.length = 0;
    limited = false;
    clock.t += 10 * 60_000;
    await github.poll(true);
    expect(calls).not.toContain("graphql");
    expect(calls).toContain("notifications");
    clock.t = reset * 1000 + 1;
    await github.poll();
    expect(calls).toContain("graphql");
    expect(engine.status.github).toMatchObject({ state: "ok", detail: "up to date" });
  });

  test("a REST rate limit stops the notifications too", async () => {
    const { engine, github, calls } = fakeGithub({
      notifications: () => {
        throw new Error("gh: API rate limit exceeded for user ID 1. (HTTP 403)");
      },
      prs: open,
    });
    await github.poll();
    expect(engine.status.github.state).toBe("error");
    expect(engine.status.github.detail).toMatch(/^rate limited until \d+:\d\d$/);
    calls.length = 0;
    await github.poll(true);
    expect(calls).not.toContain("notifications");
  });

  test("low on GraphQL budget, PR status waits for the reset", async () => {
    prTask(1);
    const { engine, github, calls } = fakeGithub({
      prs: async (refs) => ({
        ...(await open(refs)),
        budget: { remaining: 10, resetAt: new Date(reset * 1000).toISOString() },
      }),
    });
    await github.poll();
    expect(engine.status.github.state).toBe("ok");
    expect(engine.status.github.detail).toMatch(
      /^up to date · PR status paused until \d+:\d\d \(GraphQL budget low\)$/,
    );
    calls.length = 0;
    await github.poll();
    expect(calls).not.toContain("graphql");
  });
});
