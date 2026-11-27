import { beforeEach, describe, expect, test } from "bun:test";
import { reviewedPr } from "@riker/core/pr";
import { taskClosed } from "@riker/core/lifecycle";
import * as store from "@riker/core/store";
import { DEFAULT_CONFIG } from "@riker/core/config";
import { err, ok } from "@riker/core/result";
import { PASS, TRIAGE_RULES, triage, type TriageRule } from "../src/triage";
import { DocName, writeDoc } from "@riker/core/docs";
import {
  AgentState,
  SessionKind,
  TaskStatus,
  TurnRole,
  type MessageRow,
} from "@riker/core/types";
import { setBrain } from "@riker/core/brain";
import {
  fakeBrain,
  freshHome,
  config,
  testConfig,
} from "@riker/core/test/support/helpers";

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
    const out = await triage(slackDm(1, "hey!"), { config: config() });
    expect(out.verdict).toBe("opener");
    expect(calls).toHaveLength(0);
    expect(store.listTasks()).toHaveLength(0);
  });

  test("bots are FYI by gate", async () => {
    const calls = fakeBrain(() => verdict("task"));
    const out = await triage(ghComment(1, "Coverage 91%", "codecov[bot]"), {
      config: config(),
    });
    expect(out.verdict).toBe("fyi");
    expect(calls).toHaveLength(0);
  });

  test("a general verdict makes a task with the message as its first chat line and asks for an agent", async () => {
    fakeBrain(() => verdict("general"));
    const out = await triage(
      slackDm(1, "Which payroll providers do same-day pay?"),
      { config: config() },
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
      { config: config() },
    );
    const task = store.getTask(out.taskId!)!;
    expect(task.agent_state).toBe(AgentState.queued);
    expect(task.repo).toBe("acme/api");
    expect(out.effects).toHaveLength(0);
  });

  test("a GitHub thread attaches to its open task without a model call", async () => {
    const calls = fakeBrain(() => verdict("task"));
    const first = await triage(ghComment(1, "please look"), {
      config: config(),
    });
    const second = await triage(ghComment(2, "any update?"), {
      config: config(),
    });
    expect(second.verdict).toBe("attached");
    expect(second.taskId).toBe(first.taskId);
    expect(calls).toHaveLength(1);
  });

  test("they wrote after the close: the task reopens", async () => {
    fakeBrain(() => verdict("task"));
    const first = await triage(ghComment(1, "please look"), {
      config: config(),
    });
    taskClosed(first.taskId!);
    const again = await triage(ghComment(2, "it is broken again"), {
      config: config(),
    });
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
      { config: config() },
    );
    const second = await triage(slackDm(2, "and what would it cost us?"), {
      config: config(),
    });
    expect(second.verdict).toBe("attached");
    expect(second.taskId).toBe(first.taskId);
  });

  test("your own answer on the thread retires the pending draft", async () => {
    fakeBrain(() => verdict("reply"));
    const first = await triage(
      ghComment(1, "can you confirm the seat count?"),
      { config: config() },
    );
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
    const out = await triage(own, { config: config() });
    expect(out.verdict).toBe("own");
    expect(store.pendingAction(first.taskId!)).toBeNull();
  });

  test("a failed model call files the message, never assumes work", async () => {
    fakeBrain(() => {
      throw new Error("offline");
    });
    const out = await triage(slackDm(1, "Can you send me the Q3 numbers?"), {
      config: config(),
    });
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
      requested?: { me: boolean; teams: string[] };
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
        ...(opts.requested ? { requested: opts.requested } : {}),
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
      // How a channel thread reaches triage: it mentions you.
      meta: {
        channel: "C9",
        ts: `${100 + n}.0`,
        thread_ts: "100.0",
        mention: true,
      },
    })!;
  }

  const message = (id: number) => store.getMessage(id)!;

  test("your own message comes first, even when it looks like a greeting", async () => {
    const calls = fakeBrain(() => verdict("general"));
    const own = slackDm(1, "hey!", { fromMe: true });
    const out = await triage(own, { config: config() });
    expect(out).toMatchObject({ verdict: "own", taskId: null, effects: [] });
    expect(message(own.id).read_at).not.toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("a greeting wins over the bot gate", async () => {
    const calls = fakeBrain(() => verdict("task"));
    const m = ghNotice(1, { author: "renovate[bot]", body: "hi" });
    const out = await triage(m, { config: config() });
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
    const out = await triage(m, { config: config() });
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
    const out = await triage(ghNotice(1, { reason: "review_requested" }), {
      config: config(),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toContain("GitHub review requests");
    expect(calls[0].prompt).toContain('"reason":"review_requested"');
    const task = store.getTask(out.taskId!)!;
    expect(task.priority).toBe("urgent");
    // Who was asked is not known, so the model judged it; a review it
    // calls work is still coding, on the PR's repo and branch.
    expect(out.verdict).toBe("coding");
    expect(task.kind).toBe("coding");
    expect(task.repo).toBe("acme/api");
    expect(task.branch).toBe("pr:40");
    expect(task.url).toBe("https://github.com/acme/api/pull/40");
    expect(task.summary).toContain(
      "guided Plannotator review of https://github.com/acme/api/pull/40",
    );
    expect(task.summary).toContain("linked ticket");
    expect(task.agent_state).toBe(AgentState.queued);
    expect(out.effects).toEqual([]);
    // The guided review is offered on arrival, never run: no action turn.
    const turns = store.turnsForTask(task.id);
    expect(turns.some((t) => t.role === "action")).toBe(false);
    const offer = turns.find(
      (t) => t.role === "trigger" && t.body?.includes("guided review is ready"),
    );
    expect(offer?.body).toContain(
      "makes the worktree on pr:40 (no agent starts)",
    );
    expect(offer?.body).toContain("Post to GitHub there sends your review");
    // Marked as someone else's PR to review: the guide opens it in PR mode.
    expect(reviewedPr(task)?.url).toBe("https://github.com/acme/api/pull/40");
  });
  test("a Slack mention in a channel thread is judged once, then the thread attaches", async () => {
    writeDoc(DocName.job, "# JOB\n\nHigh priority:\n- Slack mentions of me.\n");
    const calls = fakeBrain(() =>
      verdict("reply", { priority: "urgent", title: "Answer Priya" }),
    );
    const first = await triage(
      slackThread(1, "<@UME> can you confirm the cutoff?"),
      { config: config() },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].system).toContain("Slack mentions of me");
    // Not a DM: no same-ask candidate is offered.
    expect(calls[0].prompt).not.toContain("Candidate open task");
    expect(store.getTask(first.taskId!)!.priority).toBe("urgent");
    expect(first.effects).toEqual([
      {
        type: "agent-turn",
        taskId: first.taskId!,
        reason: "triage sent it to the agent",
      },
    ]);

    const second = await triage(slackThread(2, "also the timezone"), {
      config: config(),
    });
    expect(calls).toHaveLength(1);
    expect(second).toEqual({
      verdict: "attached",
      taskId: first.taskId!,
      reason: `joined ${store.taskRef(first.taskId!)}`,
      effects: [
        {
          type: "agent-turn",
          taskId: first.taskId!,
          reason: "Priya wrote again",
        },
      ],
    });
  });

  test("a message joining a live task's thread is delivered to its agent", async () => {
    fakeBrain(() => verdict("task"));
    const first = await triage(ghComment(1, "please look"), {
      config: config(),
    });
    store.updateTask(first.taskId!, { agent_state: AgentState.working });
    const second = await triage(ghComment(2, "any update?"), {
      config: config(),
    });
    expect(second.effects).toEqual([
      {
        type: "agent-message",
        taskId: first.taskId!,
        messageId: expect.any(Number),
      },
    ]);
  });

  test("autostart off: nothing is woken", async () => {
    freshHome({ autostart: false });
    fakeBrain(() => verdict("general"));
    const first = await triage(slackThread(1, "what is the cutoff?"), {
      config: config(),
    });
    expect(first.effects).toEqual([]);
    const second = await triage(slackThread(2, "and the timezone?"), {
      config: config(),
    });
    expect(second.verdict).toBe("attached");
    expect(second.effects).toEqual([]);
  });

  test("an FYI verdict is filed with no task", async () => {
    fakeBrain(() => verdict("fyi", { reason: "release notes" }));
    const m = slackThread(1, "v2.3 is out");
    const out = await triage(m, { config: config() });
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
    const out = await triage(ghComment(1, "deploying the fix now"), {
      config: config(),
    });
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
    const first = await triage(
      slackDm(1, "Which payroll providers do same-day pay?"),
      { config: config() },
    );
    const second = await triage(
      slackDm(2, "Separately, who owns the SOC2 doc?"),
      { config: config() },
    );
    expect(calls[1].prompt).toContain("Candidate open task");
    expect(second.verdict).toBe("general");
    expect(second.taskId).not.toBe(first.taskId);
  });

  test("a DM after the close is judged again, not reopened", async () => {
    const calls = fakeBrain(() => verdict("general"));
    const first = await triage(
      slackDm(1, "Which payroll providers do same-day pay?"),
      { config: config() },
    );
    taskClosed(first.taskId!);
    const again = await triage(slackDm(2, "Who owns the SOC2 doc?"), {
      config: config(),
    });
    expect(calls).toHaveLength(2);
    expect(calls[1].prompt).not.toContain("Candidate open task");
    expect(again.taskId).not.toBe(first.taskId);
    expect(store.getTask(first.taskId!)!.status).toBe(TaskStatus.done);
  });

  test("your own answer wakes the agent of a task that has a session", async () => {
    fakeBrain(() => verdict("general"));
    const first = await triage(slackThread(1, "what is the cutoff?"), {
      config: config(),
    });
    store.createSession({
      id: "s1",
      taskId: first.taskId!,
      kind: SessionKind.chat,
      cwd: "/tmp",
      startedBy: "riker",
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
    const out = await triage(own, { config: config() });
    expect(out).toEqual({
      verdict: "own",
      taskId: first.taskId!,
      reason: "you answered",
      effects: [
        {
          type: "agent-turn",
          taskId: first.taskId!,
          reason: "the owner commented on the thread",
        },
      ],
    });
    const turns = store.turnsForTask(first.taskId!);
    expect(turns.at(-1)!.body).toBe(
      'A comment by the owner on the Slack thread: "5pm PT". Re-think any suggested response.',
    );
  });
});

describe("triage chain", () => {
  beforeEach(() => freshHome());

  test("the routing order, in one place", () => {
    expect(TRIAGE_RULES.map((r) => r.name)).toEqual([
      "timer",
      "own message",
      "greeting",
      "noise",
      "same thread",
      "after close",
      "review ask",
      "others' review",
      "unjudged",
      "same ask",
      "judged fyi",
      "escalation",
      "new task",
    ]);
  });

  test("a new rule is one entry, and the first rule to claim wins", async () => {
    const calls = fakeBrain(() => verdict("general"));
    const vip: TriageRule = {
      name: "vip",
      handle: ({ message }) =>
        message.author === "U2"
          ? ok({ verdict: "fyi", taskId: null, reason: "vip", effects: [] })
          : err(PASS),
    };
    const rules = [...TRIAGE_RULES.slice(0, 3), vip, ...TRIAGE_RULES.slice(3)];
    const out = await triage(slackDm(1, "Can you send me the Q3 numbers?"), {
      config: DEFAULT_CONFIG,
      rules,
    });
    expect(out.reason).toBe("vip");
    expect(calls).toHaveLength(0);
  });

  test("config comes in as a value, not from the global", async () => {
    fakeBrain(() => verdict("general"));
    const out = await triage(slackDm(1, "Which payroll providers?"), {
      config: { ...DEFAULT_CONFIG, autostart: false },
    });
    expect(out.verdict).toBe("general");
    expect(out.effects).toEqual([]);
  });

  test("the model is asked once however many rules read the verdict", async () => {
    let n = 0;
    const calls = fakeBrain(() =>
      n++ === 0 ? verdict("general") : verdict("fyi", { same_ask: false }),
    );
    await triage(slackDm(1, "Which payroll providers do same-day pay?"), {
      config: config(),
    });
    const out = await triage(slackDm(2, "fyi the vendor emailed"), {
      config: config(),
    });
    expect(out.verdict).toBe("fyi");
    expect(calls).toHaveLength(2);
  });

  test("a chain where nobody claims is a bug, not a silent drop", async () => {
    await expect(
      triage(slackDm(1, "anything"), { config: DEFAULT_CONFIG, rules: [] }),
    ).rejects.toThrow("no triage rule claimed");
  });
});

describe("triage noise from config", () => {
  function slackPost(n: number, title: string, body: string): MessageRow {
    return store.insertMessage({
      channel: "slack",
      externalId: `slack:C7:${n}`,
      threadKey: `slack:C7:${n}.0`,
      author: "U9",
      authorName: "Digest Bot",
      title,
      body,
      receivedAt: new Date(Date.UTC(2026, 10, 5, 13, n)).toISOString(),
      meta: { channel: "C7", ts: `${n}.0` },
    })!;
  }

  test("a rule in config files its matches as FYI with no model call", async () => {
    freshHome({
      triage: {
        ...DEFAULT_CONFIG.triage,
        noise: [
          ...DEFAULT_CONFIG.triage.noise,
          { reason: "the weekly digest", channel: "slack", title: "^weekly" },
        ],
      },
    });
    const calls = fakeBrain(() => verdict("task"));
    const out = await triage(slackPost(1, "Weekly digest", "12 new posts"), {
      config: config(),
    });
    expect(out).toEqual({
      verdict: "fyi",
      taskId: null,
      reason: "the weekly digest",
      effects: [],
    });
    expect(calls).toHaveLength(0);
  });

  test("every field a rule sets must match", async () => {
    freshHome({
      triage: {
        ...DEFAULT_CONFIG.triage,
        noise: [{ reason: "digest", channel: "github", title: "^weekly" }],
      },
    });
    const calls = fakeBrain(() => verdict("fyi"));
    await triage(slackPost(1, "Weekly digest", "12 new posts"), {
      config: config(),
    });
    expect(calls).toHaveLength(1);
  });

  test("a rule whose pattern does not compile never matches", async () => {
    freshHome({
      triage: {
        ...DEFAULT_CONFIG.triage,
        noise: [{ reason: "broken", body: "([unclosed" }],
      },
    });
    const calls = fakeBrain(() => verdict("fyi"));
    const out = await triage(slackPost(1, "anything", "([unclosed"), {
      config: config(),
    });
    expect(out.reason).not.toBe("broken");
    expect(calls).toHaveLength(1);
  });
});

describe("review requests become coding tasks", () => {
  beforeEach(() => freshHome());

  function reviewAsk(
    requested: { me: boolean; teams: string[] } | null,
    n = 1,
  ): MessageRow {
    return store.insertMessage({
      channel: "github",
      externalId: `gh:r${n}`,
      threadKey: "github:acme/api#40",
      author: "erin",
      authorName: "erin",
      title: "acme/api#40 PR: speed up export (review requested)",
      body: "Please take a look at this change.",
      url: "https://github.com/acme/api/pull/40",
      receivedAt: new Date(Date.UTC(2026, 10, 5, 11, n)).toISOString(),
      meta: {
        repo: "acme/api",
        number: 40,
        type: "PullRequest",
        reason: "review_requested",
        ...(requested ? { requested } : {}),
      },
    })!;
  }

  const lastRun = (messageId: number) => store.triageRunsFor(messageId)[0]!;
  const lastRule = (messageId: number) => lastRun(messageId).rule;

  test("asked of you: always a coding task on pr:N, even when the model says fyi", async () => {
    const calls = fakeBrain(() =>
      verdict("fyi", {
        title: "Review the export speedup",
        priority: "urgent",
      }),
    );
    const m = reviewAsk({ me: true, teams: [] });
    const out = await triage(m, { config: config() });
    expect(calls).toHaveLength(1);
    expect(out).toMatchObject({
      verdict: "coding",
      reason: "a review requested from you",
      effects: [],
    });
    expect(lastRule(m.id)).toBe("review ask");
    const task = store.getTask(out.taskId!)!;
    expect(task).toMatchObject({
      kind: "coding",
      title: "Review the export speedup",
      priority: "urgent",
      repo: "acme/api",
      branch: "pr:40",
      url: "https://github.com/acme/api/pull/40",
      agent_state: AgentState.queued,
    });
    expect(task.summary.split("\n")[0]).toBe(
      "Do a guided Plannotator review of https://github.com/acme/api/pull/40 (/plannotator-review https://github.com/acme/api/pull/40). The worktree is on the PR's branch (pr:40).",
    );
    expect(store.getMessage(m.id)!.verdict).toBe("coding");
  });

  test("the model failing never loses a review asked of you", async () => {
    setBrain(async () => {
      throw new Error("brain down");
    });
    const out = await triage(reviewAsk({ me: true, teams: [] }), {
      config: config(),
    });
    const task = store.getTask(out.taskId!)!;
    expect(task.kind).toBe("coding");
    expect(task.title).toBe("Review acme/api#40");
    expect(task.priority).toBe("important");
  });

  test.each([["acme/payments"], ["payments"], ["ACME/Payments"]])(
    "asked of a watched team (%s)",
    async (watched) => {
      testConfig().update((c) => ({
        ...c,
        triage: { ...c.triage, reviewTeams: [watched] },
      }));
      fakeBrain(() => verdict("fyi"));
      const out = await triage(
        reviewAsk({ me: false, teams: ["acme/payments"] }),
        {
          config: config(),
        },
      );
      expect(out.verdict).toBe("coding");
      expect(out.reason).toBe(
        "a review requested from acme/payments, a team you watch",
      );
    },
  );

  test("asked of a team you do not watch: filed for you to read, no model asked", async () => {
    testConfig().update((c) => ({
      ...c,
      triage: { ...c.triage, reviewTeams: ["acme/payments"] },
    }));
    const calls = fakeBrain(() => verdict("coding"));
    const m = reviewAsk({ me: false, teams: ["acme/everyone"] });
    const out = await triage(m, { config: config() });
    expect(out).toMatchObject({
      verdict: "fyi",
      taskId: null,
      reason: "review requested of acme/everyone, not a team you watch",
    });
    expect(calls).toHaveLength(0);
    expect(lastRule(m.id)).toBe("others' review");
    const steps = store.triageSteps(lastRun(m.id).id);
    expect(steps.find((s) => s.rule === "review ask")?.reason).toBe(
      "asked of acme/everyone, not a team you watch",
    );
  });

  test("who was asked not known: the model still judges it", async () => {
    const calls = fakeBrain(() => verdict("fyi"));
    const m = reviewAsk(null);
    await triage(m, { config: config() });
    expect(calls).toHaveLength(1);
    const steps = store.triageSteps(lastRun(m.id).id);
    expect(steps.find((s) => s.rule === "others' review")?.decision).toBe(
      "pass",
    );
  });

  test("a repo with no checkout mapped says so, and Start will ask; a mapped one does not", async () => {
    fakeBrain(() => verdict("task"));
    const unmapped = await triage(reviewAsk({ me: true, teams: [] }, 1), {
      config: config(),
    });
    const said = store
      .turnsForTask(unmapped.taskId!)
      .filter((t) => t.role === TurnRole.trigger);
    expect(said.map((t) => t.body).join("\n")).toContain(
      "acme/api has no checkout mapped",
    );
    // Nothing is guessed into config.
    expect(config().repos["acme/api"]).toBeUndefined();

    taskClosed(unmapped.taskId!, "reviewed");
    testConfig().update((c) => ({ ...c, repos: { "acme/api": "/src/api" } }));
    const m = store.insertMessage({
      channel: "github" as const,
      externalId: "gh:other",
      threadKey: "github:acme/api#41",
      author: "erin",
      authorName: "erin",
      title: "acme/api#41 PR: other (review requested)",
      body: "and this one",
      url: "https://github.com/acme/api/pull/41",
      receivedAt: new Date(Date.UTC(2026, 10, 5, 12, 0)).toISOString(),
      meta: {
        repo: "acme/api",
        number: 41,
        type: "PullRequest",
        reason: "review_requested",
        requested: { me: true, teams: [] },
      },
    })!;
    const mapped = await triage(m, { config: config() });
    expect(store.getTask(mapped.taskId!)!.branch).toBe("pr:41");
    expect(
      store
        .turnsForTask(mapped.taskId!)
        .some((t) => t.body.includes("no checkout mapped")),
    ).toBe(false);
  });

  test("a review asked for in Slack is coding too, and the PR's thread is the task's", async () => {
    fakeBrain(() =>
      verdict("task", {
        review_pr: "https://github.com/acme/api/pull/40/files",
      }),
    );
    const m = store.insertMessage({
      channel: "slack",
      externalId: "slack:C9:1",
      threadKey: "slack:C9:100.0",
      author: "U3",
      authorName: "Priya",
      title: "#payments thread",
      body: "<@UME> can you review https://github.com/acme/api/pull/40 today?",
      url: "https://acme.slack.com/archives/C9/p100",
      receivedAt: new Date(Date.UTC(2026, 10, 5, 12, 1)).toISOString(),
      meta: { channel: "C9", ts: "100.0", mention: true },
    })!;
    const out = await triage(m, { config: config() });
    const task = store.getTask(out.taskId!)!;
    expect(task).toMatchObject({
      kind: "coding",
      repo: "acme/api",
      branch: "pr:40",
    });
    expect(task.url).toBe("https://github.com/acme/api/pull/40");
    expect(store.threadsForTask(task.id)).toContain("github:acme/api#40");
    expect(store.linksForTask(task.id).map((l) => l.url)).toEqual([
      "https://github.com/acme/api/pull/40",
      "https://acme.slack.com/archives/C9/p100",
    ]);
  });

  function slackAsk(meta: Record<string, unknown>, n = 1): MessageRow {
    return store.insertMessage({
      channel: "slack",
      externalId: `slack:C9:${n}`,
      threadKey: `slack:C9:${n}00.0`,
      author: "U3",
      authorName: "Priya",
      title: "#payments thread",
      body: "can someone review https://github.com/acme/api/pull/40 today?",
      url: `https://acme.slack.com/archives/C9/p${n}00`,
      receivedAt: new Date(Date.UTC(2026, 10, 5, 12, n)).toISOString(),
      meta: { channel: "C9", ts: `${n}00.0`, ...meta },
    })!;
  }

  test("Slack talk about a PR that does not tag you is not an ask", async () => {
    fakeBrain(() =>
      verdict("task", { review_pr: "https://github.com/acme/api/pull/40" }),
    );
    const out = await triage(slackAsk({ mention: false }), {
      config: config(),
    });
    expect(out).toMatchObject({ verdict: "held", taskId: null });
  });

  test("a Slack DM asking a review is an ask", async () => {
    fakeBrain(() =>
      verdict("task", { review_pr: "https://github.com/acme/api/pull/40" }),
    );
    const out = await triage(slackAsk({ dm: true }), { config: config() });
    expect(store.getTask(out.taskId!)).toMatchObject({
      kind: "coding",
      branch: "pr:40",
    });
  });

  test("one task per PR: a Slack tag joins the review GitHub asked for", async () => {
    fakeBrain(() =>
      verdict("task", { review_pr: "https://github.com/acme/api/pull/40" }),
    );
    const first = await triage(reviewAsk({ me: true, teams: [] }), {
      config: config(),
    });
    const out = await triage(slackAsk({ mention: true }, 2), {
      config: config(),
    });
    expect(out).toMatchObject({ verdict: "attached", taskId: first.taskId });
    expect(store.threadsForTask(first.taskId!)).toContain("slack:C9:200.0");
    expect(store.linksForTask(first.taskId!).map((l) => l.url)).toContain(
      "https://acme.slack.com/archives/C9/p200",
    );
  });

  test("one task per PR: GitHub's request joins the review a Slack tag made", async () => {
    fakeBrain(() =>
      verdict("task", { review_pr: "https://github.com/acme/api/pull/40" }),
    );
    const first = await triage(slackAsk({ mention: true }), {
      config: config(),
    });
    const out = await triage(reviewAsk({ me: true, teams: [] }, 3), {
      config: config(),
    });
    expect(out).toMatchObject({ verdict: "attached", taskId: first.taskId });
  });

  test("a Slack tag about a reviewed PR brings its closed task back", async () => {
    fakeBrain(() =>
      verdict("task", { review_pr: "https://github.com/acme/api/pull/40" }),
    );
    const first = await triage(reviewAsk({ me: true, teams: [] }), {
      config: config(),
    });
    taskClosed(first.taskId!, "reviewed");
    const out = await triage(slackAsk({ mention: true }, 2), {
      config: config(),
    });
    expect(out.taskId).toBe(first.taskId);
    expect(store.getTask(first.taskId!)!.status).toBe("open");
  });

  function prComment(reason: string, body: string, n = 1): MessageRow {
    return store.insertMessage({
      channel: "github",
      externalId: `gh:c${n}`,
      threadKey: "github:acme/api#40",
      author: "erin",
      authorName: "erin",
      title: "acme/api#40 PR: speed up export (mentioned you)",
      body,
      url: "https://github.com/acme/api/pull/40#issuecomment-9",
      receivedAt: new Date(Date.UTC(2026, 10, 5, 11, n)).toISOString(),
      meta: { repo: "acme/api", number: 40, type: "PullRequest", reason },
    })!;
  }

  test("tagged on a PR: always a review task", async () => {
    fakeBrain(() => verdict("fyi"));
    const m = prComment("mention", "@me can you sanity check the migration?");
    const out = await triage(m, { config: config() });
    expect(out).toMatchObject({
      verdict: "coding",
      reason: "you were tagged on the PR",
    });
    expect(lastRule(m.id)).toBe("review ask");
    expect(store.getTask(out.taskId!)).toMatchObject({
      kind: "coding",
      branch: "pr:40",
      url: "https://github.com/acme/api/pull/40",
    });
  });

  test.each([["acme/payments"], ["payments"]])(
    "a watched team (%s) tagged on a PR: always a review task",
    async (watched) => {
      testConfig().update((c) => ({
        ...c,
        triage: { ...c.triage, reviewTeams: [watched] },
      }));
      fakeBrain(() => verdict("fyi"));
      const out = await triage(
        prComment(
          "team_mention",
          "cc @acme/Payments, does this touch payouts?",
        ),
        { config: config() },
      );
      expect(out).toMatchObject({
        verdict: "coding",
        reason: "acme/Payments was tagged on the PR, a team you watch",
      });
    },
  );

  test("a team you do not watch tagged on a PR: filed for you to read, no model asked", async () => {
    testConfig().update((c) => ({
      ...c,
      triage: { ...c.triage, reviewTeams: ["acme/payments"] },
    }));
    const calls = fakeBrain(() => verdict("coding"));
    const m = prComment(
      "team_mention",
      "@acme/everyone heads up, mail me at ops@acme.com/x",
    );
    const out = await triage(m, { config: config() });
    expect(out).toMatchObject({ verdict: "fyi", taskId: null });
    expect(calls).toHaveLength(0);
    const steps = store.triageSteps(lastRun(m.id).id);
    expect(steps.find((s) => s.rule === "review ask")?.reason).toBe(
      "tagged acme/everyone, not a team you watch",
    );
  });

  test("tagged on an issue is not a review", async () => {
    fakeBrain(() => verdict("fyi"));
    const out = await triage(
      store.insertMessage({
        channel: "github",
        externalId: "gh:i1",
        threadKey: "github:acme/api#12",
        author: "erin",
        authorName: "erin",
        title: "acme/api#12 issue: export drops transfers (mentioned you)",
        body: "@me thoughts?",
        receivedAt: new Date(Date.UTC(2026, 10, 5, 9, 0)).toISOString(),
        meta: {
          repo: "acme/api",
          number: 12,
          type: "Issue",
          reason: "mention",
        },
      })!,
      { config: config() },
    );
    expect(out.verdict).toBe("fyi");
  });

  test("watching a review someone else does stays a watch", async () => {
    fakeBrain(() => verdict("watch"));
    const out = await triage(reviewAsk(null), { config: config() });
    const task = store.getTask(out.taskId!)!;
    expect(task.kind).toBe("task");
    expect(task.watching).toBe(1);
  });
});
