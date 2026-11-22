import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { triagePlugin } from "../src/index";
import { Engine } from "@riker/core/engine";
import { setMux } from "@riker/core/mux";
import { EMPTY_CURSOR, type SlackTransport } from "@riker/core/slack/shared";
import * as store from "@riker/core/store";
import {
  BATCH_WINDOW_MS,
  retryDelayMs,
  TRIAGE_MAX_ATTEMPTS,
  triageNext,
} from "../src/worker";
import { MessageState, type MessageRow } from "@riker/core/types";
import { FakeMux } from "@riker/core/test/support/fake-mux";
import { config, fakeBrain, freshHome, testConfig } from "@riker/core/test/support/helpers";

const T0 = Date.UTC(2026, 10, 5, 10, 0);

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

function insert(n: number, body: string, opts: { thread?: string; at?: number } = {}): MessageRow {
  return store.insertMessage(slackMessage(n, body, opts))!;
}

const verdict = (v: string) => ({
  verdict: v,
  title: "Payroll export is short",
  summary: "Sam asks why the March payroll export is short.",
  priority: "regular",
  reason: "a direct question",
});

let engine: Engine;
beforeEach(() => {
  freshHome();
  setMux(new FakeMux());
  engine = new Engine({ config: testConfig(), plugins: [triagePlugin()], offline: true });
});
afterEach(() => engine.stop());

describe("the inbox survives a crash", () => {
  test("a message inserted but never triaged, or left mid-triage, is triaged at start", async () => {
    const calls = fakeBrain(() => verdict("fyi"));
    // Riker died after the insert, before triage.
    const never = insert(1, "Is the vendor call still on?", { thread: "slack:C1:1.0" });
    // Riker died mid-triage: claimed, never settled.
    const midway = insert(2, "Why is the March export short?", { thread: "slack:C1:2.0" });
    expect(store.claimMessage(midway.id)).toBe(true);
    expect(store.getMessage(midway.id)!.state).toBe(MessageState.triaging);
    expect(store.triageRunsFor(never.id)).toHaveLength(0);

    const ran = await engine.resumeTriage();
    expect(ran).toBe(2);
    expect(calls).toHaveLength(2);
    for (const m of [never, midway]) {
      expect(store.getMessage(m.id)!.state).toBe(MessageState.done);
      expect(store.triageRunsFor(m.id)).toHaveLength(1);
    }
  });
});

describe("a failed model call", () => {
  test("is retried with backoff, then left for the owner", async () => {
    fakeBrain(() => null);
    const m = insert(1, "Why is the March export short?");
    let at = T0;
    for (let attempt = 1; attempt <= TRIAGE_MAX_ATTEMPTS; attempt++) {
      const done = await triageNext({ config: config() }, new Date(at));
      expect(done?.outcome.verdict).toBe("failed");
      const row = store.getMessage(m.id)!;
      expect(row.state).toBe(MessageState.failed);
      expect(row.attempts).toBe(attempt);
      if (attempt < TRIAGE_MAX_ATTEMPTS) {
        expect(row.next_at).toBe(new Date(at + retryDelayMs(attempt)).toISOString());
        // Not before it is due.
        expect(await triageNext({ config: config() }, new Date(at + 1000))).toBeNull();
        at += retryDelayMs(attempt);
      } else expect(row.next_at).toBeNull();
    }
    expect(store.triageRunsFor(m.id)).toHaveLength(TRIAGE_MAX_ATTEMPTS);
    // Given up: a day later and with the model back, the worker leaves it.
    fakeBrain(() => verdict("fyi"));
    expect(await triageNext({ config: config() }, new Date(at + 86_400_000))).toBeNull();
    expect(store.unplacedMessages()).toBe(1);
  });

  test("a retry that works settles it", async () => {
    fakeBrain(() => null);
    const m = insert(1, "Why is the March export short?");
    await triageNext({ config: config() }, new Date(T0));
    fakeBrain(() => verdict("fyi"));
    const done = await triageNext({ config: config() }, new Date(T0 + retryDelayMs(1)));
    expect(done?.outcome.verdict).toBe("fyi");
    expect(store.getMessage(m.id)).toMatchObject({ state: MessageState.done, next_at: null });
  });

  test("one the owner read is not retried", async () => {
    fakeBrain(() => null);
    const m = insert(1, "Why is the March export short?");
    await triageNext({ config: config() }, new Date(T0));
    store.markMessageRead(m.id);
    expect(await triageNext({ config: config() }, new Date(T0 + 86_400_000))).toBeNull();
  });
});

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
    engine = new Engine({ config: testConfig(), plugins: [triagePlugin()], offline: true, slack: transport([slackMessage(1, "hi there, a question")]) });
    const insertSpy = spyOn(store, "insertMessage").mockImplementation(() => {
      throw new Error("database is locked");
    });
    try {
      await engine.pollSlack();
    } finally {
      insertSpy.mockRestore();
    }
    expect(engine.status.slack.state).toBe("error");
    expect(store.kvGet("slack.cursor.token")).toBeNull();
    await engine.pollSlack();
    expect(JSON.parse(store.kvGet("slack.cursor.token")!).since).toBe("200.0");
  });

  test("only inserts: triage is the worker's", async () => {
    const calls = fakeBrain(() => verdict("fyi"));
    engine = new Engine({ config: testConfig(), plugins: [triagePlugin()], offline: true, slack: transport([slackMessage(1, "Why is the export short?")]) });
    await engine.pollSlack();
    const [m] = store.recentMessages(10);
    expect(m!.state).toBe(MessageState.new);
    expect(calls).toHaveLength(0);
  });
});

describe("a burst on one thread", () => {
  test("two messages within the window are one triage run", async () => {
    const calls = fakeBrain(() => verdict("general"));
    const first = insert(1, "Why is the March export short?");
    const second = insert(2, "It is missing the contractors too.");
    const elsewhere = insert(3, "Unrelated", { thread: "slack:C1:300.0" });
    const done = await triageNext({ config: config() }, new Date(T0 + 60_000));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain("Why is the March export short?");
    expect(calls[0]!.prompt).toContain("It is missing the contractors too.");
    expect(done!.messages).toEqual([first.id, second.id]);
    const taskId = done!.outcome.taskId!;
    expect(taskId).not.toBeNull();
    const [leadRun] = store.triageRunsFor(second.id);
    expect(JSON.parse(leadRun!.input).batch).toEqual([first.id]);
    expect(leadRun!.rule).toBe("new task");
    const [followRun] = store.triageRunsFor(first.id);
    expect(followRun!.rule).toBe("batch");
    for (const m of [first, second])
      expect(store.getMessage(m.id)).toMatchObject({ state: MessageState.done, task_id: taskId });
    expect(store.getMessage(elsewhere.id)!.state).toBe(MessageState.new);
  });

  test("messages further apart than the window are triaged apart", async () => {
    const calls = fakeBrain(() => verdict("fyi"));
    insert(1, "Why is the March export short?", { at: T0 });
    insert(2, "Never mind, found it.", { at: T0 + BATCH_WINDOW_MS + 1000 });
    await triageNext({ config: config() }, new Date(T0 + 3 * BATCH_WINDOW_MS));
    expect(calls).toHaveLength(1);
    await triageNext({ config: config() }, new Date(T0 + 3 * BATCH_WINDOW_MS));
    expect(calls).toHaveLength(2);
  });
});
