import { beforeEach, describe, expect, test } from "bun:test";
import {
  AgentPool,
  actionFor,
  codingLaunch,
  hookSettings,
} from "../src/core/agents";
import { handleDone, handleHook } from "../src/core/hooks";
import { applyLesson } from "../src/core/learn";
import { brainEnv, claudeArgs, deniedCalls, parseStreamLine } from "../src/core/brain";
import { toMessage } from "../src/core/ingest/github";
import { plainText, threadKeyFor } from "../src/core/slack/shared";
import * as store from "../src/core/store";
import {
  AgentState,
  Kind,
  SessionKind,
  TaskStatus,
  TurnRole,
} from "../src/core/types";
import { fakeBrain, freshHome } from "./helpers";

let seq = 0;
function slackTask(): number {
  seq++;
  const t = store.createTask({
    title: "Seat count",
    kind: Kind.reply,
    channel: "slack",
    threadKey: "slack:C1:111.1",
  });
  const m = store.insertMessage({
    channel: "slack",
    externalId: `slack:C1:111.${seq}`,
    threadKey: "slack:C1:111.1",
    author: "U9",
    authorName: "Ruth",
    title: "#renewals",
    body: "How many seats do we need?",
    receivedAt: new Date().toISOString(),
    meta: { channel: "C1", ts: "111.1" },
  })!;
  store.fileMessage(m.id, "reply", "question", t.id);
  store.addTurn({
    taskId: t.id,
    role: TurnRole.incoming,
    author: "Ruth",
    body: m.body,
    messageId: m.id,
  });
  return t.id;
}

describe("general agent turns", () => {
  beforeEach(() => freshHome());

  test("a turn answers in three sections and sets up the reply on the thread it came from", async () => {
    const taskId = slackTask();
    const calls = fakeBrain(() => ({
      about: "Ruth wants the seat count.",
      did: "**42 seats** per the licence export.",
      next: "The reply to Ruth is below.",
      state: "ready",
      action: { kind: "reply", text: "42 seats." },
    }));
    const pool = new AgentPool({ limit: () => 4 });
    await pool.request(taskId, "test", "owner");
    const turn = store.turnsForTask(taskId).at(-1)!;
    expect(turn.role).toBe(TurnRole.agent);
    expect(turn.did).toContain("42 seats");
    const pending = store.pendingAction(taskId)!;
    expect(pending.action).toEqual({
      type: "slack_reply",
      channel: "C1",
      thread_ts: "111.1",
      to: "Ruth",
      text: "42 seats.",
    });
    expect(store.getTask(taskId)!.agent_state).toBe(AgentState.agentdone);
    // read-only tools, denied without asking
    expect(calls[0].allow).toContain("Bash(gh pr view:*)");
    expect(calls[0].allow).not.toContain("Bash");
  });

  test("the next turn resumes the same session; a newer draft retires the older one", async () => {
    const taskId = slackTask();
    let n = 0;
    const calls = fakeBrain(() => ({
      about: "a",
      did: "b",
      next: "c",
      state: "ready",
      action: { kind: "reply", text: `draft ${++n}` },
    }));
    const pool = new AgentPool({ limit: () => 4 });
    await pool.request(taskId, "first", "owner");
    await pool.request(taskId, "second", "owner");
    expect(calls[1].resume).toBe(calls[0].sessionId);
    const turns = store
      .turnsForTask(taskId)
      .filter((t) => t.role === TurnRole.agent);
    expect(turns.map((t) => t.action_state)).toEqual(["retired", "pending"]);
  });

  test("an asking agent is waiting on you, with what it asked", async () => {
    const taskId = slackTask();
    fakeBrain(() => ({
      about: "a",
      did: "b",
      next: "Which licence tier?",
      state: "asking",
    }));
    await new AgentPool({ limit: () => 4 }).request(taskId, "x", "owner");
    const task = store.getTask(taskId)!;
    expect(task.agent_state).toBe(AgentState.blocked);
    expect(task.agent_says).toBe("Which licence tier?");
  });

  test("aug-started turns queue past Agents at once; owner-started ones never wait", async () => {
    const ids = [slackTask(), slackTask(), slackTask()];
    fakeBrain(() => ({ about: "a", did: "b", next: "c", state: "done" }));
    const pool = new AgentPool({ limit: () => 1 });
    const first = pool.request(ids[0], "x", "aug");
    expect(pool.request(ids[1], "x", "aug")).toBeNull();
    expect(store.getTask(ids[1])!.agent_state).toBe(AgentState.queued);
    expect(pool.request(ids[2], "x", "owner")).not.toBeNull();
    await first;
  });

  test("GitHub close-outs only where the system has them", () => {
    const t = store.createTask({
      title: "x",
      kind: Kind.general,
      channel: "github",
    });
    const m = store.insertMessage({
      channel: "github",
      externalId: "gh:1",
      threadKey: "github:a/b#3",
      author: "erin",
      authorName: "erin",
      title: "",
      body: "x",
      receivedAt: new Date().toISOString(),
      meta: { repo: "a/b", number: 3, type: "Issue" },
    })!;
    store.fileMessage(m.id, "general", "", t.id);
    expect(actionFor(t, { kind: "merge_pr", text: "done" })).toEqual({
      type: "github_comment",
      repo: "a/b",
      number: 3,
      body: "done",
      close: undefined,
    });
    expect(
      actionFor(t, { kind: "close_issue", text: "fixed" })?.type ===
        "github_comment" &&
        actionFor(t, { kind: "close_issue", text: "fixed" }),
    ).toMatchObject({ close: "issue" });
  });
});

describe("coding agent", () => {
  beforeEach(() => freshHome());

  test("launch carries hooks, the brief and the task's env", () => {
    const t = store.createTask({
      title: "Fix export",
      kind: Kind.coding,
      channel: "owner",
    });
    const launch = codingLaunch(t);
    expect(launch.argv[0]).toBe("claude");
    expect(launch.argv).toContain("--settings");
    expect(launch.env.AUG_TASK_ID).toBe(String(t.id));
    const hooks = hookSettings().hooks as Record<string, unknown>;
    expect(Object.keys(hooks)).toEqual([
      "UserPromptSubmit",
      "PreToolUse",
      "Notification",
      "Stop",
      "SessionEnd",
    ]);
  });

  test("hooks move the agent through its states; done writes it up", () => {
    const t = store.createTask({
      title: "Fix export",
      kind: Kind.coding,
      channel: "owner",
    });
    store.createSession({
      id: "s1",
      taskId: t.id,
      kind: SessionKind.tmux,
      cwd: "/tmp",
      startedBy: "aug",
    });
    const env = { taskId: t.id, sessionId: "s1" };
    handleHook("prompt", {}, env);
    expect(store.getTask(t.id)!.agent_state).toBe(AgentState.working);
    handleHook(
      "tool",
      { tool_name: "Edit", tool_input: { file_path: "src/export.ts" } },
      env,
    );
    expect(store.getSession("s1")!.last_tool).toBe("Edit src/export.ts");
    handleHook("stop", {}, env);
    expect(store.getTask(t.id)!.agent_state).toBe(AgentState.blocked);
    handleDone(env, { summary: "Export keeps transfers; 14 tests green" });
    const task = store.getTask(t.id)!;
    expect(task.agent_state).toBe(AgentState.agentdone);
    // nobody asked from outside, aug started it: done, and unread until read
    expect(task.status).toBe(TaskStatus.done);
    expect(task.unread_result).toBe(1);
    handleHook("end", {}, env);
    expect(store.getTask(t.id)!.agent_state).toBe(AgentState.agentdone);
  });
});

describe("brain stream", () => {
  test("tool calls become one-line steps; the result is kept", () => {
    const steps: string[] = [];
    const acc = {
      text: "",
      result: null as never,
      sessionId: null as string | null,
    };
    parseStreamLine(
      JSON.stringify({
        type: "assistant",
        session_id: "s",
        message: {
          content: [
            {
              type: "tool_use",
              name: "WebSearch",
              input: { query: "same-day pay" },
            },
          ],
        },
      }),
      (s) => steps.push(s),
      acc,
    );
    parseStreamLine(
      JSON.stringify({
        type: "result",
        result: "ok",
        structured_output: { a: 1 },
      }),
      undefined,
      acc,
    );
    expect(steps).toEqual(["WebSearch same-day pay"]);
    expect(acc.sessionId).toBe("s");
  });

  test("a denial names the whole command dontAsk turned away", () => {
    expect(
      deniedCalls({
        type: "result",
        permission_denials: [
          { tool_name: "Bash", tool_input: { command: "cd /r && gh pr view 1", description: "d" } },
          { tool_name: "mcp__x__read", tool_input: { id: "1" } },
        ],
      }),
    ).toEqual(["Bash cd /r && gh pr view 1", 'mcp__x__read {"id":"1"}']);
    expect(deniedCalls({ type: "result" })).toEqual([]);
  });

  test("no tools means none; allow rules deny the rest", () => {
    const args = claudeArgs({ prompt: "x", allow: ["Read"] });
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
  });
});

describe("learning", () => {
  test("a new lesson waits under Watching; a repeat at strength 4 moves into its section, keeping evidence", () => {
    const base = "# LEARNED\n\n## What you care about\n\n## Watching\n";
    const first = applyLesson(
      base,
      {
        skip: false,
        section: "What you care about",
        text: "Vendor disputes are yours",
        strength: 2,
      },
      "c1",
      "2026-11-05",
    );
    expect(first.text).toContain(
      "## Watching\n- Vendor disputes are yours [s:2 | ev: c1 | seen: 2026-11-05]",
    );
    const second = applyLesson(
      first.text,
      {
        skip: false,
        section: "What you care about",
        text: "Vendor disputes are yours",
        strength: 4,
        replaces: first.line,
      },
      "c7",
      "2026-11-06",
    );
    expect(second.text).toContain(
      "## What you care about\n- Vendor disputes are yours [s:4 | ev: c1,c7 | seen: 2026-11-06]",
    );
    expect(second.text.match(/Vendor disputes/g)).toHaveLength(1);
  });
});

describe("ingest", () => {
  test("a GitHub notification is one message on its issue's thread", () => {
    const m = toMessage(
      {
        id: "9",
        reason: "mention",
        updated_at: "2026-11-05T10:00:00Z",
        subject: {
          title: "Export drops transfers",
          url: "https://api.github.com/repos/a/b/issues/12",
          latest_comment_url: null,
          type: "Issue",
        },
        repository: { full_name: "a/b", html_url: "https://github.com/a/b" },
      },
      {
        user: { login: "erin" },
        body: "@me can you look?",
        html_url: "https://github.com/a/b/issues/12",
      },
      "me",
    )!;
    expect(m.threadKey).toBe("github:a/b#12");
    expect(m.title).toContain("mentioned you");
    expect(m.fromMe).toBe(false);
  });

  test("Slack text and thread keys", () => {
    const names = new Map([["U1", "Ruth"]]);
    expect(
      plainText(
        "<@U1> see <https://x.io|the doc> in <#C9|general> &amp; go",
        names,
      ),
    ).toBe("@Ruth see the doc (https://x.io) in #general & go");
    expect(threadKeyFor("D1", { ts: "1.1" }, true)).toBe("slack:D1:dm");
    expect(threadKeyFor("C1", { ts: "2.2", thread_ts: "1.1" }, false)).toBe(
      "slack:C1:1.1",
    );
  });
});

describe("brainEnv", () => {
  test("waits for connectors only when an MCP tool is allowed", () => {
    expect(brainEnv({ prompt: "x", allow: ["Read"] })).toEqual({});
    expect(
      brainEnv({
        prompt: "x",
        allow: ["Read", "mcp__claude_ai_Slack__slack_read_thread"],
      }),
    ).toEqual({ MCP_CONNECTION_NONBLOCKING: "false" });
    expect(
      brainEnv({
        prompt: "x",
        allow: ["mcp__a__b"],
        env: { MCP_CONNECTION_NONBLOCKING: "true" },
      }),
    ).toEqual({ MCP_CONNECTION_NONBLOCKING: "true" });
  });
});
