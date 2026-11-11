import { beforeEach, describe, expect, test } from "bun:test";
import { linkByBranch } from "../src/core/triage";
import {
  formatFeedback,
  linkPr,
  markFeedbackRead,
  nudgeText,
  parsePrUrl,
  unreadFeedback,
} from "../src/core/feedback";
import { pollGithub, type GhNotification } from "../src/core/ingest/github";
import { triage } from "../src/core/triage";
import * as store from "../src/core/store";
import { Kind, SessionKind } from "../src/core/types";
import { freshHome } from "./helpers";

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
  test("a PR from the task's branch joins the task, and triage attaches to it", async () => {
    const t = branchTask();
    const m = prMessage(230, "Please add a test", { head: "keep-transfers" });
    expect(linkByBranch(m)).toBe(t.id);
    expect(store.threadsForTask(t.id)).toEqual(["github:acme/ledger#214", "github:acme/ledger#230"]);
    expect(store.openTaskForThread("github:acme/ledger#230")?.id).toBe(t.id);
    const outcome = await triage(m);
    expect(outcome.taskId).toBe(t.id);
    expect(store.listTasks()).toHaveLength(1);
  });

  test("other branches and other channels are not linked", () => {
    branchTask();
    expect(linkByBranch(prMessage(231, "x", { head: "someone-else" }))).toBeNull();
    expect(linkByBranch(prMessage(232, "x"))).toBeNull();
  });

  test("aug-tools pr links by URL", () => {
    const t = branchTask();
    expect(parsePrUrl("https://github.com/acme/ledger/pull/230/files")).toEqual({ repo: "acme/ledger", number: 230 });
    expect(linkPr(t.id, "https://github.com/acme/ledger/issues/9")).toBeNull();
    expect(linkPr(t.id, "https://github.com/acme/ledger/pull/230")).toBe("github:acme/ledger#230");
    expect(store.openTaskForThread("github:acme/ledger#230")?.id).toBe(t.id);
  });

  test("ingest fetches a PR's head only for repos with branch tasks", async () => {
    const n: GhNotification = {
      id: "1",
      reason: "comment",
      updated_at: "2026-11-07T10:00:00Z",
      subject: {
        title: "Keep transfers",
        url: "https://api.github.com/repos/acme/ledger/pulls/230",
        latest_comment_url: null,
        type: "PullRequest",
      },
      repository: { full_name: "acme/ledger", html_url: "https://github.com/acme/ledger" },
    };
    const calls: string[] = [];
    const api = async (path: string) => {
      calls.push(path);
      if (path === "user") return { login: "me" };
      if (path.startsWith("notifications")) return [n];
      return { user: { login: "erin" }, body: "LGTM?", head: { ref: "keep-transfers" } };
    };
    const without = await pollGithub(null, api);
    expect(without[0].meta?.head).toBeUndefined();
    const withHead = await pollGithub(null, api, (repo) => repo === "acme/ledger");
    expect(withHead[0].meta?.head).toBe("keep-transfers");
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
    expect(nudgeText(t.id)).toContain("2 new comments on AUG-0001");
    expect(nudgeText(t.id)).toContain("feedback");
    expect(formatFeedback(first)).toContain("erin on acme/ledger#230");
    markFeedbackRead(t.id, first);
    expect(unreadFeedback(t.id)).toEqual([]);
    expect(formatFeedback([])).toBe("No new feedback.");
    prMessage(230, "one more");
    expect(unreadFeedback(t.id).map((m) => m.body)).toEqual(["one more"]);
  });
});
