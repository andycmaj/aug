// Which way Riker talks to Slack, from slack.transport in config.

import type { RikerConfig } from "@riker/core/config";
import { slackConfig, slackToken } from "./config";
import { ClaudeMcpTransport } from "./claude-mcp";
import { McpTransport } from "./mcp";
import type { SlackTransport } from "./shared";
import { TokenTransport } from "./token";

export function slackTransport(config: RikerConfig): SlackTransport {
  switch (slackConfig.of(config).transport) {
    case "claude-mcp":
      return new ClaudeMcpTransport({
        model: slackConfig.of(config).model,
        server: slackConfig.of(config).mcpServer,
      });
    case "mcp":
      return new McpTransport();
    default:
      return new TokenTransport(slackToken(config));
  }
}

export type { SlackTransport } from "./shared";
