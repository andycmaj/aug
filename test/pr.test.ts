import { beforeEach, describe, expect, test } from "bun:test";
import { linkPr } from "../src/core/feedback";
import {
  prChip,
  prLine,
  readPrView,
  refreshPrStatus,
  refreshPrStatuses,
  taskPr,
  type GhPrView,
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

describe("refreshing", () => {
  test("stores what gh said, and only tasks with a PR ask", async () => {
    const t = issueTask();
    issueTask("github:acme/ledger#300");
    linkPr(t.id, "https://github.com/acme/ledger/pull/230");
    const asked: string[] = [];
    const n = await refreshPrStatuses(async (url) => {
      asked.push(url);
      return {
        state: "OPEN",
        reviewDecision: "APPROVED",
        statusCheckRollup: [],
      };
    });
    expect(n).toBe(1);
    expect(asked).toEqual(["https://github.com/acme/ledger/pull/230"]);
    expect(store.prStatus(t.id)).toMatchObject({
      number: 230,
      state: "open",
      review: "approved",
      checks: "none",
    });
  });

  test("a merged PR is not asked again; a failing one keeps being asked", async () => {
    const t = issueTask();
    linkPr(t.id, "https://github.com/acme/ledger/pull/230");
    await refreshPrStatus(store.getTask(t.id)!, async () => ({
      state: "MERGED",
    }));
    let asked = 0;
    await refreshPrStatuses(async () => {
      asked++;
      return { state: "MERGED" };
    });
    expect(asked).toBe(0);
  });

  test("an unchanged read does not wake the TUI", async () => {
    const t = issueTask();
    linkPr(t.id, "https://github.com/acme/ledger/pull/230");
    const same = async () => ({ state: "OPEN" });
    await refreshPrStatus(store.getTask(t.id)!, same);
    let woke = 0;
    const off = store.onChange(() => woke++);
    await refreshPrStatus(store.getTask(t.id)!, same);
    expect(woke).toBe(0);
    await refreshPrStatus(store.getTask(t.id)!, async () => ({
      state: "CLOSED",
    }));
    expect(woke).toBe(1);
    off();
  });

  test("a gh failure on one PR does not stop the rest", async () => {
    const a = issueTask();
    const b = issueTask("github:acme/ledger#215");
    linkPr(a.id, "https://github.com/acme/ledger/pull/1");
    linkPr(b.id, "https://github.com/acme/ledger/pull/2");
    const n = await refreshPrStatuses(async (url) => {
      if (url.endsWith("/1")) throw new Error("no auth");
      return { state: "OPEN" };
    });
    expect(n).toBe(1);
    expect(store.prStatus(b.id)?.number).toBe(2);
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
