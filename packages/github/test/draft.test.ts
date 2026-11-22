import { beforeEach, describe, expect, test } from "bun:test";
import { Drafts } from "@riker/core/outbound";
import * as store from "@riker/core/store";
import { freshHome } from "@riker/core/test/support/helpers";
import { Kind } from "@riker/core/types";
import { githubComment } from "../src/draft";

beforeEach(() => freshHome());

function issueTask(type: string) {
  const t = store.createTask({ title: "x", kind: Kind.general, channel: "github" });
  const m = store.insertMessage({
    channel: "github",
    externalId: `gh:${type}`,
    threadKey: "github:a/b#3",
    author: "erin",
    authorName: "erin",
    title: "",
    body: "x",
    receivedAt: new Date().toISOString(),
    meta: { repo: "a/b", number: 3, type },
  })!;
  store.fileMessage(m.id, "general", "", t.id);
  return t;
}

describe("a GitHub draft", () => {
  const drafts = new Drafts([githubComment]);

  test("close-outs only where the system has them", () => {
    const issue = issueTask("Issue");
    expect(drafts.for(issue, { kind: "merge_pr", text: " done " })).toEqual({
      type: "github_comment",
      repo: "a/b",
      number: 3,
      body: "done",
      close: undefined,
    });
    expect(drafts.for(issue, { kind: "close_issue", text: "fixed" })).toMatchObject({ close: "issue" });
  });

  test("is worded and rewritten by its own kind", () => {
    const pr = issueTask("PullRequest");
    const draft = drafts.for(pr, { kind: "merge_pr", text: "ship it" })!;
    expect(drafts.describe(draft)).toBe("GitHub comment + merge on a/b#3");
    expect(drafts.text(draft)).toBe("ship it");
    expect(drafts.text(drafts.withText(draft, "lgtm"))).toBe("lgtm");
  });
});
