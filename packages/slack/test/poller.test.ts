import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Engine } from "@riker/core/engine";
import { setMux } from "@riker/core/mux";
import * as store from "@riker/core/store";
import { MessageState } from "@riker/core/types";
import { FakeMux } from "@riker/core/test/support/fake-mux";
import { fakeBrain, freshHome, testConfig } from "@riker/core/test/support/helpers";
import { slackPlugin } from "../src/index";
import { EMPTY_CURSOR, type SlackTransport } from "../src/shared";

let engine: Engine | null = null;

beforeEach(() => {
  freshHome();
  setMux(new FakeMux());
});

afterEach(() => {
  engine?.stop();
  engine = null;
});

const T0 = Date.UTC(2026, 10, 5, 10, 0);
const verdict = (v: string) => ({ verdict: v, title: "t", summary: "s", priority: "regular", reason: "r" });

function slackMessage(n: number, body: string, opts: { thread?: string; at?: number } = {}): store.NewMessage {
  return {
    channel: "slack",
    externalId: `slack:C1:${n}`,
    threadKey: opts.thread ?? "slack:C1:100.0",
    author: "U2",
    authorName: "Sam Delgado",
    title: "#payroll",
    body,
    receivedAt: new Date(opts.at ?? T0 + n * 1000).toISOString(),
    meta: { channel: "C1", ts: `${n}.0`, thread_ts: "100.0", mention: true },
  };
}

describe("the Slack poll", () => {
  function transport(messages: store.NewMessage[]): SlackTransport {
    return {
      kind: "token",
      available: () => ({ ok: true, detail: "" }),
      poll: async () => ({ messages, cursor: { ...EMPTY_CURSOR, since: "200.0" } }),
      send: async () => "sent",
      stop: () => {},
    };
  }

  test("does not move its cursor when the insert throws", async () => {
    const slack = slackPlugin({ transport: transport([slackMessage(1, "hi there, a question")]) });
    engine = new Engine({ config: testConfig(), plugins: [slack], offline: true });
    const insertSpy = spyOn(store, "insertMessage").mockImplementation(() => {
      throw new Error("database is locked");
    });
    try {
      await slack.poller.poll();
    } finally {
      insertSpy.mockRestore();
    }
    expect(engine.status.slack.state).toBe("error");
    expect(store.kvGet("slack.cursor.token")).toBeNull();
    await slack.poller.poll();
    expect(JSON.parse(store.kvGet("slack.cursor.token")!).since).toBe("200.0");
  });

  test("only inserts: triage is the worker's, and the model is never asked", async () => {
    const calls = fakeBrain(() => verdict("fyi"));
    const slack = slackPlugin({ transport: transport([slackMessage(1, "Why is the export short?")]) });
    engine = new Engine({ config: testConfig(), plugins: [slack], offline: true });
    await slack.poller.poll();
    const [m] = store.recentMessages(10);
    expect(m!.state).toBe(MessageState.new);
    expect(calls).toHaveLength(0);
  });
});
