// ~/.riker/config.json. Every key is optional; a missing file means defaults,
// which is enough to run with `gh` logged in and SLACK_TOKEN set.
//
// Core's own keys are RikerConfig's. A plugin's (github, slack, remote) are
// its ConfigSection: core keeps what the file holds under that key as it was
// written and never looks inside; the plugin reads it through its section,
// which lays its defaults under it.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { paths } from "./paths";
import type { ActionConfig } from "./task-actions";

// A message triage files as FYI without asking a model. Every field set must
// match; author, title and body are case-insensitive regexes.
export interface NoiseRule {
  // What the owner reads as the reason it was filed.
  reason: string;
  author?: string;
  title?: string;
  body?: string;
  // A message's channel, as its plugin names it ("github", "slack").
  channel?: string;
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

// Config's keys: the navigation keys, and the chord back to the rail.
export interface KeysConfig extends NavKeys {
  // Two letters typed within railChordMs of each other in the chat box or an
  // attached agent go back to the rail, like vim's jk. Default ["jk", "kj"]
  // and 180ms; [] turns it off. Read each time, so an edit needs no restart.
  railChord?: string[];
  railChordMs?: number;
}

export interface RikerConfig {
  // owner/repo -> local checkout, where a coding agent works (core/repos.ts).
  // Read from github.repos in a file written before it moved here.
  repos: Record<string, string>;
  brain: {
    triageModel: string;
    agentModel: string;
    assistantModel: string;
    // A Home turn that is one short move or lookup (core/home-model.ts) runs
    // on this one instead, when set; empty is off.
    assistantSimpleModel?: string;
    // A project's manager (core/manager.ts); unset or empty is
    // assistantModel.
    projectManagerModel?: string;
  };
  // How many agents may be working at once, chat and coding alike. Past it,
  // chat turns Riker starts by itself and your coding Starts wait their turn;
  // a chat turn you ask for never waits.
  maxActiveAgents: number;
  // What Riker's own model calls may cost (core/spend.ts). Once today's spend
  // reaches dailyUsd, chat turns Riker starts by itself wait (with the reason
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
    // GitHub teams whose review asks are yours, as org/team-slug (or a bare
    // slug for any org). A PR that requests a review of one of them or of
    // you, or tags one of them or you, always becomes a review task
    // (@riker/triage). Read from github.reviewTeams in an older file.
    reviewTeams: string[];
  };
  theme: "default" | "terminal" | "mono" | "tokyo-night";
  // Whether the terminal's font is a Nerd Font, for marks like merged's
  // git-merge glyph. Unset: guessed from the fonts installed (core/glyphs.ts).
  nerdFont?: boolean;
  // false draws a connection that is still connecting (and an agent at
  // work) with a still mark instead of an animation; so does RIKER_MOTION=0
  // (core/link-state.ts).
  motion?: boolean;
  // false leaves the mouse to the terminal (a plain drag selects there
  // again): no clicks, wheel or drag-to-copy in Riker. Read at start.
  mouse?: boolean;
  // The TUI's navigation keys, in opentui's spelling ("alt+g", "shift+h").
  // Read at start: a change needs a restart (but the rail chord).
  keys?: KeysConfig;
  // Where a coding task with no mapped checkout works.
  scratchRepo?: string;
  // Folders searched for checkouts to offer (repos.ts); default ~/workspace,
  // ~/src, ~/code, ~/projects, ~/dev, ~/git. The first is where Clone puts one.
  repoRoots?: string[];
  // Opens a link or a file an agent made: a command, or argv; the target is
  // appended. Default: open (macOS), wslview (WSL), xdg-open (Linux).
  opener?: string | string[];
  // The file log (core/log.ts). Off by default; RIKER_DEV=1 or RIKER_LOG turn it
  // on without touching config.
  log: {
    enabled: boolean;
    level: "trace" | "debug" | "info" | "warn" | "error";
    // Default: riker.log under RIKER_HOME.
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
  // Task actions by name (core/task-actions.ts): a built-in changed field by
  // field, turned off with false, or a new one registered.
  actions?: Record<string, ActionConfig>;
  // Session digests (docs/session-digests-design.md): the defaults only. A
  // project or task turns its own on or off on its row (core/digests.ts).
  journal: { enabled: boolean };
  story: { enabled: boolean };
  digests: { watcherModel: string };
  // A plugin's section, by its key (ConfigSection): kept as written.
  [section: string]: unknown;
}

export const DEFAULT_CONFIG: RikerConfig = {
  repos: {},
  brain: {
    triageModel: "haiku",
    agentModel: "sonnet",
    assistantModel: "sonnet",
    assistantSimpleModel: "haiku",
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
    reviewTeams: [],
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
  journal: { enabled: false },
  story: { enabled: false },
  digests: { watcherModel: "haiku" },
};

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K];
};

// Keys renamed or moved since they first shipped, still read from an old
// file. github.repos and github.reviewTeams were core's and triage's inside
// GitHub's section; they move out of it on the first read, so a write
// leaves only the new key.
interface LegacyKeys {
  agentsAtOnce?: number;
  github?: { repos?: Record<string, string>; reviewTeams?: string[] } & Record<
    string,
    unknown
  >;
}

export function mergeConfig(
  raw: DeepPartial<RikerConfig> & LegacyKeys,
): RikerConfig {
  const { agentsAtOnce, github, ...rest } = raw;
  const {
    repos: oldRepos,
    reviewTeams: oldTeams,
    ...githubRest
  } = github ?? {};
  return {
    ...DEFAULT_CONFIG,
    ...rest,
    ...(github ? { github: githubRest } : {}),
    maxActiveAgents:
      raw.maxActiveAgents ?? agentsAtOnce ?? DEFAULT_CONFIG.maxActiveAgents,
    repos: { ...oldRepos, ...raw.repos },
    brain: { ...DEFAULT_CONFIG.brain, ...raw.brain },
    spend: { ...DEFAULT_CONFIG.spend, ...raw.spend },
    chat: { ...DEFAULT_CONFIG.chat, ...raw.chat },
    triage: {
      ...DEFAULT_CONFIG.triage,
      ...raw.triage,
      escalate: { ...DEFAULT_CONFIG.triage.escalate, ...raw.triage?.escalate },
      reviewTeams:
        raw.triage?.reviewTeams ??
        oldTeams ??
        DEFAULT_CONFIG.triage.reviewTeams,
    },
    log: { ...DEFAULT_CONFIG.log, ...raw.log },
    capabilities: {
      servers: { ...raw.capabilities?.servers },
      tools: { ...raw.capabilities?.tools },
      plugins: { ...raw.capabilities?.plugins },
      commands: { ...raw.capabilities?.commands },
      grants: { ...raw.capabilities?.grants },
    },
    actions: { ...raw.actions },
    journal: { ...DEFAULT_CONFIG.journal, ...raw.journal },
    story: { ...DEFAULT_CONFIG.story, ...raw.story },
    digests: { ...DEFAULT_CONFIG.digests, ...raw.digests },
  } as RikerConfig;
}

// ── a plugin's section ──────────────────────────────────────────────────

// A plugin's part of config.json, under its own key: its defaults, and how
// what the file holds is laid over them. `of` reads it from a config value,
// whole (once per value); `config` lets a default follow another key (the
// remote polls less often under Slack's claude-mcp transport).
export interface ConfigSection<T> {
  key: string;
  defaults: T;
  of(config: RikerConfig): T;
}

// Core's own keys, which no section may take.
export const CORE_KEYS: ReadonlySet<string> = new Set([
  ...Object.keys(DEFAULT_CONFIG),
  "tmuxSocket",
  "docBudgets",
  "nerdFont",
  "motion",
  "mouse",
  "keys",
  "scratchRepo",
  "repoRoots",
  "opener",
  "actions",
]);

export function configSection<T extends object>(
  key: string,
  defaults: T,
  merge: (written: Partial<T>, config: RikerConfig) => T = (written) => ({
    ...defaults,
    ...written,
  }),
): ConfigSection<T> {
  const read = new WeakMap<RikerConfig, T>();
  return {
    key,
    defaults,
    of(config) {
      const known = read.get(config);
      if (known) {
        return known;
      }
      const written = config[key];
      const whole = merge(
        written && typeof written === "object" ? (written as Partial<T>) : {},
        config,
      );
      read.set(config, whole);
      return whole;
    },
  };
}

function mtimeOf(file: string): number | null {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function readFile(file: string): RikerConfig {
  let raw: DeepPartial<RikerConfig> = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as DeepPartial<RikerConfig>;
    } catch {
      raw = {};
    }
  }
  return mergeConfig(raw);
}

// One read of config.json, for an entry point that needs a setting before
// it has a source to hand around (the theme, the log, the tmux server).
export function loadConfig(file = paths.config()): RikerConfig {
  return readFile(file);
}

// What the engine, the desk and the drivers are handed instead of reaching
// for a global: the config as it is now, and the one way to change it. A
// long-lived holder keeps the source and asks get() when it needs a setting,
// so an edit (yours, a learned noise rule, a repo mapped mid-start) is seen
// on the next use without a restart. Functions that run once take the
// RikerConfig value get() returned.
export interface ConfigSource {
  get(): RikerConfig;
  update(change: (config: RikerConfig) => RikerConfig): RikerConfig;
}

// ~/.riker/config.json, re-read when its mtime changes.
export function fileConfig(file = paths.config()): ConfigSource {
  let cached: RikerConfig | undefined;
  let cachedMtime: number | null = null;
  const get = (): RikerConfig => {
    const mtime = mtimeOf(file);
    if (cached && mtime === cachedMtime) {
      return cached;
    }
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
export function fixedConfig(
  initial: RikerConfig = DEFAULT_CONFIG,
): ConfigSource {
  let current = initial;
  return {
    get: () => current,
    update(change) {
      current = change(current);
      return current;
    },
  };
}
