// Slack's parts of config.json: "slack" (the inbox poller and how Slack is
// reached) and "remote" (talking to the Assistant from Slack).

import { configSection, type RikerConfig } from "@riker/core/config";

export interface SlackConfig {
  enabled: boolean;
  // token: the Web API with a user token. claude-mcp: Claude with a Slack
  // MCP (e.g. the claude.ai Slack connector), for when there is no token.
  // mcp: Riker as a direct MCP client (reserved, not built).
  transport: "token" | "claude-mcp" | "mcp";
  // Which MCP server is Slack (substring of its name); default: one named slack.
  mcpServer?: string;
  // Reserved for transport "mcp".
  mcp?: { command?: string[]; url?: string };
  // A user token (xoxp-): replies go back as you, not as a bot.
  token?: string;
  pollSeconds: number;
  // Channel ids whose every message is triaged; elsewhere only DMs and
  // mentions of you are.
  channels: string[];
  // Reads and sends Slack under transport claude-mcp. Read from
  // brain.slackModel in a file written before it moved here.
  model: string;
}

// Under claude-mcp every poll is a model turn, so it polls less often unless
// told otherwise.
const CLAUDE_MCP_POLL_SECONDS = 180;
const CLAUDE_MCP_REMOTE_SECONDS = 60;

const SLACK_DEFAULTS: SlackConfig = {
  enabled: true,
  transport: "token",
  pollSeconds: 60,
  channels: [],
  model: "haiku",
};

export const slackConfig = configSection<SlackConfig>(
  "slack",
  SLACK_DEFAULTS,
  (written, config) => ({
    ...SLACK_DEFAULTS,
    ...written,
    pollSeconds:
      written.pollSeconds ??
      (written.transport === "claude-mcp"
        ? CLAUDE_MCP_POLL_SECONDS
        : SLACK_DEFAULTS.pollSeconds),
    model: written.model ?? legacyModel(config) ?? SLACK_DEFAULTS.model,
  }),
);

function legacyModel(config: RikerConfig): string | undefined {
  const model = (config.brain as { slackModel?: unknown }).slackModel;
  return typeof model === "string" ? model : undefined;
}

// Talking to the Assistant from Slack (remote.ts): your messages in one
// conversation that only you are in reach Home, and its answers come back
// in the thread. Separate from slack.enabled (the inbound triage poller) and
// off until turned on. It reads and posts the way slack.transport says.
export interface RemoteConfig {
  enabled: boolean;
  // Your self-DM (D...) or a private channel with only you in it. The
  // token transport finds your self-DM when unset; claude-mcp needs it.
  channel?: string;
  // Default 15 with a token, 60 under claude-mcp (each read is a turn).
  pollSeconds: number;
  // Posts to the same conversation when a task's agent finished (coding
  // work, or work it closed) or is waiting for you. None by default.
  notify: ("finished" | "waiting")[];
}

const REMOTE_DEFAULTS: RemoteConfig = {
  enabled: false,
  pollSeconds: 15,
  notify: [],
};

export const remoteConfig = configSection<RemoteConfig>(
  "remote",
  REMOTE_DEFAULTS,
  (written, config) => ({
    ...REMOTE_DEFAULTS,
    ...written,
    pollSeconds:
      written.pollSeconds ??
      (slackConfig.of(config).transport === "claude-mcp"
        ? CLAUDE_MCP_REMOTE_SECONDS
        : REMOTE_DEFAULTS.pollSeconds),
  }),
);

export function slackToken(config: RikerConfig): string | undefined {
  return process.env.SLACK_TOKEN ?? slackConfig.of(config).token;
}
