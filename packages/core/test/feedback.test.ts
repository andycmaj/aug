import { beforeEach, describe, expect, test } from "bun:test";
import {
  formatFeedback,
  linkPr,
  markFeedbackRead,
  nudgeText,
  parsePrUrl,
  unreadFeedback,
} from "../src/feedback";
import * as store from "../src/store";
import { Kind, SessionKind } from "../src/types";
import { freshHome } from "./support/helpers";

beforeEach(() => freshHome());

let seq = 0;
function prMessage(number: number, body: string, opts: { head?: string; fromMe?: boolean; at?: string } = {}) {
  seq++;
  return store.insertMessage({
    channel: "github",
    externalId: `gh:${seq}`,
    threadKey: `github:acme/ledger#${number}`,
    author: opts.fromMe ? "me" : "erin",
    authorName: opts.fromMe ? "me" : "erin",
    title: `acme/ledger#${number} PR: Keep transfers (commented)`,
    body,
    url: `https://github.com/acme/ledger/pull/${number}#c${seq}`,
    receivedAt: opts.at ?? new Date(Date.now() + seq * 1000).toISOString(),
    fromMe: opts.fromMe,
    meta: { repo: "acme/ledger", number, type: "PullRequest", reason: "comment", ...(opts.head ? { head: opts.head } : {}) },
  })!;
}

function branchTask() {
  const t = store.createTask({
    title: "Export drops transfers",
    kind: Kind.coding,
    channel: "github",
    repo: "acme/ledger",
    threadKey: "github:acme/ledger#214",
    branch: "keep-transfers",
  });
  store.createSession({ id: `s${t.id}`, taskId: t.id, kind: SessionKind.tmux, cwd: "/w", startedBy: "owner" });
  return t;
}

describe("linking a PR to its task", () => {
  test("riker-tools pr links by URL", () => {
    const t = branchTask();
    expect(parsePrUrl("https://github.com/acme/ledger/pull/230/files")).toEqual({ repo: "acme/ledger", number: 230 });
    expect(linkPr(t.id, "https://github.com/acme/ledger/issues/9")).toBeNull();
    expect(linkPr(t.id, "https://github.com/acme/ledger/pull/230")).toBe("github:acme/ledger#230");
    expect(store.openTaskForThread("github:acme/ledger#230")?.id).toBe(t.id);
  });

});

describe("feedback", () => {
  test("new comments on linked threads, once each, never your own", () => {
    const t = branchTask();
    linkPr(t.id, "https://github.com/acme/ledger/pull/230");
    prMessage(230, "Please add a test");
    prMessage(230, "done, thanks", { fromMe: true });
    prMessage(214, "old ask on the issue", { at: "2020-01-01T00:00:00Z" });
    prMessage(214, "also check the CSV path");
    const first = unreadFeedback(t.id);
    expect(first.map((m) => m.body)).toEqual(["Please add a test", "also check the CSV path"]);
    expect(nudgeText(t.id)).toContain("2 new comments on RIKER-0001");
    expect(nudgeText(t.id)).toContain("feedback");
    expect(formatFeedback(first)).toContain("erin on acme/ledger#230");
    markFeedbackRead(t.id, first);
    expect(unreadFeedback(t.id)).toEqual([]);
    expect(formatFeedback([])).toBe("No new feedback.");
    prMessage(230, "one more");
    expect(unreadFeedback(t.id).map((m) => m.body)).toEqual(["one more"]);
  });
});
