import { beforeEach, describe, expect, test } from "bun:test";
import { linkPr } from "../src/feedback";
import { prChip, prLine, REVIEW_LINK_BY, REVIEW_LINK_TITLE, taskPr, unmergedPr } from "../src/pr";
import * as store from "../src/store";
import { Kind, type PrStatusRow } from "../src/types";
import { freshHome } from "./support/helpers";

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
    queue: "none",
    queue_position: null,
    queue_reason: null,
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
      text: "#219 ✓ approved",
      tone: "success",
    });
    expect(prChip(row({ state: "merged", checks: "fail" }))).toEqual({
      text: "#219 merged",
      tone: "accent",
    });
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

// One GitHub answer per rung of the ladder, read the way the poller reads
// it: the batch query's node, then the row, then the rail's chip.

describe("whether done is early", () => {
  const PR = "https://github.com/acme/ledger/pull/230";
  function withPr(state: PrStatusRow["state"], patch: Partial<PrStatusRow> = {}) {
    const t = issueTask();
    linkPr(t.id, PR);
    store.setPrStatus({
      task_id: t.id,
      repo: "acme/ledger",
      number: 230,
      url: PR,
      state,
      checks: "pass",
      review: "approved",
      mergeable: "clean",
      queue: "none",
      queue_position: null,
      queue_reason: null,
      fetched_at: "",
      error: null,
      ...patch,
    });
    return store.getTask(t.id)!;
  }

  test("an open or draft PR is not merged", () => {
    expect(unmergedPr(withPr("open"))).toBe("PR #230 is open, not merged");
    expect(unmergedPr(withPr("draft"))).toBe("PR #230 is a draft, not merged");
  });

  test("a stale read says so", () => {
    expect(unmergedPr(withPr("open", { error: "rate limited" }))).toBe(
      "PR #230 is open, not merged (as of its last read)",
    );
  });

  test("merged, closed, or a local merge: nothing to ask", () => {
    expect(unmergedPr(withPr("merged"))).toBeNull();
    expect(unmergedPr(withPr("closed"))).toBeNull();
    const local = withPr("open");
    store.updateTask(local.id, { merged_at: new Date().toISOString() });
    expect(unmergedPr(store.getTask(local.id)!)).toBeNull();
  });

  test("no PR, or one not read yet: nothing to ask", () => {
    expect(unmergedPr(issueTask())).toBeNull();
    const t = issueTask();
    linkPr(t.id, PR);
    expect(unmergedPr(store.getTask(t.id)!)).toBeNull();
  });

  test("a PR the owner was asked to review is done when the review is", () => {
    const t = withPr("open");
    store.addTaskLink(t.id, PR, REVIEW_LINK_TITLE, REVIEW_LINK_BY);
    expect(unmergedPr(store.getTask(t.id)!)).toBeNull();
  });
});
