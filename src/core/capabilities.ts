// Capabilities: names aug owns ("slack.read"), mapped to the concrete MCP tool
// names claude is allowed to call. Agents and the Home assistant are granted
// capabilities in ~/.aug/config.json; this is the one place that knows what a
// capability means for a given connector.
//
// Fail closed: only tools named by a capability are ever allowed, and any name
// that looks like a write is dropped even if a config override lists it.
// Sessions run with --permission-mode dontAsk, so anything not allowed here is
// simply denied.
//
// A capability can also be a Claude Code plugin or a command, defined only in
// config. Headless calls skip user settings, so an enabled plugin is not there
// unless it is loaded with --plugin-dir. Its skills then run without a rule,
// and once the model invokes one, that skill's allowed-tools join the
// session's allow list. So a plugin loads only when every rule its skills
// declare is one the role already has or a command the same capability grants
// (pluginWidens). Coding agents are interactive and load the user's settings,
// so they have every enabled plugin already.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
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

// The calls the last agent turn was denied.
export function lastDenials(turns: TurnRow[]): string[] {
  const last = turns.findLast((t) => t.role === TurnRole.agent);
  const steps: unknown = last?.steps ? JSON.parse(last.steps) : [];
  return Array.isArray(steps)
    ? steps.filter((s): s is string => typeof s === "string" && s.startsWith(DENIED_STEP))
    : [];
}

// The next turn names the denied calls and how to write them instead.
export function deniedNote(turns: TurnRow[]): string {
  const denied = lastDenials(turns);
  if (!denied.length) return "";
  return [
    "Your last turn was denied these calls, because they did not match an allowed command:",
    ...denied.map((s) => `- ${s.slice(DENIED_STEP.length)}`),
    `Do not repeat them. ${SHELL_HOWTO}`,
  ].join("\n");
}

export type Role = "general" | "assistant";

// MCP tool rules a capability grants.
export function resolveCapability(
  name: string,
  config: AugConfig["capabilities"],
): string[] {
  const base = CAPABILITIES[name];
  const server = config.servers[name] ?? base?.server;
  const tools = config.tools[name] ?? base?.tools;
  if (!server || !tools) {
    if (!config.plugins[name] && !config.commands[name])
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

// A command's words, so a rule is a plain prefix: no globs, quotes or shell.
const COMMAND = /^[A-Za-z0-9._-]+( [A-Za-z0-9._-]+)*$/;

// Commands that run whatever follows them, which would make the rule allow
// anything at all.
const WRAPPERS = new Set([
  "sh",
  "bash",
  "zsh",
  "fish",
  "env",
  "sudo",
  "xargs",
  "eval",
  "exec",
  "nohup",
  "nice",
  "timeout",
  "command",
]);

// Commands a capability allows on Bash. Not checked against WRITE_VERB: the
// owner names a whole program, and a program's name says nothing of what it
// writes.
export function resolveCommands(
  name: string,
  config: AugConfig["capabilities"],
): string[] {
  const allowed: string[] = [];
  for (const command of config.commands[name] ?? []) {
    const first = command.split(" ")[0] ?? "";
    if (!COMMAND.test(command) || WRAPPERS.has(first)) {
      log.warn("bad command dropped from capability", {
        capability: name,
        command,
      });
      continue;
    }
    allowed.push(command);
  }
  return allowed;
}

const PLUGIN = /^[A-Za-z0-9._-]+(@[A-Za-z0-9._-]+)?$/;

interface InstalledPlugins {
  plugins?: Record<string, { installPath?: string }[]>;
}

function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

// Where an installed plugin lives, by "name@marketplace" or bare name, or a
// folder named outright.
export function pluginDir(ref: string): string | undefined {
  if (isAbsolute(ref)) return existsSync(ref) ? ref : undefined;
  if (!PLUGIN.test(ref)) return undefined;
  let installed: InstalledPlugins;
  try {
    const file = join(claudeDir(), "plugins", "installed_plugins.json");
    installed = JSON.parse(readFileSync(file, "utf8")) as InstalledPlugins;
  } catch {
    return undefined;
  }
  const entries = Object.entries(installed.plugins ?? {}).find(
    ([key]) => key === ref || key.split("@")[0] === ref,
  )?.[1];
  return entries?.find((e) => e.installPath && existsSync(e.installPath))
    ?.installPath;
}

// Split at commas and spaces outside parentheses: "Bash(git add:*), Read".
function splitRules(text: string): string[] {
  const rules: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "," || ch === " ")) {
      if (current) rules.push(current);
      current = "";
    } else current += ch;
  }
  if (current) rules.push(current);
  return rules.map((r) => r.replace(/^["']|["']$/g, "")).filter(Boolean);
}

// The allowed-tools a skill or command declares, or null when the model can
// never invoke it.
export function declaredRules(markdown: string): string[] | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown);
  if (!match) return [];
  const lines = match[1]!.split(/\r?\n/);
  if (lines.some((l) => /^disable-model-invocation:\s*true\s*$/.test(l)))
    return null;
  const at = lines.findIndex((l) => l.startsWith("allowed-tools:"));
  if (at < 0) return [];
  const value = lines[at]!.slice("allowed-tools:".length).trim();
  if (value) return splitRules(value.replace(/^\[|\]$/g, ""));
  const items: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const item = /^\s*-\s*(.+)$/.exec(line);
    if (!item) break;
    items.push(...splitRules(item[1]!));
  }
  return items;
}

function markdownUnder(path: string): string[] {
  try {
    if (statSync(path).isFile()) return path.endsWith(".md") ? [path] : [];
    return readdirSync(path, { recursive: true })
      .map((f) => join(path, String(f)))
      .filter((f) => f.endsWith(".md") && statSync(f).isFile());
  } catch {
    return [];
  }
}

interface PluginManifest {
  skills?: string | string[];
  commands?: string | string[];
}

// The skill and command files a plugin brings: the default folders plus any
// its manifest names.
export function pluginSkillFiles(dir: string): string[] {
  let manifest: PluginManifest = {};
  try {
    const file = join(dir, ".claude-plugin", "plugin.json");
    manifest = JSON.parse(readFileSync(file, "utf8")) as PluginManifest;
  } catch {}
  const paths = [
    "skills",
    "commands",
    ...[manifest.skills ?? [], manifest.commands ?? []].flat(),
  ];
  return [...new Set(paths.flatMap((p) => markdownUnder(join(dir, p))))];
}

// Reads every role already has unscoped, so a skill naming them adds nothing.
const ROLE_READS = new Set(["Read", "Grep", "Glob", "WebSearch", "WebFetch"]);

// Rules a plugin's skills would add that the capability did not grant.
export function pluginWidens(dir: string, commands: string[]): string[] {
  const granted = new Set([
    ...ROLE_READS,
    ...commands.map((c) => `Bash(${c}:*)`),
  ]);
  const extra = new Set<string>();
  for (const file of pluginSkillFiles(dir)) {
    const rules = declaredRules(readFileSync(file, "utf8"));
    for (const rule of rules ?? []) if (!granted.has(rule)) extra.add(rule);
  }
  return [...extra];
}

export function resolvePlugin(
  name: string,
  config: AugConfig["capabilities"],
): string | undefined {
  const ref = config.plugins[name];
  if (!ref) return undefined;
  const dir = pluginDir(ref);
  if (!dir) {
    log.warn("plugin not installed, nothing loaded", {
      capability: name,
      plugin: ref,
    });
    return undefined;
  }
  const widens = pluginWidens(dir, resolveCommands(name, config));
  if (widens.length) {
    log.warn("plugin skills ask for more than granted, nothing loaded", {
      capability: name,
      plugin: ref,
      widens,
    });
    return undefined;
  }
  return dir;
}

export interface Grant {
  // Extra --allowedTools rules.
  allow: string[];
  // Built-in tools those rules need, added to the call's --tools.
  tools: string[];
  pluginDirs: string[];
  // Granted commands, named in the prompt so the model knows to use them.
  commands: string[];
}

export function capabilityGrant(
  role: Role,
  config: AugConfig = loadConfig(),
): Grant {
  const caps = config.capabilities;
  const granted = config.capabilities.grants[role] ?? [];
  const commands = [
    ...new Set(granted.flatMap((c) => resolveCommands(c, caps))),
  ];
  const pluginDirs = [
    ...new Set(
      granted.flatMap((c) => {
        const dir = resolvePlugin(c, caps);
        return dir ? [dir] : [];
      }),
    ),
  ];
  const tools = pluginDirs.length ? ["Skill"] : [];
  return {
    allow: [
      ...new Set([
        ...granted.flatMap((c) => resolveCapability(c, caps)),
        ...commands.map((c) => `Bash(${c}:*)`),
        ...tools,
      ]),
    ],
    tools,
    pluginDirs,
    commands,
  };
}

// Extra --allowedTools entries a role gets from its granted capabilities.
export function capabilityAllow(
  role: Role,
  config: AugConfig = loadConfig(),
): string[] {
  return capabilityGrant(role, config).allow;
}

// One prompt line naming the commands a role was granted.
export function grantedNote(
  role: Role,
  config: AugConfig = loadConfig(),
): string {
  const { commands } = capabilityGrant(role, config);
  return commands.length
    ? `The owner also granted these commands on Bash: ${commands.join(", ")}.`
    : "";
}
