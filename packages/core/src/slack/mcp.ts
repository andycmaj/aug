// Option B, reserved: aug as a direct MCP client to a local Slack MCP server
// (no model in the loop). Not built yet; selecting it says so in the status
// line instead of failing quietly. Config keys reserved: slack.mcp.command,
// slack.mcp.url.

import type { SlackPollResult, SlackReply, SlackTransport } from "./shared";

export const MCP_NOT_BUILT =
  "slack.transport 'mcp' is not built yet (use token or claude-mcp)";

export class McpTransport implements SlackTransport {
  readonly kind = "mcp" as const;

  available(): { ok: boolean; detail: string } {
    return { ok: false, detail: MCP_NOT_BUILT };
  }

  poll(): Promise<SlackPollResult> {
    return Promise.reject(new Error(MCP_NOT_BUILT));
  }

  send(_action: SlackReply): Promise<string> {
    return Promise.reject(new Error(MCP_NOT_BUILT));
  }

  stop(): void {}
}
