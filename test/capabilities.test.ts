import { describe, expect, test } from "bun:test";
import { generalAllow } from "../src/core/agents";
import { assistantAllow } from "../src/core/assistant";
import {
  CAPABILITIES,
  WRITE_VERB,
  capabilityAllow,
  resolveCapability,
} from "../src/core/capabilities";
import {
  DEFAULT_CONFIG,
  mergeConfig,
  setConfigForTest,
  type AugConfig,
} from "../src/core/config";

function withCaps(caps: Partial<AugConfig["capabilities"]>): AugConfig {
  return {
    ...DEFAULT_CONFIG,
    capabilities: { servers: {}, tools: {}, grants: {}, ...caps },
  };
}

describe("capabilities", () => {
  test("defaults grant nothing", () => {
    expect(capabilityAllow("general", DEFAULT_CONFIG)).toEqual([]);
    expect(capabilityAllow("assistant", DEFAULT_CONFIG)).toEqual([]);
  });

  test("slack.read resolves to read tools on the Slack connector", () => {
    const tools = capabilityAllow(
      "general",
      withCaps({ grants: { general: ["slack.read"] } }),
    );
    expect(tools).toContain("mcp__claude_ai_Slack__slack_read_thread");
    expect(tools).toContain("mcp__claude_ai_Slack__slack_search_public");
    expect(tools.length).toBe(CAPABILITIES["slack.read"]!.tools.length);
  });

  test("built-in capabilities hold no write-looking tools", () => {
    for (const spec of Object.values(CAPABILITIES))
      for (const tool of spec.tools) expect(WRITE_VERB.test(tool)).toBe(false);
  });

  test("grants are per role", () => {
    const config = withCaps({
      grants: {
        general: ["slack.read", "docs.read"],
        assistant: ["slack.read"],
      },
    });
    expect(capabilityAllow("general", config)).toContain(
      "mcp__claude_ai_Claude_Docs__read",
    );
    expect(capabilityAllow("assistant", config)).not.toContain(
      "mcp__claude_ai_Claude_Docs__read",
    );
  });

  test("an unknown capability grants nothing", () => {
    expect(
      capabilityAllow(
        "general",
        withCaps({ grants: { general: ["slack.write"] } }),
      ),
    ).toEqual([]);
  });

  test("a write verb in an override is dropped", () => {
    const config = withCaps({
      tools: {
        "slack.read": [
          "slack_read_thread",
          "slack_send_message",
          "slack_send_message_draft",
          "slack_schedule_message",
          "slack_add_reaction",
          "slack_update_canvas",
        ],
      },
      grants: { general: ["slack.read"] },
    });
    expect(capabilityAllow("general", config)).toEqual([
      "mcp__claude_ai_Slack__slack_read_thread",
    ]);
  });

  test("notion.read resolves to Notion read tools only", () => {
    expect(
      capabilityAllow(
        "assistant",
        withCaps({ grants: { assistant: ["notion.read"] } }),
      ),
    ).toEqual([
      "mcp__claude_ai_Notion__notion-fetch",
      "mcp__claude_ai_Notion__notion-search",
      "mcp__claude_ai_Notion__notion-get-comments",
    ]);
  });

  test("Notion write and session tools are dropped from an override", () => {
    const writes = [
      "notion-create-pages",
      "notion-create-comment",
      "notion-update-page",
      "notion-update-comment",
      "notion-delete-pages",
      "notion-delete-comment",
      "notion-move-pages",
      "notion-duplicate-page",
      "notion-restore-pages",
      "notion-restore-version",
      "notion-set-comment-reaction",
      "notion-set-discussion-resolved",
      "notion-resolve-suggested-edit",
      "notion-create-suggested-edit",
      "notion-upload-skill",
      "notion-convert-page-to-skill",
      "notion-link-meeting-note-to-calendar-event",
      "notion-calendar-cancel-events",
      "notion-calendar-create-events",
      "notion-spawn-session",
      "notion-stop-session",
      "notion-send-message-to-session",
      "notion-wait-session",
      "notion-query-sessions",
    ];
    for (const tool of writes) expect(WRITE_VERB.test(tool)).toBe(true);
    const config = withCaps({
      tools: { "notion.read": ["notion-fetch", ...writes] },
      grants: { general: ["notion.read"] },
    });
    expect(capabilityAllow("general", config)).toEqual([
      "mcp__claude_ai_Notion__notion-fetch",
    ]);
  });

  test("an unknown Notion capability grants nothing", () => {
    expect(
      capabilityAllow(
        "general",
        withCaps({ grants: { general: ["notion.write"] } }),
      ),
    ).toEqual([]);
  });

  test("globs and bare servers never pass", () => {
    const caps = withCaps({
      tools: { "slack.read": ["*", "slack_read_thread", ""] },
    }).capabilities;
    expect(resolveCapability("slack.read", caps)).toEqual([
      "mcp__claude_ai_Slack__slack_read_thread",
    ]);
    const badServer = withCaps({
      servers: { "slack.read": "claude_ai_Slack__*" },
    }).capabilities;
    expect(resolveCapability("slack.read", badServer)).toEqual([]);
  });

  test("server override renames the connector", () => {
    const caps = withCaps({ servers: { "slack.read": "slack" } }).capabilities;
    expect(resolveCapability("slack.read", caps)[0]).toStartWith(
      "mcp__slack__",
    );
  });

  test("mergeConfig fills capabilities from a partial file", () => {
    expect(mergeConfig({}).capabilities).toEqual({
      servers: {},
      tools: {},
      grants: {},
    });
    const merged = mergeConfig({
      capabilities: { grants: { assistant: ["slack.read"] } },
    } as never);
    expect(merged.capabilities.grants.assistant).toEqual(["slack.read"]);
    expect(merged.capabilities.tools).toEqual({});
  });

  test("roles' allow lists carry their grants", () => {
    setConfigForTest(
      withCaps({
        grants: { general: ["docs.read"], assistant: ["slack.read"] },
      }),
    );
    expect(generalAllow()).toContain("mcp__claude_ai_Claude_Docs__query");
    expect(generalAllow()).not.toContain(
      "mcp__claude_ai_Slack__slack_read_thread",
    );
    expect(assistantAllow()).toContain(
      "mcp__claude_ai_Slack__slack_read_thread",
    );
    setConfigForTest(DEFAULT_CONFIG);
  });
});
