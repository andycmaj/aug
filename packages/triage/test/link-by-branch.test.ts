import { beforeEach, describe, expect, test } from "bun:test";
import * as store from "@riker/core/store";
import { Kind, SessionKind } from "@riker/core/types";
import { config, freshHome } from "@riker/core/test/support/helpers";
import { linkByBranch, triage } from "../src/triage";

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

describe("linking a PR to its task by branch", () => {
  test("a PR from the task's branch joins the task, and triage attaches to it", async () => {
    const t = branchTask();
    const m = prMessage(230, "Please add a test", { head: "keep-transfers" });
    expect(linkByBranch(m)).toBe(t.id);
    expect(store.threadsForTask(t.id)).toEqual(["github:acme/ledger#214", "github:acme/ledger#230"]);
    expect(store.openTaskForThread("github:acme/ledger#230")?.id).toBe(t.id);
    const outcome = await triage(m, { config: config() });
    expect(outcome.taskId).toBe(t.id);
    expect(store.listTasks()).toHaveLength(1);
  });

  test("other branches and other channels are not linked", () => {
    branchTask();
    expect(linkByBranch(prMessage(231, "x", { head: "someone-else" }))).toBeNull();
    expect(linkByBranch(prMessage(232, "x"))).toBeNull();
  });

});
