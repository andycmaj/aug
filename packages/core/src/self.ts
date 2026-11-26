// How an agent (or a Claude Code hook it fires) calls back into Riker. The tools
// entry is plain TypeScript, so it runs under bare `bun` without the Solid
// preload the TUI needs.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { ENTRYPOINT, envVar, LEGACY, TOOLS_NAME } from "./brand";
import { rikerHome } from "./paths";

// A compiled binary (`bun run compile`) has no script on disk to hand bun; it
// is riker-tools itself under the `tools` subcommand (@riker/cli's riker.ts).
const COMPILED = import.meta.url.includes("/$bunfs/");
export const TOOLS_SUBCOMMAND = "tools";
// The fixture day's stand-in coding agent (@riker/fixtures fake-claude.ts).
export const DEMO_AGENT_SUBCOMMAND = "demo-agent";

// How Riker runs one of its own scripts as a process: bun on the file from
// source. A compiled binary's files live in its own $bunfs, which no other
// process can open, so there it is the binary itself under the subcommand its
// entry routes to that script.
export function scriptArgv(script: string, subcommand: string): string[] {
  return COMPILED ? [process.execPath, subcommand] : [process.execPath, script];
}

// riker-tools lives in @riker/cli, which depends on core: the entry point that
// starts Riker (or riker-tools itself) says where it is.
let entry: string | null = null;

export function setToolsEntry(path: string): void {
  entry = path;
}

export function toolsEntry(): string {
  if (!entry) {
    throw new Error(
      "riker-tools entry not set: the entry point calls setToolsEntry",
    );
  }
  return entry;
}

// Riker run from source in a linked git worktree would name that worktree's
// riker-tools in every brief and hook, and a worktree is removed when its task
// ends: the agents still running then fail with "Module not found". The same
// file in the repo's main checkout outlives it, so that is the path handed
// out when it exists. RIKER_TOOLS_ENTRY names one outright (a branch whose
// agents need its own riker-tools).
export function lastingEntry(path: string): string {
  const pinned = envVar("TOOLS_ENTRY");
  if (pinned) {
    return resolve(pinned);
  }
  const main = inMainCheckout(path);
  return main && existsSync(main) ? main : path;
}

// The path in the main checkout of a file in a linked worktree; null when it
// is in no worktree, already in the main checkout, or the repo is bare.
function inMainCheckout(path: string): string | null {
  for (let dir = dirname(path); ; dir = dirname(dir)) {
    const dotGit = join(dir, ".git");
    const text = readText(dotGit);
    if (text === undefined) {
      if (dirname(dir) === dir) {
        return null;
      }
      continue;
    }
    // A directory: this is the main checkout.
    if (text === null) {
      return null;
    }
    const gitdir = /^gitdir:\s*(.+)$/m.exec(text)?.[1]?.trim();
    if (!gitdir) {
      return null;
    }
    const worktreeGit = isAbsolute(gitdir) ? gitdir : resolve(dir, gitdir);
    const common = readText(join(worktreeGit, "commondir"))?.trim();
    if (!common) {
      return null;
    }
    const commonDir = resolve(worktreeGit, common);
    if (basename(commonDir) !== ".git") {
      return null;
    }
    return join(dirname(commonDir), relative(dir, path));
  }
}

// undefined when nothing is there, null for a directory.
function readText(file: string): string | null | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EISDIR" ? null : undefined;
  }
}

// The riker-tools script briefs and hooks name, when it is no longer there
// (Riker run from a checkout since removed): a start says so rather than
// handing an agent a command that fails where the owner cannot see it.
export function toolsMissing(): string | null {
  return COMPILED || existsSync(toolsEntry()) ? null : toolsEntry();
}

export function toolsArgv(): string[] {
  return COMPILED
    ? [process.execPath, TOOLS_SUBCOMMAND]
    : [process.execPath, toolsEntry()];
}

// Quoted for a shell line (hook commands and the agent's brief are shell).
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

export function toolsCommand(...args: string[]): string {
  return [...toolsArgv(), ...args].map(shellQuote).join(" ");
}

// What a headless agent is told to type. Handed the long bun and script paths,
// models abbreviate them (`B=...; T=...; $B $T move ...`), which no allow rule
// can match; a short name on PATH leaves nothing to abbreviate.
export { TOOLS_NAME };

// aug-tools beside it, until the compat window closes: agents started before
// the rename are allowed `aug-tools ...` and find it on this PATH.
export function toolsBin(): string {
  const dir = join(rikerHome(), "bin");
  const script = `#!/bin/sh\nexec ${toolsArgv().map(shellQuote).join(" ")} "$@"\n`;
  for (const name of [TOOLS_NAME, LEGACY.toolsName]) {
    const file = join(dir, name);
    if (existsSync(file) && readFileSync(file, "utf8") === script) {
      continue;
    }
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, script);
    chmodSync(file, 0o755);
  }
  return dir;
}

export function toolsEnv(): Record<string, string> {
  return { PATH: `${toolsBin()}:${process.env.PATH ?? ""}` };
}

// Bash allow rules for a riker-tools command: the short name, and the full
// paths spelled either way in case a model writes them out anyway.
export function toolsRules(...args: string[]): string[] {
  const tail = args.map(shellQuote).join(" ");
  const entry = [toolsEntry(), ...args].map(shellQuote).join(" ");
  return [
    ...new Set([
      `${TOOLS_NAME}${tail ? ` ${tail}` : ""}`,
      toolsCommand(...args),
      ...(COMPILED ? [] : [`bun ${entry}`]),
    ]),
  ].map((c) => `Bash(${c}:*)`);
}

// The environment for a claude Riker runs itself. TMUX_PANE goes: Riker may run
// in a pane of a task's window, and a claude that loads user settings would
// have its hooks adopt it into that task (and riker-tools would take the pane's
// task for its own).
export function claudeEnv(
  extra: Record<string, string> = {},
): Record<string, string | undefined> {
  // The Slack token stays with Riker: an agent's shell never sees it.
  const { TMUX_PANE: _, SLACK_TOKEN: _token, ...env } = process.env;
  return { ...env, ...extra, CLAUDE_CODE_ENTRYPOINT: ENTRYPOINT };
}
