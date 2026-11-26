// What MCP servers a real headless `claude -p` loads for the Assistant
// (AUG-0162). claude.ai connectors load even with --setting-sources "", and a
// resumed session that connects them late re-adds their schemas every turn,
// missing the prompt cache. Ungranted, none may load. Reads only the init
// line, then kills claude, so it costs next to nothing; still needs the real
// CLI and the owner's connectors, so it runs only with RIKER_REAL_CLAUDE=1:
//   RIKER_REAL_CLAUDE=1 bun test test/no-connectors-real.test.ts

import { describe, expect, test } from "bun:test";
import { ASSISTANT_TOOLS, assistantAllow } from "../src/assistant";
import { brainEnv, claudeArgs, type BrainCall } from "../src/brain";
import { DEFAULT_CONFIG, type RikerConfig } from "../src/config";
import { claudeEnv } from "../src/self";
import { freshHome } from "./support/helpers";

interface Init {
  tools: string[];
  mcp_servers: { name: string; status: string }[];
}

async function init(call: BrainCall): Promise<Init> {
  const proc = Bun.spawn(["claude", ...claudeArgs(call)], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    // Connect before init, so a connector that loads is listed as connected.
    env: claudeEnv({ ...brainEnv(call), MCP_CONNECTION_NONBLOCKING: "false" }),
  });
  await proc.stdin.write(call.prompt);
  await proc.stdin.end();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of proc.stdout) {
      buffer += decoder.decode(chunk, { stream: true });
      for (const line of buffer.split("\n").slice(0, -1)) {
        const event = JSON.parse(line) as { type: string; subtype?: string };
        if (event.type === "system" && event.subtype === "init") {
          return event as unknown as Init;
        }
      }
    }
  } finally {
    proc.kill();
  }
  throw new Error("claude gave no init line");
}

function assistantCall(config: RikerConfig): BrainCall {
  return {
    prompt: "Say ok.",
    model: "haiku",
    tools: ASSISTANT_TOOLS,
    allow: assistantAllow(config),
  };
}

function granted(assistant: string[]): RikerConfig {
  return {
    ...DEFAULT_CONFIG,
    capabilities: { ...DEFAULT_CONFIG.capabilities, grants: { assistant } },
  };
}

describe.skipIf(!process.env.RIKER_REAL_CLAUDE)(
  "connectors in a headless turn",
  () => {
    test("the Assistant with no MCP grant loads no MCP server", async () => {
      freshHome();
      const got = await init(assistantCall(granted([])));
      expect(got.mcp_servers).toEqual([]);
      expect(got.tools.filter((t) => t.startsWith("mcp__"))).toEqual([]);
    }, 60_000);

    test("with slack.read granted, the claude.ai connectors load and connect", async () => {
      freshHome();
      const got = await init(assistantCall(granted(["slack.read"])));
      const slack = got.mcp_servers.find((s) => s.name === "claude.ai Slack");
      expect(slack?.status).toBe("connected");
      expect(
        got.tools.some((t) => t.startsWith("mcp__claude_ai_Slack__")),
      ).toBe(true);
    }, 60_000);
  },
);
