// Which way Riker talks to Slack, from slack.transport in config.

import { slackToken, type RikerConfig } from "../config";
import { ClaudeMcpTransport } from "./claude-mcp";
import { McpTransport } from "./mcp";
import type { SlackTransport } from "./shared";
import { TokenTransport } from "./token";

export function slackTransport(config: RikerConfig): SlackTransport {
  switch (config.slack.transport) {
    case "claude-mcp":
      return new ClaudeMcpTransport({
        model: config.brain.slackModel,
        server: config.slack.mcpServer,
      });
    case "mcp":
      return new McpTransport();
    default:
      return new TokenTransport(slackToken(config));
  }
}

export type { SlackTransport } from "./shared";
