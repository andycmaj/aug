import { beforeEach, describe, expect, test } from "bun:test";
import * as store from "../src/core/store";
import { triage } from "../src/core/triage";
import {
  AgentState,
  TaskStatus,
  TurnRole,
  type MessageRow,
} from "../src/core/types";
import { fakeBrain, freshHome } from "./helpers";

function slackDm(
  n: number,
  body: string,
  extra: Partial<store.NewMessage> = {},
): MessageRow {
  return store.insertMessage({
    channel: "slack",
    externalId: `slack:D1:${n}`,
    threadKey: "slack:D1:dm",
    author: "U2",
    authorName: "Sam Delgado",
    title: "DM with Sam Delgado",
    body,
    receivedAt: new Date(Date.UTC(2026, 10, 5, 10, n)).toISOString(),
    meta: { channel: "D1", ts: `${n}.0`, dm: true },
    ...extra,
  })!;
}

function ghComment(n: number, body: string, author = "erin"): MessageRow {
  return store.insertMessage({
    channel: "github",
    externalId: `gh:${n}`,
    threadKey: "github:acme/api#12",
    author,
    authorName: author,
    title: "acme/api#12 issue: export drops transfers (mentioned you)",
    body,
    receivedAt: new Date(Date.UTC(2026, 10, 5, 9, n)).toISOString(),
    meta: { repo: "acme/api", number: 12, type: "Issue", reason: "mention" },
  })!;
}

const verdict = (v: string, extra: Record<string, unknown> = {}) => ({
  verdict: v,
  title: "Same-day pay providers",
  summary: "Sam asks which providers offer same-day pay.",
  priority: "regular",
  reason: "a direct question",
  ...extra,
});

describe("triage", () => {
  beforeEach(() => freshHome());

  test("dedupe: the same message is stored once", () => {
    expect(slackDm(1, "hello there friend")).not.toBeNull();
    const again = store.insertMessage({
      channel: "slack",
      externalId: "slack:D1:1",
      threadKey: "slack:D1:dm",
      author: "U2",
      authorName: "Sam",
      title: "",
      body: "x",
      receivedAt: new Date().toISOString(),
    });
    expect(again).toBeNull();
  });

  test("a greeting never becomes a task and asks no model", async () => {
    const calls = fakeBrain(() => verdict("general"));
    const out = await triage(slackDm(1, "hey!"));
    expect(out.verdict).toBe("opener");
    expect(calls).toHaveLength(0);
    expect(store.listTasks()).toHaveLength(0);
  });

  test("bots are FYI by gate", async () => {
    const calls = fakeBrain(() => verdict("task"));
    const out = await triage(ghComment(1, "Coverage 91%", "codecov[bot]"));
    expect(out.verdict).toBe("fyi");
    expect(calls).toHaveLength(0);
  });

  test("a general verdict makes a task with the message as its first chat line and asks for an agent", async () => {
    fakeBrain(() => verdict("general"));
    const out = await triage(
      slackDm(1, "Which payroll providers do same-day pay?"),
    );
    expect(out.verdict).toBe("general");
    const task = store.getTask(out.taskId!)!;
    expect(task.kind).toBe("general");
    const turns = store.turnsForTask(task.id);
    expect(turns[0].role).toBe(TurnRole.incoming);
    expect(out.effects).toEqual([
      {
        type: "agent-turn",
        taskId: task.id,
        reason: "triage sent it to the agent",
      },
    ]);
  });

  test("coding work is held for the owner's Start", async () => {
    fakeBrain(() => verdict("coding", { repo: "acme/api" }));
    const out = await triage(
      ghComment(1, "@me the export drops inter-company transfers"),
    );
    const task = store.getTask(out.taskId!)!;
    expect(task.agent_state).toBe(AgentState.queued);
    expect(task.repo).toBe("acme/api");
    expect(out.effects).toHaveLength(0);
  });

  test("a GitHub thread attaches to its open task without a model call", async () => {
    const calls = fakeBrain(() => verdict("task"));
    const first = await triage(ghComment(1, "please look"));
    const second = await triage(ghComment(2, "any update?"));
    expect(second.verdict).toBe("attached");
    expect(second.taskId).toBe(first.taskId);
    expect(calls).toHaveLength(1);
  });

  test("they wrote after the close: the task reopens", async () => {
    fakeBrain(() => verdict("task"));
    const first = await triage(ghComment(1, "please look"));
    store.markDone(first.taskId!);
    const again = await triage(ghComment(2, "it is broken again"));
    expect(again.taskId).toBe(first.taskId);
    expect(store.getTask(first.taskId!)!.status).toBe(TaskStatus.open);
  });

  test("a DM asks the model whether it is the same ask", async () => {
    let n = 0;
    fakeBrain(() =>
      n++ === 0 ? verdict("general") : verdict("general", { same_ask: true }),
    );
    const first = await triage(
      slackDm(1, "Which payroll providers do same-day pay?"),
    );
    const second = await triage(slackDm(2, "and what would it cost us?"));
    expect(second.verdict).toBe("attached");
    expect(second.taskId).toBe(first.taskId);
  });

  test("your own answer on the thread retires the pending draft", async () => {
    fakeBrain(() => verdict("reply"));
    const first = await triage(ghComment(1, "can you confirm the seat count?"));
    const turn = store.addTurn({
      taskId: first.taskId!,
      role: TurnRole.agent,
      body: "drafted",
    });
    store.setTurnAction(turn.id, {
      type: "github_comment",
      repo: "acme/api",
      number: 12,
      body: "42 seats",
    });
    const own = store.insertMessage({
      channel: "github",
      externalId: "gh:own",
      threadKey: "github:acme/api#12",
      author: "me",
      authorName: "me",
      title: "",
      body: "It is 42.",
      receivedAt: new Date().toISOString(),
      fromMe: true,
    })!;
    const out = await triage(own);
    expect(out.verdict).toBe("own");
    expect(store.pendingAction(first.taskId!)).toBeNull();
  });

  test("a failed model call files the message, never assumes work", async () => {
    fakeBrain(() => {
      throw new Error("offline");
    });
    const out = await triage(slackDm(1, "Can you send me the Q3 numbers?"));
    expect(out.verdict).toBe("failed");
    expect(store.listTasks()).toHaveLength(0);
    expect(store.fyiMessages("2000-01-01")[0].reason).toContain(
      "awaiting AI triage",
    );
  });
});
