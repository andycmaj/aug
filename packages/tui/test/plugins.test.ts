import { beforeEach, expect, test } from "bun:test";
import { handleDone } from "@riker/core/hooks";
import { Drafts } from "@riker/core/outbound";
import * as store from "@riker/core/store";
import { freshHome } from "@riker/core/test/support/helpers";
import { Kind } from "@riker/core/types";
import { rikerPlugins } from "../src/plugins";

beforeEach(() => freshHome());

// riker-tools builds a hook's `done --reply` draft through this same list.
test("a real Riker's plugins draft a coding agent's reply on its thread", () => {
  const t = store.createTask({
    title: "BOM",
    kind: Kind.coding,
    channel: "github",
  });
  const m = store.insertMessage({
    channel: "github",
    externalId: "gh:1",
    threadKey: "github:a/b#201",
    author: "marcus",
    authorName: "marcus",
    title: "",
    body: "CSV import fails on a BOM",
    receivedAt: new Date().toISOString(),
    meta: { repo: "a/b", number: 201, type: "Issue" },
  })!;
  store.fileMessage(m.id, "coding", "", t.id);
  handleDone(
    { taskId: t.id, sessionId: "s1" },
    { summary: "fixed", reply: "Fixed in #219.", close: "issue" },
    Drafts.of(rikerPlugins()),
  );
  const drafts = Drafts.of(rikerPlugins());
  const pending = store.pendingAction(t.id)!;
  expect(drafts.describe(pending.action)).toBe(
    "GitHub comment + close issue on a/b#201",
  );
  expect(drafts.text(pending.action)).toBe("Fixed in #219.");
});
