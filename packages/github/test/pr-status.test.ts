import { beforeEach, describe, expect, test } from "bun:test";
import { linkPr } from "@riker/core/feedback";
import { prChip, prLine, prQueueWord } from "@riker/core/pr";
import * as store from "@riker/core/store";
import type { Tone } from "@riker/core/lanes";
import { Kind, type PrStatusRow } from "@riker/core/types";
import { freshHome } from "@riker/core/test/support/helpers";
import { GithubGate, type GhRemaining } from "../src/gate";
import {
  PR_BATCH,
  prBatchQuery,
  readPrBatch,
  readPrView,
  refreshPrStatus,
  refreshPrStatuses,
  type GhPrView,
  type PrFetch,
} from "../src/pr-status";

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

  test("keeps the branch a PR merges into, and a failed read keeps the last one", async () => {
    const t = issueTask();
    linkPr(t.id, "https://github.com/acme/ledger/pull/230");
    await refreshPrStatuses({
      fetch: byUrl(async () => ({ state: "OPEN", baseRefName: "stack-2-parser", statusCheckRollup: [] })),
    });
    expect(store.prStatus(t.id)?.base).toBe("stack-2-parser");
    await refreshPrStatuses({
      fetch: byUrl(async () => {
        throw new Error("HTTP 502");
      }),
    });
    expect(store.prStatus(t.id)).toMatchObject({ base: "stack-2-parser", error: "HTTP 502" });
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
    expect(prChip(store.prStatus(t.id)!).text).toBe("#7 ✓ approved");
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
    expect(prChip(row)).toEqual({ text: "#7 ✓ approved · stale", tone: "muted" });
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
    expect(q).toContain("baseRefName");
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

describe("the merge status ladder, from GitHub's answer", () => {
  const ref = {
    repo: "acme/ledger",
    number: 219,
    url: "https://github.com/acme/ledger/pull/219",
  };
  const check = (conclusion: string | null, status = "COMPLETED") => ({
    __typename: "CheckRun",
    status,
    conclusion,
  });
  const node = (
    patch: Record<string, unknown>,
    checks = [check("SUCCESS")],
    committedDate = "2026-11-18T10:00:00Z",
  ) => ({
    state: "OPEN",
    isDraft: false,
    reviewDecision: "REVIEW_REQUIRED",
    mergeable: "MERGEABLE",
    isInMergeQueue: false,
    mergeQueueEntry: null,
    timelineItems: { nodes: [] },
    commits: {
      nodes: [
        {
          commit: {
            committedDate,
            statusCheckRollup: { contexts: { nodes: checks } },
          },
        },
      ],
    },
    ...patch,
  });
  const removed = (createdAt: string, reason: string | null) => ({
    timelineItems: {
      nodes: [{ __typename: "RemovedFromMergeQueueEvent", createdAt, reason }],
    },
  });
  const read = (pr: Record<string, unknown>): PrStatusRow => {
    const batch = readPrBatch([ref], { data: { p0: { pullRequest: pr } } });
    return {
      task_id: 1,
      ...ref,
      ...readPrView(batch.views.get(ref.url) as GhPrView),
      fetched_at: "",
      error: null,
    };
  };

  const ladder: [
    string,
    Record<string, unknown>,
    string,
    Tone,
    ReturnType<typeof check>[]?,
  ][] = [
    ["draft", { isDraft: true, reviewDecision: null }, "#219 draft", "muted"],
    ["in review", {}, "#219 ● in review", "warning"],
    [
      "changes requested",
      { reviewDecision: "CHANGES_REQUESTED" },
      "#219 ✗ changes",
      "error",
    ],
    ["approved", { reviewDecision: "APPROVED" }, "#219 ✓ approved", "success"],
    [
      "checks failing",
      { reviewDecision: "APPROVED" },
      "#219 ✗ ci",
      "error",
      [check("FAILURE")],
    ],
    [
      "checks pending",
      { reviewDecision: "APPROVED" },
      "#219 ● ci",
      "warning",
      [check(null, "IN_PROGRESS")],
    ],
    [
      "in the merge queue, with its place",
      {
        reviewDecision: "APPROVED",
        isInMergeQueue: true,
        mergeQueueEntry: { position: 3, state: "AWAITING_CHECKS" },
      },
      "#219 ↠ MQ 3",
      "info",
    ],
    [
      "in the merge queue, no place given",
      { reviewDecision: "APPROVED", isInMergeQueue: true },
      "#219 ↠ MQ",
      "info",
    ],
    [
      "in the merge queue but unmergeable",
      {
        reviewDecision: "APPROVED",
        isInMergeQueue: true,
        mergeQueueEntry: { position: 1, state: "UNMERGEABLE" },
      },
      "#219 ✗ MQ",
      "error",
    ],
    [
      "put out of the queue since its last commit",
      {
        reviewDecision: "APPROVED",
        ...removed("2026-11-18T11:00:00Z", "Failed status checks"),
      },
      "#219 ✗ out of MQ",
      "error",
    ],
    [
      "put out of the queue, then pushed to",
      {
        reviewDecision: "APPROVED",
        ...removed("2026-11-18T09:00:00Z", "Merge conflict"),
      },
      "#219 ✓ approved",
      "success",
    ],
    [
      "merged",
      { state: "MERGED", reviewDecision: "APPROVED", ...removed("2026-11-18T11:00:00Z", null) },
      "#219 merged",
      "accent",
    ],
    [
      "closed without merging",
      { state: "CLOSED", ...removed("2026-11-18T11:00:00Z", null) },
      "#219 ✗ closed",
      "muted",
    ],
  ];

  for (const [name, patch, text, tone, checks] of ladder)
    test(name, () => {
      expect(prChip(read(node(patch, checks)))).toEqual({ text, tone });
    });

  test("the queue's fields are asked for in the same query", () => {
    const q = prBatchQuery([ref]);
    expect(q).toContain("isInMergeQueue mergeQueueEntry { position state }");
    expect(q).toContain("REMOVED_FROM_MERGE_QUEUE_EVENT");
    expect(q).toContain("committedDate");
    expect(q.match(/query \{/g)).toHaveLength(1);
  });

  test("the queue is a phase of review: the lane and header say it", () => {
    const queued = read(
      node({ isInMergeQueue: true, mergeQueueEntry: { position: 2, state: "QUEUED" } }),
    );
    expect(queued).toMatchObject({ queue: "queued", queue_position: 2 });
    expect(prQueueWord(queued)).toBe("in merge queue");
    expect(prLine(queued)).toBe(
      "PR acme/ledger#219 · open · in merge queue, position 2 · checks pass · review required",
    );
    const out = read(node(removed("2026-11-18T11:00:00Z", "Merge conflict")));
    expect(out).toMatchObject({ queue: "removed", queue_reason: "Merge conflict" });
    expect(prQueueWord(out)).toBe("out of merge queue");
    expect(prLine(out)).toContain("removed from merge queue: merge conflict");
    const merged = read(node({ state: "MERGED", isInMergeQueue: false }));
    expect(merged.queue).toBe("none");
    expect(prQueueWord(merged)).toBeNull();
    expect(prQueueWord(read(node({})))).toBeNull();
  });

  test("a queued PR is stored, and leaving the queue is a change", async () => {
    const t = prTask(219);
    const fetch = (pr: Record<string, unknown>): PrFetch =>
      byUrl(async () => {
        const batch = readPrBatch([ref], { data: { p0: { pullRequest: pr } } });
        return batch.views.get(ref.url) as GhPrView;
      });
    await refreshPrStatuses({
      fetch: fetch(node({ isInMergeQueue: true, mergeQueueEntry: { position: 1, state: "MERGEABLE" } })),
    });
    expect(store.prStatus(t.id)).toMatchObject({ queue: "queued", queue_position: 1 });
    let woke = 0;
    const off = store.onChange(() => woke++);
    await refreshPrStatuses({
      fetch: fetch(node(removed("2026-11-18T11:00:00Z", "Failed status checks"))),
    });
    off();
    expect(woke).toBe(1);
    expect(store.prStatus(t.id)).toMatchObject({
      queue: "removed",
      queue_position: null,
      queue_reason: "Failed status checks",
    });
  });
});
