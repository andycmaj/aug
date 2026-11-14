// ~/.aug/config.json. Every key is optional; a missing file means defaults,
// which is enough to run with `gh` logged in and SLACK_TOKEN set.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { paths, ensureHome } from "./paths";

export interface AugConfig {
  github: {
    enabled: boolean;
    pollSeconds: number;
    // owner/repo -> local checkout, where a coding agent works.
    repos: Record<string, string>;
    // Merge method for "Approve and close" on a pull request.
    mergeMethod: "merge" | "squash" | "rebase";
  };
  slack: {
    enabled: boolean;
    // token: the Web API with a user token. claude-mcp: Claude with a Slack
    // MCP (e.g. the claude.ai Slack connector), for when there is no token.
    // mcp: aug as a direct MCP client (reserved, not built).
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
  };
  brain: {
    triageModel: string;
    agentModel: string;
    assistantModel: string;
    // Reads and sends Slack under transport claude-mcp.
    slackModel: string;
  };
  // How many agents may be working at once, chat and coding alike. Past it,
  // chat turns aug starts by itself and your coding Starts wait their turn;
  // a chat turn you ask for never waits.
  maxActiveAgents: number;
  // Makes a task's worktree. {repo_path}, {create} (-c or empty) and
  // {branch} are filled in; stdout is wt's JSON, or a path on the last line.
  worktreeCommand: string;
  // A private tmux server (-L); unset means your default server.
  tmuxSocket?: string;
  // Start a general agent on a fresh general or reply task by itself.
  autostart: boolean;
  learning: boolean;
  // Characters a brain doc may take in a prompt, by file name ("JOB.md"),
  // overriding docs.ts's DOC_BUDGET.
  docBudgets?: Record<string, number>;
  theme: "default" | "terminal" | "mono" | "tokyo-night";
  // Where a coding task with no mapped checkout works.
  scratchRepo?: string;
  // Opens a link or a file an agent made: a command, or argv; the target is
  // appended. Default: open (macOS), wslview (WSL), xdg-open (Linux).
  opener?: string | string[];
  // The file log (core/log.ts). Off by default; AUG_DEV=1 or AUG_LOG turn it
  // on without touching config.
  log: {
    enabled: boolean;
    level: "trace" | "debug" | "info" | "warn" | "error";
    // Default: aug.log under AUG_HOME.
    file?: string;
    // Rolls over to <file>.1 past this; default 10 MB.
    maxBytes?: number;
  };
  // Connector tools agents may call, by capability (core/capabilities.ts).
  // Opt-in: nothing is granted until a role lists a capability.
  capabilities: {
    // capability -> MCP server segment, overriding the built-in one.
    servers: Record<string, string>;
    // capability -> bare tool names, overriding the built-in list.
    tools: Record<string, string[]>;
    // capability -> a Claude Code plugin ("name@marketplace", a bare name, or
    // an absolute folder), loaded into headless calls with --plugin-dir.
    plugins: Record<string, string>;
    // capability -> commands allowed on Bash ("plannotator annotate").
    commands: Record<string, string[]>;
    grants: { general?: string[]; assistant?: string[] };
  };
}

export const DEFAULT_CONFIG: AugConfig = {
  github: { enabled: true, pollSeconds: 120, repos: {}, mergeMethod: "squash" },
  slack: { enabled: true, transport: "token", pollSeconds: 60, channels: [] },
  brain: {
    triageModel: "haiku",
    agentModel: "sonnet",
    assistantModel: "sonnet",
    slackModel: "haiku",
  },
  maxActiveAgents: 4,
  worktreeCommand:
    "wt -C {repo_path} switch {create} {branch} --no-cd --format json -y",
  autostart: true,
  learning: true,
  theme: "default",
  log: { enabled: false, level: "info" },
  capabilities: {
    servers: {},
    tools: {},
    plugins: {},
    commands: {},
    grants: {},
  },
};

let cached: AugConfig | undefined;

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K];
};

// Keys renamed since they first shipped, still read from an old file.
interface LegacyKeys {
  agentsAtOnce?: number;
}

// Under claude-mcp every poll is a model turn, so it polls less often unless
// told otherwise.
const CLAUDE_MCP_POLL_SECONDS = 180;

export function mergeConfig(
  raw: DeepPartial<AugConfig> & LegacyKeys,
): AugConfig {
  const { agentsAtOnce, ...rest } = raw;
  const slackPoll =
    raw.slack?.pollSeconds ??
    (raw.slack?.transport === "claude-mcp"
      ? CLAUDE_MCP_POLL_SECONDS
      : DEFAULT_CONFIG.slack.pollSeconds);
  return {
    ...DEFAULT_CONFIG,
    ...rest,
    maxActiveAgents:
      raw.maxActiveAgents ?? agentsAtOnce ?? DEFAULT_CONFIG.maxActiveAgents,
    github: { ...DEFAULT_CONFIG.github, ...raw.github },
    slack: { ...DEFAULT_CONFIG.slack, ...raw.slack, pollSeconds: slackPoll },
    brain: { ...DEFAULT_CONFIG.brain, ...raw.brain },
    log: { ...DEFAULT_CONFIG.log, ...raw.log },
    capabilities: {
      servers: { ...raw.capabilities?.servers },
      tools: { ...raw.capabilities?.tools },
      plugins: { ...raw.capabilities?.plugins },
      commands: { ...raw.capabilities?.commands },
      grants: { ...raw.capabilities?.grants },
    },
  } as AugConfig;
}

export function loadConfig(): AugConfig {
  if (cached) return cached;
  const file = paths.config();
  let raw: DeepPartial<AugConfig> = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as DeepPartial<AugConfig>;
    } catch {
      raw = {};
    }
  }
  cached = mergeConfig(raw);
  return cached;
}

export function saveConfig(next: AugConfig): void {
  ensureHome();
  writeFileSync(paths.config(), JSON.stringify(next, null, 2) + "\n");
  cached = next;
}

export function slackToken(config = loadConfig()): string | undefined {
  return process.env.SLACK_TOKEN ?? config.slack.token;
}

export function setConfigForTest(config: AugConfig): void {
  cached = config;
}
