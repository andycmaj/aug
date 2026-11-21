// How an agent (or a Claude Code hook it fires) calls back into Riker. The tools
// entry is plain TypeScript, so it runs under bare `bun` without the Solid
// preload the TUI needs.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENTRYPOINT, LEGACY, TOOLS_NAME } from "./brand";
import { rikerHome } from "./paths";

// A compiled binary (`bun run compile`) has no script on disk to hand bun; it
// is riker-tools itself under the `tools` subcommand (@riker/cli's riker.ts).
const COMPILED = import.meta.url.includes("/$bunfs/");
export const TOOLS_SUBCOMMAND = "tools";

// riker-tools lives in @riker/cli, which depends on core: the entry point that
// starts Riker (or riker-tools itself) says where it is.
let entry: string | null = null;

export function setToolsEntry(path: string): void {
  entry = path;
}

export function toolsEntry(): string {
  if (!entry) throw new Error("riker-tools entry not set: the entry point calls setToolsEntry");
  return entry;
}

export function toolsArgv(): string[] {
  return COMPILED ? [process.execPath, TOOLS_SUBCOMMAND] : [process.execPath, toolsEntry()];
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
    if (existsSync(file) && readFileSync(file, "utf8") === script) continue;
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
export function claudeEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  // The Slack token stays with Riker: an agent's shell never sees it.
  const { TMUX_PANE: _, SLACK_TOKEN: _token, ...env } = process.env;
  return { ...env, ...extra, CLAUDE_CODE_ENTRYPOINT: ENTRYPOINT };
}
