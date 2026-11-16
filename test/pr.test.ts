import { beforeEach, describe, expect, test } from "bun:test";
import { linkPr } from "../src/core/feedback";
import { GithubGate, type GhRemaining } from "../src/core/github-gate";
import {
  PR_BATCH,
  prBatchQuery,
  prChip,
  prLine,
  readPrBatch,
  readPrView,
  refreshPrStatus,
  refreshPrStatuses,
  taskPr,
  type GhPrView,
  type PrFetch,
} from "../src/core/pr";
import * as store from "../src/core/store";
import { Kind, type PrStatusRow } from "../src/core/types";
import { freshHome } from "./helpers";

beforeEach(() => freshHome());

function issueTask(threadKey = "github:acme/ledger#214") {
  return store.createTask({
    title: "Export drops transfers",
    kind: Kind.coding,
    channel: "github",
    repo: "acme/ledger",
    threadKey,
    url: "https://github.com/acme/ledger/issues/214",
  });
}

function message(threadKey: string, type: string) {
  return store.insertMessage({
    channel: "github",
    externalId: `gh:${threadKey}`,
    threadKey,
    author: "erin",
    authorName: "erin",
    title: "t",
    body: "b",
    receivedAt: new Date().toISOString(),
    meta: { repo: "acme/ledger", type, reason: "review_requested" },
  });
}

describe("finding a task's PR", () => {
  test("an issue task has none until its agent links one", () => {
    const t = issueTask();
    message("github:acme/ledger#214", "Issue");
    expect(taskPr(t)).toBeNull();
    linkPr(t.id, "https://github.com/acme/ledger/pull/230");
    expect(taskPr(store.getTask(t.id)!)).toEqual({
      repo: "acme/ledger",
      number: 230,
      url: "https://github.com/acme/ledger/pull/230",
    });
  });

  test("a task filed from a PR (a review request) is about that PR", () => {
    const t = store.createTask({
      title: "Review dark mode",
      kind: Kind.task,
      channel: "github",
      threadKey: "github:northwind/web#88",
    });
    message("github:northwind/web#88", "PullRequest");
    expect(taskPr(t)?.url).toBe("https://github.com/northwind/web/pull/88");
  });

  test("a PR link attached by hand counts, comments and anchors stripped", () => {
    const t = store.createTask({
      title: "x",
      kind: Kind.task,
      channel: "owner",
    });
    store.addTaskLink(t.id, "https://notion.so/spec", "spec", "you");
    expect(taskPr(t)).toBeNull();
    store.addTaskLink(
      t.id,
      "https://github.com/a/b/pull/7#discussion_r1",
      null,
      "you",
    );
    expect(taskPr(t)?.url).toBe("https://github.com/a/b/pull/7");
  });
});

const view = (v: GhPrView) => readPrView(v);

describe("reading gh pr view", () => {
  test("states, reviews and mergeability", () => {
    expect(view({ state: "OPEN", isDraft: true })).toMatchObject({
      state: "draft",
    });
    expect(view({ state: "MERGED", isDraft: false })).toMatchObject({
      state: "merged",
    });
    expect(
      view({ state: "OPEN", reviewDecision: "CHANGES_REQUESTED" }),
    ).toMatchObject({
      review: "changes",
    });
    expect(view({ state: "OPEN", mergeable: "CONFLICTING" })).toMatchObject({
      mergeable: "conflict",
    });
    expect(view({ state: "OPEN", reviewDecision: "" })).toMatchObject({
      review: "none",
    });
  });

  test("checks roll up: any failure fails, anything unfinished pends", () => {
    const run = (status: string, conclusion: string | null) => ({
      __typename: "CheckRun",
      status,
      conclusion,
    });
    expect(view({ statusCheckRollup: [] }).checks).toBe("none");
    expect(
      view({
        statusCheckRollup: [
          run("COMPLETED", "SUCCESS"),
          run("COMPLETED", "SKIPPED"),
        ],
      }).checks,
    ).toBe("pass");
    expect(
      view({
        statusCheckRollup: [
          run("COMPLETED", "SUCCESS"),
          run("IN_PROGRESS", null),
        ],
      }).checks,
    ).toBe("pending");
    expect(
      view({
        statusCheckRollup: [
          run("IN_PROGRESS", null),
          run("COMPLETED", "FAILURE"),
        ],
      }).checks,
    ).toBe("fail");
    expect(
      view({
        statusCheckRollup: [{ __typename: "StatusContext", state: "PENDING" }],
      }).checks,
    ).toBe("pending");
    expect(
      view({
        statusCheckRollup: [{ __typename: "StatusContext", state: "ERROR" }],
      }).checks,
    ).toBe("fail");
  });
});

// A PrFetch from a function per PR, the way a test thinks about it.
function byUrl(
  view: (url: string) => Promise<GhPrView>,
  budget: GhRemaining | null = null,
  calls: string[][] = [],
): PrFetch {
  return async (prs) => {
    calls.push(prs.map((p) => p.url));
    const views = new Map<string, GhPrView | Error>();
    for (const pr of prs) {
      try {
        views.set(pr.url, await view(pr.url));
      } catch (err) {
        views.set(pr.url, err as Error);
      }
    }
    return { views, budget };
  };
}

function prTask(n: number) {
  const t = issueTask(`github:acme/ledger#${1000 + n}`);
  linkPr(t.id, `https://github.com/acme/ledger/pull/${n}`);
  return t;
}

describe("refreshing", () => {
  test("stores what gh said, and only tasks with a PR ask", async () => {
    const t = issueTask();
    issueTask("github:acme/ledger#300");
    linkPr(t.id, "https://github.com/acme/ledger/pull/230");
    const asked: string[] = [];
    const r = await refreshPrStatuses({
      fetch: byUrl(async (url) => {
        asked.push(url);
        return {
          state: "OPEN",
          reviewDecision: "APPROVED",
          statusCheckRollup: [],
        };
      }),
    });
    expect(r).toMatchObject({ asked: 1, ok: 1, failed: 0 });
    expect(asked).toEqual(["https://github.com/acme/ledger/pull/230"]);
    expect(store.prStatus(t.id)).toMatchObject({
      number: 230,
      state: "open",
      review: "approved",
      checks: "none",
      error: null,
    });
  });

  test("a merged PR is not asked again; a failing one keeps being asked", async () => {
    const t = issueTask();
    linkPr(t.id, "https://github.com/acme/ledger/pull/230");
    await refreshPrStatus(
      store.getTask(t.id)!,
      byUrl(async () => ({ state: "MERGED" })),
    );
    let asked = 0;
    await refreshPrStatuses({
      fetch: byUrl(async () => {
        asked++;
        return { state: "MERGED" };
      }),
    });
    expect(asked).toBe(0);
  });

  test("an unchanged read does not wake the TUI", async () => {
    const t = issueTask();
    linkPr(t.id, "https://github.com/acme/ledger/pull/230");
    const same = byUrl(async () => ({ state: "OPEN" }));
    await refreshPrStatus(store.getTask(t.id)!, same);
    let woke = 0;
    const off = store.onChange(() => woke++);
    await refreshPrStatus(store.getTask(t.id)!, same);
    expect(woke).toBe(0);
    await refreshPrStatus(
      store.getTask(t.id)!,
      byUrl(async () => ({ state: "CLOSED" })),
    );
    expect(woke).toBe(1);
    off();
  });

  test("a gh failure on one PR does not stop the rest", async () => {
    const a = prTask(1);
    const b = prTask(2);
    const r = await refreshPrStatuses({
      fetch: byUrl(async (url) => {
        if (url.endsWith("/1")) throw new Error("no auth");
        return { state: "OPEN" };
      }),
    });
    expect(r).toMatchObject({ ok: 1, failed: 1, error: "no auth" });
    expect(store.prStatus(b.id)?.number).toBe(2);
    expect(store.prStatus(a.id)).toBeNull();
  });

  test("all of them in one call, not one call each", async () => {
    for (let n = 1; n <= 30; n++) prTask(n);
    const calls: string[][] = [];
    const r = await refreshPrStatuses({
      fetch: byUrl(async () => ({ state: "OPEN" }), null, calls),
    });
    expect(r.ok).toBe(30);
    expect(calls.map((c) => c.length)).toEqual([PR_BATCH, 30 - PR_BATCH]);
  });

  test("a failed read says so, and marks the old read stale", async () => {
    const t = prTask(7);
    await refreshPrStatuses({
      fetch: byUrl(async () => ({ state: "OPEN", reviewDecision: "APPROVED" })),
    });
    expect(prChip(store.prStatus(t.id)!).text).toBe("#7 ✓ ready");
    const r = await refreshPrStatuses({
      fetch: async () => {
        throw new Error("HTTP 502: Bad Gateway (https://api.github.com/graphql)");
      },
    });
    expect(r).toMatchObject({ asked: 1, ok: 0, failed: 1, limited: null });
    expect(r.error).toContain("502");
    const row = store.prStatus(t.id)!;
    expect(row.review).toBe("approved");
    expect(row.error).toContain("502");
    expect(prChip(row)).toEqual({ text: "#7 ✓ ready · stale", tone: "muted" });
    expect(prLine(row)).toContain("stale, last read failed: HTTP 502");
    await refreshPrStatuses({ fetch: byUrl(async () => ({ state: "OPEN" })) });
    expect(store.prStatus(t.id)!.error).toBeNull();
  });

  test("a rate limit stops the round: no more calls after it", async () => {
    for (let n = 1; n <= 30; n++) prTask(n);
    let calls = 0;
    const r = await refreshPrStatuses({
      fetch: async () => {
        calls++;
        throw new Error("GraphQL: API rate limit already exceeded for user ID 1.");
      },
    });
    expect(calls).toBe(1);
    expect(r.limited).toContain("rate limit");
    expect(r).toMatchObject({ asked: 0, failed: 0, skipped: 30 });
  });

  test("under the reserve, the round leaves the rest for later", async () => {
    for (let n = 1; n <= 30; n++) prTask(n);
    const calls: string[][] = [];
    const budget = { remaining: 40, resetAt: "2026-11-16T18:00:00Z" };
    const r = await refreshPrStatuses({
      fetch: byUrl(async () => ({ state: "OPEN" }), budget, calls),
      reserve: 100,
    });
    expect(calls).toHaveLength(1);
    expect(r).toMatchObject({ ok: PR_BATCH, skipped: 30 - PR_BATCH, budget });
  });

  test("a PR that keeps failing backs off on its own", async () => {
    prTask(1);
    prTask(2);
    let t = 0;
    const gate = new GithubGate(() => 60_000, {
      now: () => t,
      random: () => 1,
    });
    const asked: string[] = [];
    const fetch = byUrl(async (url) => {
      asked.push(url);
      if (url.endsWith("/1")) throw new Error("Could not resolve to a PullRequest");
      return { state: "OPEN" };
    });
    await refreshPrStatuses({ fetch, gate });
    asked.length = 0;
    const r = await refreshPrStatuses({ fetch, gate });
    expect(asked).toEqual(["https://github.com/acme/ledger/pull/2"]);
    expect(r.skipped).toBe(1);
    t += 2 * 60_000 + 1;
    asked.length = 0;
    await refreshPrStatuses({ fetch, gate });
    expect(asked).toHaveLength(2);
  });
});

describe("one GraphQL query for a batch", () => {
  const refs = [
    { repo: "acme/ledger", number: 1, url: "https://github.com/acme/ledger/pull/1" },
    { repo: "acme/web", number: 9, url: "https://github.com/acme/web/pull/9" },
  ];

  test("an alias per PR, and the budget asked for free", () => {
    const q = prBatchQuery(refs);
    expect(q).toContain('p0: repository(owner: "acme", name: "ledger") { pullRequest(number: 1)');
    expect(q).toContain('p1: repository(owner: "acme", name: "web") { pullRequest(number: 9)');
    expect(q).toContain("rateLimit { remaining resetAt }");
  });

  test("reads each PR, and names the one GitHub could not find", () => {
    const batch = readPrBatch(refs, {
      data: {
        rateLimit: { remaining: 4800, resetAt: "2026-11-16T18:00:00Z" },
        p0: {
          pullRequest: {
            state: "OPEN",
            reviewDecision: "APPROVED",
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      contexts: {
                        nodes: [
                          { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          },
        },
        p1: { pullRequest: null },
      },
      errors: [{ message: "Could not resolve to a PullRequest", path: ["p1", "pullRequest"] }],
    });
    expect(batch.budget?.remaining).toBe(4800);
    expect(readPrView(batch.views.get(refs[0].url) as GhPrView)).toMatchObject({
      review: "approved",
      checks: "fail",
    });
    expect((batch.views.get(refs[1].url) as Error).message).toBe(
      "Could not resolve to a PullRequest",
    );
  });

  test("an answer with no data is the whole call failing", () => {
    expect(() =>
      readPrBatch(refs, {
        data: null,
        errors: [{ message: "API rate limit already exceeded for user ID 1." }],
      }),
    ).toThrow("rate limit");
  });
});

describe("words for it", () => {
  const row = (patch: Partial<PrStatusRow>): PrStatusRow => ({
    task_id: 1,
    repo: "acme/ledger",
    number: 219,
    url: "u",
    state: "open",
    checks: "pass",
    review: "none",
    mergeable: "clean",
    fetched_at: "",
    error: null,
    ...patch,
  });

  test("the rail chip names what is in the way first", () => {
    expect(prChip(row({ checks: "fail", review: "changes" }))).toEqual({
      text: "#219 ✗ ci",
      tone: "error",
    });
    expect(prChip(row({ mergeable: "conflict", checks: "fail" })).text).toBe(
      "#219 ✗ conflict",
    );
    expect(prChip(row({ checks: "pending", review: "approved" })).tone).toBe(
      "warning",
    );
    expect(prChip(row({ review: "approved" }))).toEqual({
      text: "#219 ✓ ready",
      tone: "success",
    });
    expect(prChip(row({ state: "merged", checks: "fail" })).text).toBe(
      "#219 merged",
    );
  });

  test("the header line says all of it while open", () => {
    expect(
      prLine(row({ checks: "fail", review: "changes", mergeable: "conflict" })),
    ).toBe(
      "PR acme/ledger#219 · open · checks failing · changes requested · conflicts",
    );
    expect(prLine(row({ state: "merged" }))).toBe(
      "PR acme/ledger#219 · merged",
    );
  });
});
