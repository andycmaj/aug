import { beforeEach, describe, expect, test } from "bun:test";
import { Drafts, setSender } from "@riker/core/outbound";
import * as store from "@riker/core/store";
import { freshHome } from "@riker/core/test/support/helpers";
import { Kind } from "@riker/core/types";
import { slackReply } from "../src/draft";

beforeEach(() => {
  freshHome();
  // The fixture day replaces every sender; another file's may still be set.
  setSender(null);
});

function slackTask(meta: Record<string, unknown>) {
  const t = store.createTask({ title: "Seat count", kind: Kind.reply, channel: "slack" });
  const m = store.insertMessage({
    channel: "slack",
    externalId: `slack:${JSON.stringify(meta)}`,
    threadKey: "slack:C1:111.1",
    author: "U9",
    authorName: "Ruth",
    title: "#renewals",
    body: "How many seats do we need?",
    receivedAt: new Date().toISOString(),
    meta,
  })!;
  store.fileMessage(m.id, "reply", "question", t.id);
  return t;
}

describe("a Slack draft", () => {
  const drafts = new Drafts([slackReply(async () => "posted")]);

  test("replies in the thread the message came from, to its author", () => {
    const draft = drafts.for(slackTask({ channel: "C1", ts: "111.1" }), { kind: "reply", text: "42 seats." });
    expect(draft).toEqual({ type: "slack_reply", channel: "C1", thread_ts: "111.1", to: "Ruth", text: "42 seats." });
    expect(drafts.describe(draft!)).toBe("Slack reply to Ruth (in thread)");
  });

  test("a DM's top line is answered in the DM, not a thread", () => {
    const draft = drafts.for(slackTask({ channel: "D1", ts: "5.1", dm: true }), { kind: "reply", text: "ok" });
    expect(draft).toMatchObject({ channel: "D1", thread_ts: undefined });
    expect(drafts.describe(draft!)).toBe("Slack reply to Ruth");
  });

  test("sends through what the plugin was given", async () => {
    const draft = drafts.for(slackTask({ channel: "C1", ts: "1.1" }), { kind: "reply", text: "x" })!;
    expect(await drafts.send(draft, {} as never)).toBe("posted");
  });
});
