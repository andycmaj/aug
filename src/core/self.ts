// How an agent (or a Claude Code hook it fires) calls back into aug. The tools
// entry is plain TypeScript, so it runs under bare `bun` without the Solid
// preload the TUI needs.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { augHome } from "./paths";

// A compiled binary (`bun run compile`) has no script on disk to hand bun; it
// is aug-tools itself under the `tools` subcommand (src/bin/aug.ts).
const COMPILED = import.meta.url.includes("/$bunfs/");
export const TOOLS_SUBCOMMAND = "tools";

export function toolsEntry(): string {
  return fileURLToPath(new URL("../bin/aug-tools.ts", import.meta.url));
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
export const TOOLS_NAME = "aug-tools";

export function toolsBin(): string {
  const dir = join(augHome(), "bin");
  const file = join(dir, TOOLS_NAME);
  const script = `#!/bin/sh\nexec ${toolsArgv().map(shellQuote).join(" ")} "$@"\n`;
  if (!existsSync(file) || readFileSync(file, "utf8") !== script) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, script);
    chmodSync(file, 0o755);
  }
  return dir;
}

export function toolsEnv(): Record<string, string> {
  return { PATH: `${toolsBin()}:${process.env.PATH ?? ""}` };
}

// Bash allow rules for an aug-tools command: the short name, and the full
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

// The environment for a claude aug runs itself. TMUX_PANE goes: aug may run
// in a pane of a task's window, and a claude that loads user settings would
// have its hooks adopt it into that task (and aug-tools would take the pane's
// task for its own).
export function claudeEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const { TMUX_PANE: _, ...env } = process.env;
  return { ...env, ...extra, CLAUDE_CODE_ENTRYPOINT: "aug" };
}
