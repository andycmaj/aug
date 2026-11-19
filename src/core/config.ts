// ~/.aug/config.json. Every key is optional; a missing file means defaults,
// which is enough to run with `gh` logged in and SLACK_TOKEN set.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { paths } from "./paths";

// A message triage files as FYI without asking a model. Every field set must
// match; author, title and body are case-insensitive regexes.
export interface NoiseRule {
  // What the owner reads as the reason it was filed.
  reason: string;
  author?: string;
  title?: string;
  body?: string;
  channel?: "github" | "slack";
  // GitHub's notification reason: ci_activity, subscribed, ...
  githubReason?: string[];
}

export interface EscalateRules {
  // GitHub notification reasons (assign, mention, review_requested, ...).
  // A review requested only of a team, or a team's @org/team tag, counts
  // only for a team in github.reviewTeams.
  github: string[];
  // Slack: a direct message, a message that mentions you.
  slack: ("dm" | "mention")[];
}

export interface NavKeys {
  // Go to anything (search the rail) from anywhere, an agent's terminal too.
  // Default ctrl+\ (written "ctrl+\\" in JSON), beside ctrl+] (detach).
  goTo?: string;
  // Back and forward through the places you have been. Default [ and ].
  back?: string;
  forward?: string;
}

export interface AugConfig {
  github: {
    enabled: boolean;
    pollSeconds: number;
    // owner/repo -> local checkout, where a coding agent works.
    repos: Record<string, string>;
    // Merge method for "Approve and close" on a pull request.
    mergeMethod: "merge" | "squash" | "rebase";
    // GitHub teams whose review asks are yours, as org/team-slug (or a bare
    // slug for any org). A PR that requests a review of one of them or of
    // you, or tags one of them or you, always becomes a review task
    // (core/triage.ts).
    reviewTeams: string[];
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
  // Talking to the Assistant from Slack (core/slack/remote.ts): your
  // messages in one conversation that only you are in reach Home, and its
  // answers come back in the thread. Separate from slack.enabled (the
  // inbound triage poller) and off until turned on. It reads and posts the
  // way slack.transport says.
  remote: {
    enabled: boolean;
    // Your self-DM (D...) or a private channel with only you in it. The
    // token transport finds your self-DM when unset; claude-mcp needs it.
    channel?: string;
    // Default 15 with a token, 60 under claude-mcp (each read is a turn).
    pollSeconds: number;
    // Posts to the same conversation when a task's agent finished (coding
    // work, or work it closed) or is waiting for you. None by default.
    notify: ("finished" | "waiting")[];
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
  // What aug's own model calls may cost (core/spend.ts). Once today's spend
  // reaches dailyUsd, chat turns aug starts by itself wait (with the reason
  // on the task) and the Advisor skips its run; turns you start or type to
  // still run. Coding agents in tmux are not counted.
  spend: {
    capEnabled: boolean;
    dailyUsd: number;
  };
  // When a chat turn leaves its session for a new one (core/agents.ts
  // chatSession). The prompt cache lives an hour: resuming a session idle
  // past that re-writes its whole context at the cache-write price, so a
  // new one that reads the conversation back is cheaper. Home's context
  // grows with every turn, so past homeMaxTokens it starts over too. 0 turns
  // either off.
  chat: {
    idleMinutes: number;
    homeMaxTokens: number;
  };
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
  triage: {
    // Replaces the defaults when set; the noise move appends to it.
    noise: NoiseRule[];
    // What may make a task without you: anything else the model calls work
    // waits in the Inbox under "needs you", and m makes it a task.
    escalate: EscalateRules;
  };
  theme: "default" | "terminal" | "mono" | "tokyo-night";
  // Whether the terminal's font is a Nerd Font, for marks like merged's
  // git-merge glyph. Unset: guessed from the fonts installed (core/glyphs.ts).
  nerdFont?: boolean;
  // The TUI's navigation keys, in opentui's spelling ("alt+g", "shift+h").
  // Read at start: a change needs a restart.
  keys?: NavKeys;
  // Where a coding task with no mapped checkout works.
  scratchRepo?: string;
  // Folders searched for checkouts to offer (repos.ts); default ~/workspace,
  // ~/src, ~/code, ~/projects, ~/dev, ~/git. The first is where Clone puts one.
  repoRoots?: string[];
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
    // Perf counters (core/perf.ts, perf.db) ride on the log: on whenever it
    // is, unless this is false.
    perf?: boolean;
    // A timing at or past this many ms keeps an example; default 50.
    slowMs?: number;
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
  github: { enabled: true, pollSeconds: 120, repos: {}, mergeMethod: "squash", reviewTeams: [] },
  slack: { enabled: true, transport: "token", pollSeconds: 60, channels: [] },
  remote: { enabled: false, pollSeconds: 15, notify: [] },
  brain: {
    triageModel: "haiku",
    agentModel: "sonnet",
    assistantModel: "sonnet",
    slackModel: "haiku",
  },
  maxActiveAgents: 4,
  spend: { capEnabled: true, dailyUsd: 25 },
  chat: { idleMinutes: 55, homeMaxTokens: 60_000 },
  worktreeCommand:
    "wt -C {repo_path} switch {create} {branch} --no-cd --format json -y",
  autostart: true,
  learning: true,
  triage: {
    noise: [
      {
        author: "\\[bot\\]$|^dependabot|^github-actions",
        reason: "a bot wrote it",
      },
      { githubReason: ["ci_activity"], reason: "CI activity" },
      {
        githubReason: ["state_change", "subscribed"],
        reason: "a state change on a thread you only follow",
      },
    ],
    escalate: {
      github: ["assign", "mention", "review_requested"],
      slack: ["dm", "mention"],
    },
  },
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
const CLAUDE_MCP_REMOTE_SECONDS = 60;

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
    remote: {
      ...DEFAULT_CONFIG.remote,
      ...raw.remote,
      pollSeconds:
        raw.remote?.pollSeconds ??
        (raw.slack?.transport === "claude-mcp"
          ? CLAUDE_MCP_REMOTE_SECONDS
          : DEFAULT_CONFIG.remote.pollSeconds),
    },
    brain: { ...DEFAULT_CONFIG.brain, ...raw.brain },
    spend: { ...DEFAULT_CONFIG.spend, ...raw.spend },
    chat: { ...DEFAULT_CONFIG.chat, ...raw.chat },
    triage: {
      ...DEFAULT_CONFIG.triage,
      ...raw.triage,
      escalate: { ...DEFAULT_CONFIG.triage.escalate, ...raw.triage?.escalate },
    },
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

function mtimeOf(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function readFile(file: string): AugConfig {
  let raw: DeepPartial<AugConfig> = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as DeepPartial<AugConfig>;
    } catch {
      raw = {};
    }
  }
  return mergeConfig(raw);
}

// One read of config.json, for an entry point that needs a setting before
// it has a source to hand around (the theme, the log, the tmux server).
export function loadConfig(file = paths.config()): AugConfig {
  return readFile(file);
}

// What the engine, the desk and the drivers are handed instead of reaching
// for a global: the config as it is now, and the one way to change it. A
// long-lived holder keeps the source and asks get() when it needs a setting,
// so an edit (yours, a learned noise rule, a repo mapped mid-start) is seen
// on the next use without a restart. Functions that run once take the
// AugConfig value get() returned.
export interface ConfigSource {
  get(): AugConfig;
  update(change: (config: AugConfig) => AugConfig): AugConfig;
}

// ~/.aug/config.json, re-read when its mtime changes.
export function fileConfig(file = paths.config()): ConfigSource {
  let cached: AugConfig | undefined;
  let cachedMtime: number | null = null;
  const get = (): AugConfig => {
    const mtime = mtimeOf(file);
    if (cached && mtime === cachedMtime) return cached;
    cached = readFile(file);
    cachedMtime = mtime;
    return cached;
  };
  return {
    get,
    update(change) {
      const next = change(get());
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
      cached = next;
      cachedMtime = mtimeOf(file);
      return next;
    },
  };
}

// In memory, never the file: tests and the fixture day.
export function fixedConfig(initial: AugConfig = DEFAULT_CONFIG): ConfigSource {
  let current = initial;
  return {
    get: () => current,
    update(change) {
      current = change(current);
      return current;
    },
  };
}

export function slackToken(config: AugConfig): string | undefined {
  return process.env.SLACK_TOKEN ?? config.slack.token;
}
