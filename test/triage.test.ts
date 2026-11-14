import { beforeEach, describe, expect, test } from "bun:test";
import { taskClosed } from "../src/core/lifecycle";
import * as store from "../src/core/store";
import { triage } from "../src/core/triage";
import { DocName, writeDoc } from "../src/core/docs";
import {
  AgentState,
  SessionKind,
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
    taskClosed(first.taskId!);
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

// Today's routing, pinned before triage became a chain of rules: which rule
// claims each kind of inbound item, and what it routes to.
describe("triage routing", () => {
  beforeEach(() => freshHome());

  function ghNotice(
    n: number,
    opts: {
      reason?: string;
      type?: string;
      author?: string;
      thread?: string;
      body?: string;
    } = {},
  ): MessageRow {
    return store.insertMessage({
      channel: "github",
      externalId: `gh:n${n}`,
      threadKey: opts.thread ?? "github:acme/api#40",
      author: opts.author ?? "erin",
      authorName: opts.author ?? "erin",
      title: "acme/api#40 PullRequest: speed up export",
      body: opts.body ?? "Please take a look at this change.",
      url: "https://github.com/acme/api/pull/40",
      receivedAt: new Date(Date.UTC(2026, 10, 5, 11, n)).toISOString(),
      meta: {
        repo: "acme/api",
        number: 40,
        type: opts.type ?? "PullRequest",
        reason: opts.reason ?? "review_requested",
      },
    })!;
  }

  function slackThread(n: number, body: string): MessageRow {
    return store.insertMessage({
      channel: "slack",
      externalId: `slack:C9:${n}`,
      threadKey: "slack:C9:100.0",
      author: "U3",
      authorName: "Priya",
      title: "#payments thread",
      body,
      receivedAt: new Date(Date.UTC(2026, 10, 5, 12, n)).toISOString(),
      meta: { channel: "C9", ts: `${100 + n}.0`, thread_ts: "100.0" },
    })!;
  }

  const message = (id: number) => store.getMessage(id)!;

  test("your own message comes first, even when it looks like a greeting", async () => {
    const calls = fakeBrain(() => verdict("general"));
    const own = slackDm(1, "hey!", { fromMe: true });
    const out = await triage(own);
    expect(out).toMatchObject({ verdict: "own", taskId: null, effects: [] });
    expect(message(own.id).read_at).not.toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("a greeting wins over the bot gate", async () => {
    const calls = fakeBrain(() => verdict("task"));
    const m = ghNotice(1, { author: "renovate[bot]", body: "hi" });
    const out = await triage(m);
    expect(out.verdict).toBe("opener");
    expect(message(m.id).read_at).not.toBeNull();
    expect(calls).toHaveLength(0);
  });

  test.each([
    ["dependabot", "review_requested", "a bot wrote it"],
    ["github-actions", "mention", "a bot wrote it"],
    ["erin", "ci_activity", "CI activity"],
    ["erin", "state_change", "a state change on a thread you only follow"],
    ["erin", "subscribed", "a state change on a thread you only follow"],
  ])("noise by gate: %s / %s", async (author, reason, why) => {
    const calls = fakeBrain(() => verdict("task"));
    const m = ghNotice(1, { author, reason });
    const out = await triage(m);
    expect(out).toEqual({
      verdict: "fyi",
      taskId: null,
      reason: why,
      effects: [],
    });
    expect(message(m.id).verdict).toBe("fyi");
    expect(calls).toHaveLength(0);
  });

  test("a GitHub review request goes to the model with JOB.md in hand, and its priority sticks", async () => {
    writeDoc(
      DocName.job,
      "# JOB\n\nHigh priority:\n- GitHub review requests, to me directly or to a GitHub team I'm on.\n",
    );
    const calls = fakeBrain(() =>
      verdict("task", { title: "Review acme/api#40", priority: "urgent" }),
    );
    const out = await triage(ghNotice(1, { reason: "review_requested" }));
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toContain("GitHub review requests");
    expect(calls[0].prompt).toContain('"reason":"review_requested"');
    const task = store.getTask(out.taskId!)!;
    expect(task.priority).toBe("urgent");
    expect(task.kind).toBe("task");
    // Repo falls back to the notification's own.
    expect(task.repo).toBe("acme/api");
    expect(task.url).toBe("https://github.com/acme/api/pull/40");
    expect(out.effects).toEqual([]);
  });

  test("a Slack mention in a channel thread is judged once, then the thread attaches", async () => {
    writeDoc(DocName.job, "# JOB\n\nHigh priority:\n- Slack mentions of me.\n");
    const calls = fakeBrain(() =>
      verdict("reply", { priority: "urgent", title: "Answer Priya" }),
    );
    const first = await triage(slackThread(1, "<@UME> can you confirm the cutoff?"));
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toContain("Slack mentions of me");
    // Not a DM: no same-ask candidate is offered.
    expect(calls[0].prompt).not.toContain("Candidate open task");
    expect(store.getTask(first.taskId!)!.priority).toBe("urgent");
    expect(first.effects).toEqual([
      {
        type: "agent-turn",
        taskId: first.taskId,
        reason: "triage sent it to the agent",
      },
    ]);

    const second = await triage(slackThread(2, "also the timezone"));
    expect(calls).toHaveLength(1);
    expect(second).toEqual({
      verdict: "attached",
      taskId: first.taskId,
      reason: `joined ${store.taskRef(first.taskId!)}`,
      effects: [
        {
          type: "agent-turn",
          taskId: first.taskId,
          reason: "Priya wrote again",
        },
      ],
    });
  });

  test("a message joining a live task's thread is delivered to its agent", async () => {
    fakeBrain(() => verdict("task"));
    const first = await triage(ghComment(1, "please look"));
    store.updateTask(first.taskId!, { agent_state: AgentState.working });
    const second = await triage(ghComment(2, "any update?"));
    expect(second.effects).toEqual([
      { type: "agent-message", taskId: first.taskId, messageId: expect.any(Number) },
    ]);
  });

  test("autostart off: nothing is woken", async () => {
    freshHome({ autostart: false });
    fakeBrain(() => verdict("general"));
    const first = await triage(slackThread(1, "what is the cutoff?"));
    expect(first.effects).toEqual([]);
    const second = await triage(slackThread(2, "and the timezone?"));
    expect(second.verdict).toBe("attached");
    expect(second.effects).toEqual([]);
  });

  test("an FYI verdict is filed with no task", async () => {
    fakeBrain(() => verdict("fyi", { reason: "release notes" }));
    const m = slackThread(1, "v2.3 is out");
    const out = await triage(m);
    expect(out).toEqual({
      verdict: "fyi",
      taskId: null,
      reason: "release notes",
      effects: [],
    });
    expect(message(m.id).verdict).toBe("fyi");
    expect(store.listTasks()).toHaveLength(0);
  });

  test("a watch verdict makes a task that watches", async () => {
    fakeBrain(() => verdict("watch"));
    const out = await triage(ghComment(1, "deploying the fix now"));
    const task = store.getTask(out.taskId!)!;
    expect(out.verdict).toBe("watch");
    expect(task.kind).toBe("task");
    expect(task.watching).toBe(1);
  });

  test("a DM that is a new ask makes a second task", async () => {
    let n = 0;
    const calls = fakeBrain(() =>
      n++ === 0 ? verdict("general") : verdict("general", { same_ask: false }),
    );
    const first = await triage(slackDm(1, "Which payroll providers do same-day pay?"));
    const second = await triage(slackDm(2, "Separately, who owns the SOC2 doc?"));
    expect(calls[1].prompt).toContain("Candidate open task");
    expect(second.verdict).toBe("general");
    expect(second.taskId).not.toBe(first.taskId);
  });

  test("a DM after the close is judged again, not reopened", async () => {
    const calls = fakeBrain(() => verdict("general"));
    const first = await triage(slackDm(1, "Which payroll providers do same-day pay?"));
    taskClosed(first.taskId!);
    const again = await triage(slackDm(2, "Who owns the SOC2 doc?"));
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).not.toContain("Candidate open task");
    expect(again.taskId).not.toBe(first.taskId);
    expect(store.getTask(first.taskId!)!.status).toBe(TaskStatus.done);
  });

  test("your own answer wakes the agent of a task that has a session", async () => {
    fakeBrain(() => verdict("general"));
    const first = await triage(slackThread(1, "what is the cutoff?"));
    store.createSession({
      id: "s1",
      taskId: first.taskId!,
      kind: SessionKind.chat,
      cwd: "/tmp",
      startedBy: "aug",
    });
    const own = store.insertMessage({
      channel: "slack",
      externalId: "slack:C9:own",
      threadKey: "slack:C9:100.0",
      author: "UME",
      authorName: "me",
      title: "",
      body: "5pm PT",
      receivedAt: new Date().toISOString(),
      fromMe: true,
    })!;
    const out = await triage(own);
    expect(out).toEqual({
      verdict: "own",
      taskId: first.taskId,
      reason: "you answered",
      effects: [
        {
          type: "agent-turn",
          taskId: first.taskId,
          reason: "you answered the thread yourself",
        },
      ],
    });
    const turns = store.turnsForTask(first.taskId!);
    expect(turns.at(-1)!.body).toContain("You answered on Slack yourself");
  });
});
