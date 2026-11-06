import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, mergeConfig } from "../src/core/config";
import {
  ClaudeMcpTransport,
  discoverSlackTools,
  PersistentClaude,
  polledToRaw,
  type ProcLike,
} from "../src/core/slack/claude-mcp";
import { McpTransport } from "../src/core/slack/mcp";
import { rawToNewMessage } from "../src/core/slack/shared";
import { TokenTransport } from "../src/core/slack/token";
import { slackTransport } from "../src/core/slack/transport";
import { fakeBrain, freshHome } from "./helpers";

const TOOLS = [
  "Read",
  "mcp__claude_ai_Claude_Docs__read",
  "mcp__claude_ai_Slack__slack_search_messages",
  "mcp__claude_ai_Slack__slack_read_channel",
  "mcp__claude_ai_Slack__slack_read_thread",
  "mcp__claude_ai_Slack__slack_send_message",
  "mcp__claude_ai_Slack__slack_schedule_message",
  "mcp__claude_ai_Slack__slack_create_canvas",
];

// A fake `claude -p` in stream-json mode: answers each user line with the
// next scripted result, and records what it was asked.
function fakeProc(
  answers: unknown[],
  log: { argv: string[][]; asked: string[] },
) {
  return (argv: string[]): ProcLike => {
    log.argv.push(argv);
    const pending: string[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    const push = (line: string) => {
      pending.push(line);
      wake?.();
    };
    async function* lines(): AsyncGenerator<string> {
      while (!closed || pending.length) {
        if (!pending.length) await new Promise<void>((r) => (wake = r));
        wake = null;
        while (pending.length) yield pending.shift()!;
      }
    }
    return {
      write(line) {
        const msg = JSON.parse(line) as {
          message: { content: { text: string }[] };
        };
        log.asked.push(msg.message.content[0].text);
        if (log.asked.length === 1 || log.argv.length > 0) {
          push(
            JSON.stringify({ type: "system", subtype: "init", tools: TOOLS }),
          );
        }
        push(
          JSON.stringify({
            type: "result",
            structured_output: answers.shift() ?? { messages: [] },
          }),
        );
      },
      lines: lines(),
      kill() {
        closed = true;
        wake?.();
      },
    };
  };
}

// The claude.ai Slack connector's real tool list.
const CLAUDE_AI_SLACK = [
  "add_list_record", "add_reaction", "complete_file_upload", "create_canvas", "create_conversation",
  "create_list", "get_file_upload_url", "get_reactions", "list_channel_members", "list_user_channels",
  "read_canvas", "read_channel", "read_file", "read_list", "read_thread", "read_user_profile",
  "schedule_message", "search_channels", "search_emojis", "search_public", "search_public_and_private",
  "search_users", "send_message_draft", "send_message", "update_canvas", "update_list", "update_list_record",
].map((t) => `mcp__claude_ai_Slack__slack_${t}`);

describe("tool discovery", () => {
  test("the claude.ai connector: plain send, reads stay reads", () => {
    const t = discoverSlackTools(CLAUDE_AI_SLACK)!;
    expect(t.send).toBe("mcp__claude_ai_Slack__slack_send_message");
    const short = (names: string[]) => names.map((n) => n.replace("mcp__claude_ai_Slack__slack_", "")).sort();
    expect(short(t.write)).toEqual([
      "add_list_record", "add_reaction", "complete_file_upload", "create_canvas", "create_conversation",
      "create_list", "get_file_upload_url", "schedule_message", "send_message", "send_message_draft",
      "update_canvas", "update_list", "update_list_record",
    ]);
    expect(short(t.read)).toContain("get_reactions");
    expect(short(t.read)).toContain("search_public_and_private");
  });

  test("finds the Slack server and splits read from write tools", () => {
    const t = discoverSlackTools(TOOLS)!;
    expect(t.server).toBe("claude_ai_Slack");
    expect(t.read).toEqual([
      "mcp__claude_ai_Slack__slack_search_messages",
      "mcp__claude_ai_Slack__slack_read_channel",
      "mcp__claude_ai_Slack__slack_read_thread",
    ]);
    expect(t.write).toContain("mcp__claude_ai_Slack__slack_create_canvas");
    expect(t.send).toBe("mcp__claude_ai_Slack__slack_send_message");
  });

  test("a configured server name matches however it is written", () => {
    expect(discoverSlackTools(TOOLS, "claude.ai Slack")?.server).toBe(
      "claude_ai_Slack",
    );
    expect(discoverSlackTools(TOOLS, "nope")).toBeNull();
    expect(discoverSlackTools(["Read", "mcp__github__get_issue"])).toBeNull();
  });
});

describe("PersistentClaude", () => {
  test("one process across turns, a fresh one after maxTurns", async () => {
    const log = { argv: [] as string[][], asked: [] as string[] };
    const session = new PersistentClaude(() => ["claude", "-p"], {
      maxTurns: 2,
      spawn: fakeProc([{ n: 1 }, { n: 2 }, { n: 3 }], log),
    });
    expect((await session.ask("a")).structured).toEqual({ n: 1 });
    expect((await session.ask("b")).structured).toEqual({ n: 2 });
    expect(session.spawns).toBe(1);
    expect((await session.ask("c")).structured).toEqual({ n: 3 });
    expect(session.spawns).toBe(2);
    expect(log.asked).toEqual(["a", "b", "c"]);
  });
});

describe("claude-mcp transport", () => {
  beforeEach(() => freshHome());

  test("the read session may only read; polls map to messages and move the cursor", async () => {
    const log = { argv: [] as string[][], asked: [] as string[] };
    const transport = new ClaudeMcpTransport({
      model: "haiku",
      listTools: async () => TOOLS,
      spawn: fakeProc(
        [
          {
            messages: [
              {
                channel: "D1",
                is_dm: true,
                ts: "1800000001.000100",
                user_id: "U9",
                user_name: "Ruth",
                text: "seats?",
                from_me: false,
              },
              {
                channel: "C1",
                channel_name: "eng",
                is_dm: false,
                ts: "1800000002.000100",
                thread_ts: "1800000000.0",
                user_name: "Sam",
                text: "+1",
                from_me: false,
              },
              {
                channel: "C1",
                is_dm: false,
                ts: "1700000000.0",
                user_name: "Old",
                text: "stale",
                from_me: false,
              },
            ],
            newest_ts: "1800000002.000100",
          },
        ],
        log,
      ),
    });
    const result = await transport.poll({
      cursor: { channels: {}, threads: {}, since: "1799999999" },
      watchChannels: ["C1"],
      trackedThreads: ["C7:1730.2"],
      firstLookSeconds: 86400,
    });
    const argv = log.argv[0];
    const allowed = argv.slice(
      argv.indexOf("--allowedTools") + 1,
      argv.indexOf("--disallowedTools"),
    );
    expect(allowed.every((t) => !/send|create|schedule/.test(t))).toBe(true);
    expect(argv.slice(argv.indexOf("--disallowedTools") + 1)).toContain(
      "mcp__claude_ai_Slack__slack_send_message",
    );
    expect(argv[argv.indexOf("--setting-sources") + 1]).toBe("user");
    expect(log.asked[0]).toContain("C1");
    expect(log.asked[0]).toContain("C7:1730.2");
    // the stale one is older than the cursor and dropped
    expect(result.messages.map((m) => m.threadKey)).toEqual([
      "slack:D1:dm",
      "slack:C1:1800000000.0",
    ]);
    expect(result.messages[0].title).toBe("DM with Ruth");
    expect(result.cursor.since).toBe("1800000002.000100");
    transport.stop();
  });

  test("no Slack server: polling says how to fix it", async () => {
    let looks = 0;
    const transport = new ClaudeMcpTransport({
      model: "haiku",
      retryMs: 1,
      listTools: async () => {
        looks++;
        return ["Read"];
      },
    });
    await expect(
      transport.poll({
        cursor: { channels: {}, threads: {} },
        watchChannels: [],
        trackedThreads: [],
        firstLookSeconds: 60,
      }),
    ).rejects.toThrow("no Slack MCP");
    expect(looks).toBe(3);
  });

  test("a connector still connecting on the first look is found on the next", async () => {
    let looks = 0;
    const transport = new ClaudeMcpTransport({
      model: "haiku",
      retryMs: 1,
      listTools: async () => (++looks === 1 ? ["Read"] : TOOLS),
    });
    fakeBrain(() => ({ ok: true }));
    await transport.send({ type: "slack_reply", channel: "C1", text: "x" });
    expect(looks).toBe(2);
  });

  test("a send is its own call, allowed only the send tool, with the approved words", async () => {
    const calls = fakeBrain(() => ({ ok: true, ts: "1.2" }));
    const transport = new ClaudeMcpTransport({
      model: "haiku",
      listTools: async () => TOOLS,
    });
    const receipt = await transport.send({
      type: "slack_reply",
      channel: "C7",
      thread_ts: "1730.2",
      to: "Ruth",
      text: "42 seats.",
    });
    expect(receipt).toContain("for Ruth");
    expect(calls[0].allow).toEqual([
      "mcp__claude_ai_Slack__slack_send_message",
    ]);
    expect(calls[0].disallow).toContain(
      "mcp__claude_ai_Slack__slack_read_channel",
    );
    expect(calls[0].settingSources).toBe("user");
    expect(calls[0].prompt).toContain("42 seats.");
  });

  test("a send Slack did not confirm is an error, not a receipt", async () => {
    fakeBrain(() => ({ ok: false, error: "channel_not_found" }));
    const transport = new ClaudeMcpTransport({
      model: "haiku",
      listTools: async () => TOOLS,
    });
    await expect(
      transport.send({ type: "slack_reply", channel: "C0", text: "x" }),
    ).rejects.toThrow("channel_not_found");
  });
});

describe("transport selection", () => {
  test("from config; claude-mcp polls less often unless told", () => {
    expect(slackTransport({ ...DEFAULT_CONFIG }).kind).toBe("token");
    const mcp = mergeConfig({ slack: { transport: "claude-mcp" } });
    expect(mcp.slack.pollSeconds).toBe(180);
    expect(slackTransport(mcp).kind).toBe("claude-mcp");
    expect(
      mergeConfig({ slack: { transport: "claude-mcp", pollSeconds: 90 } }).slack
        .pollSeconds,
    ).toBe(90);
  });

  test("token without a token is unavailable and says so", () => {
    expect(new TokenTransport(undefined).available()).toEqual({
      ok: false,
      detail: expect.stringContaining("claude-mcp"),
    });
  });

  test("the mcp option is a stub that says it is not built", async () => {
    const t = new McpTransport();
    expect(t.available().ok).toBe(false);
    await expect(t.poll()).rejects.toThrow("not built yet");
  });
});

describe("one message shape", () => {
  test("a thread root's own thread_ts is not a reply", () => {
    const m = rawToNewMessage(
      polledToRaw({
        channel: "D1",
        is_dm: true,
        ts: "5.0",
        thread_ts: "5.0",
        user_name: "R",
        text: "x",
        from_me: false,
      }),
    );
    expect(m.threadKey).toBe("slack:D1:dm");
  });
});
