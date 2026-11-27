import { beforeEach, describe, expect, test } from "bun:test";
import { Engine } from "@riker/core/engine";
import { linkPr } from "@riker/core/feedback";
import { GhBudget } from "../src/gate";
import { setMux } from "@riker/core/mux";
import type { PrFetch } from "../src/pr-status";
import { githubPlugin } from "../src/index";
import * as store from "@riker/core/store";
import { Kind, PrState } from "@riker/core/types";
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
  pulls?: Record<string, unknown>;
}) {
  const clock = { t: 1_000_000_000, now: () => clock.t, random: () => 1 };
  const calls: string[] = [];
  const api = async (path: string) => {
    calls.push(path.split("?")[0]);
    if (path === "user") {
      return { login: "me" };
    }
    if (options.pulls && path in options.pulls) {
      return options.pulls[path];
    }
    if (path === "rate_limit") {
      return {
        resources: {
          core: { remaining: 4000, reset },
          graphql: { remaining: 0, reset },
        },
      };
    }
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
    for (let n = 1; n <= 3; n++) {
      prTask(n);
    }
    const { engine, github } = fakeGithub({
      prs: async (refs) => ({
        views: new Map(
          refs.map((r) => [
            r.url,
            r.url.endsWith("/1")
              ? { state: "OPEN" }
              : new Error("HTTP 502: Bad Gateway"),
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
        if (limited) {
          throw new Error(
            "GraphQL: API rate limit already exceeded for user ID 1.",
          );
        }
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
    expect(engine.status.github).toMatchObject({
      state: "ok",
      detail: "up to date",
    });
  });

  test("a REST rate limit stops the notifications too", async () => {
    const { engine, github, calls } = fakeGithub({
      notifications: () => {
        throw new Error(
          "gh: API rate limit exceeded for user ID 1. (HTTP 403)",
        );
      },
      prs: open,
    });
    await github.poll();
    expect(engine.status.github.state).toBe("error");
    expect(engine.status.github.detail).toMatch(
      /^rate limited until \d+:\d\d$/,
    );
    calls.length = 0;
    await github.poll(true);
    expect(calls).not.toContain("notifications");
  });

  test("low on GraphQL budget, PR status waits for the reset", async () => {
    prTask(1);
    const { engine, github, calls } = fakeGithub({
      prs: async (refs) => ({
        ...(await open(refs)),
        budget: {
          remaining: 10,
          resetAt: new Date(reset * 1000).toISOString(),
        },
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

// The turn that merged a PR should not wait for the clock, nor for a
// GraphQL rate limit.
describe("a task's PR at its turn's end", () => {
  const merged: PrFetch = async (refs) => ({
    views: new Map(refs.map((r) => [r.url, { state: "MERGED" }])),
    budget: { remaining: 4000, resetAt: new Date(reset * 1000).toISOString() },
  });

  test("is read now, once: a merged PR is not read again", async () => {
    const t = prTask(7);
    const { github, calls } = fakeGithub({ prs: merged });
    await github.refreshTask(store.getTask(t.id)!);
    expect(calls).toEqual(["graphql"]);
    expect(store.prStatus(t.id)?.state).toBe("merged");
    await github.refreshTask(store.getTask(t.id)!);
    expect(calls).toEqual(["graphql"]);
  });

  test("a task with no PR asks nothing", async () => {
    const t = store.createTask({
      title: "no PR",
      kind: Kind.coding,
      channel: "owner",
    });
    const { github, calls } = fakeGithub({ prs: merged });
    await github.refreshTask(t);
    expect(calls).toEqual([]);
  });

  test("rate limited on GraphQL, REST says it merged", async () => {
    const t = prTask(8);
    const { github, calls } = fakeGithub({
      prs: async () => {
        throw new Error("gh: API rate limit already exceeded for user ID 1.");
      },
      pulls: { "repos/acme/ledger/pulls/8": { state: "closed", merged: true } },
    });
    await github.refreshTask(store.getTask(t.id)!);
    expect(calls).toEqual([
      "graphql",
      "rate_limit",
      "repos/acme/ledger/pulls/8",
    ]);
    expect(store.prStatus(t.id)).toMatchObject({
      state: "merged",
      number: 8,
      error: null,
    });
    // Paused now: the next turn goes straight to REST.
    const u = prTask(9);
    calls.length = 0;
    await github.refreshTask(store.getTask(u.id)!);
    expect(calls).toEqual(["repos/acme/ledger/pulls/9"]);
  });

  test("REST saying open keeps the last full read", async () => {
    const t = prTask(10);
    let limited = false;
    const { github, calls } = fakeGithub({
      prs: async (refs) => {
        if (limited) {
          throw new Error("API rate limit exceeded");
        }
        return open(refs);
      },
      pulls: { "repos/acme/ledger/pulls/10": { state: "open", merged: false } },
    });
    await github.poll();
    const before = store.prStatus(t.id);
    expect(before?.state).toBe("open");
    limited = true;
    calls.length = 0;
    await github.refreshTask(store.getTask(t.id)!);
    expect(calls).toEqual([
      "graphql",
      "rate_limit",
      "repos/acme/ledger/pulls/10",
    ]);
    expect(store.prStatus(t.id)).toEqual(before);
  });
});

describe("what one poll costs", () => {
  test("a quiet poll on many PRs: login once a process, notifications once, 25 PRs a query", async () => {
    for (let n = 1; n <= 60; n++) {
      prTask(n);
    }
    const { github, calls } = fakeGithub({ prs: open });
    await github.poll();
    expect(calls.toSorted()).toEqual([
      "graphql",
      "graphql",
      "graphql",
      "notifications",
      "user",
    ]);
    calls.length = 0;
    await github.poll();
    expect(calls.toSorted()).toEqual([
      "graphql",
      "graphql",
      "graphql",
      "notifications",
    ]);
  });

  test("notifications and PR status read side by side, and the poll waits for both", async () => {
    prTask(1);
    const events: string[] = [];
    let releaseNotes!: () => void;
    let releasePrs!: () => void;
    const notesHeld = new Promise<void>((r) => (releaseNotes = r));
    const prsHeld = new Promise<void>((r) => (releasePrs = r));
    const { github } = fakeGithub({
      notifications: async () => {
        events.push("notifications asked");
        await notesHeld;
        events.push("notifications answered");
        return [];
      },
      prs: async (refs) => {
        events.push("graphql asked");
        await prsHeld;
        events.push("graphql answered");
        return open(refs);
      },
    });
    let finished = false;
    const poll = github.poll().then(() => (finished = true));
    await Bun.sleep(5);
    // Both are out at once: in a row, GraphQL would wait for notifications.
    expect(events.toSorted()).toEqual(["graphql asked", "notifications asked"]);
    releaseNotes();
    await Bun.sleep(5);
    expect(finished).toBe(false);
    releasePrs();
    await poll;
    expect(events.slice(2)).toEqual([
      "notifications answered",
      "graphql answered",
    ]);
    expect(store.prStatus(store.listTasks()[0]!.id)?.state).toBe(PrState.open);
  });
});
