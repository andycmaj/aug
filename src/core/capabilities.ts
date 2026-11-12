// Capabilities: names aug owns ("slack.read"), mapped to the concrete MCP tool
// names claude is allowed to call. Agents and the Home assistant are granted
// capabilities in ~/.aug/config.json; this is the one place that knows what a
// capability means for a given connector.
//
// Fail closed: only tools named by a capability are ever allowed, and any name
// that looks like a write is dropped even if a config override lists it.
// Sessions run with --permission-mode dontAsk, so anything not allowed here is
// simply denied.

import { loadConfig, type AugConfig } from "./config";
import { logger } from "./log";
import { TOOLS_NAME } from "./self";
import { TurnRole, type TurnRow } from "./types";

const log = logger("capabilities");

// Wins over everything: a capability tool matching this is never allowed.
export const WRITE_VERB =
  /send|post|reply|create|update|delete|edit|schedule|upload|invite|join|leave|archive|set_|set-|add_|add-|remove|pin|kick|rename|spawn|stop|move|duplicate|restore|resolve|share|certify|batch|complete|convert|link|cancel|session|wait/i;

// A bare name, so an override can never widen to a whole server or a glob.
const NAME = /^[A-Za-z0-9_-]+$/;

export interface CapabilitySpec {
  server: string; // the segment in mcp__<server>__<tool>
  tools: string[]; // bare tool names
}

export const CAPABILITIES: Record<string, CapabilitySpec> = {
  "slack.read": {
    server: "claude_ai_Slack",
    tools: [
      "slack_read_thread",
      "slack_read_channel",
      "slack_read_canvas",
      "slack_read_file",
      "slack_read_list",
      "slack_read_user_profile",
      "slack_search_public",
      "slack_search_public_and_private",
      "slack_search_channels",
      "slack_search_users",
    ],
  },
  "docs.read": {
    server: "claude_ai_Claude_Docs",
    tools: ["read", "export", "guide", "query"],
  },
  "notion.read": {
    server: "claude_ai_Notion",
    tools: ["notion-fetch", "notion-search", "notion-get-comments"],
  },
};

// gh commands that only read, for looking up issues, PRs and runs. Not
// `gh api`: a method flag or a field turns it into a write.
export const GH_READS = [
  "gh pr view",
  "gh pr list",
  "gh pr diff",
  "gh pr checks",
  "gh pr status",
  "gh issue view",
  "gh issue list",
  "gh issue status",
  "gh search",
  "gh run view",
  "gh run list",
  "gh repo view",
].map((c) => `Bash(${c}:*)`);

// Rules match a command's prefix, and each part of `a && b` must match on its
// own; `cd` into another folder never does. Said to every headless shell.
export const SHELL_HOWTO =
  `Run one command per Bash call, written out in full and starting with the command itself: no \`cd <dir> &&\` in front, no shell variables ($B), no chaining with ; or &&. Put each URL or argument with spaces in double quotes (a bare & in a URL splits the command). Anything else is denied without asking. For gh, pass --repo owner/repo rather than changing into a checkout. A denied call means the command did not match, not that Bash is off: write it again that way (aug's tools as ${TOOLS_NAME} <command>) and try once more before giving up.`;

export const DENIED_STEP = "denied: ";

// A resumed session remembers its own denied commands and tends to replay
// them word for word, so the next turn names them and how to write them.
export function deniedNote(turns: TurnRow[]): string {
  const last = turns.findLast((t) => t.role === TurnRole.agent);
  const steps: unknown = last?.steps ? JSON.parse(last.steps) : [];
  const denied = Array.isArray(steps)
    ? steps.filter((s): s is string => typeof s === "string" && s.startsWith(DENIED_STEP))
    : [];
  if (!denied.length) return "";
  return [
    "Your last turn was denied these calls, because they did not match an allowed command:",
    ...denied.map((s) => `- ${s.slice(DENIED_STEP.length)}`),
    `Do not repeat them. ${SHELL_HOWTO}`,
  ].join("\n");
}

export type Role = "general" | "assistant";

export function resolveCapability(
  name: string,
  config: AugConfig["capabilities"],
): string[] {
  const base = CAPABILITIES[name];
  const server = config.servers[name] ?? base?.server;
  const tools = config.tools[name] ?? base?.tools;
  if (!server || !tools) {
    log.warn("unknown capability, nothing granted", { capability: name });
    return [];
  }
  if (!NAME.test(server)) {
    log.warn("bad server name, nothing granted", { capability: name, server });
    return [];
  }
  const allowed: string[] = [];
  for (const tool of tools) {
    if (!NAME.test(tool)) {
      log.warn("bad tool name dropped from capability", {
        capability: name,
        tool,
      });
      continue;
    }
    if (WRITE_VERB.test(tool)) {
      log.warn("write-looking tool dropped from capability", {
        capability: name,
        tool,
      });
      continue;
    }
    allowed.push(`mcp__${server}__${tool}`);
  }
  return allowed;
}

// Extra --allowedTools entries a role gets from its granted capabilities.
export function capabilityAllow(
  role: Role,
  config: AugConfig = loadConfig(),
): string[] {
  const granted = config.capabilities.grants[role] ?? [];
  return [
    ...new Set(
      granted.flatMap((c) => resolveCapability(c, config.capabilities)),
    ),
  ];
}
