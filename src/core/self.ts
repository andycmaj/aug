// How an agent (or a Claude Code hook it fires) calls back into aug. The tools
// entry is plain TypeScript, so it runs under bare `bun` without the Solid
// preload the TUI needs.

import { fileURLToPath } from "node:url";

export function toolsEntry(): string {
  return fileURLToPath(new URL("../bin/aug-tools.ts", import.meta.url));
}

export function toolsArgv(): string[] {
  return [process.execPath, toolsEntry()];
}

// Quoted for a shell line (hook commands and the agent's brief are shell).
export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

export function toolsCommand(...args: string[]): string {
  return [...toolsArgv(), ...args].map(shellQuote).join(" ");
}

// Bash allow rules for an aug-tools command. Models often shorten the bun path
// to plain `bun`, a different prefix that a headless call denies unasked, so
// both spellings are allowed.
export function toolsRules(...args: string[]): string[] {
  const tail = [toolsEntry(), ...args].map(shellQuote).join(" ");
  return [...new Set([toolsCommand(...args), `bun ${tail}`])].map((c) => `Bash(${c}:*)`);
}

// The environment for a claude aug runs itself. TMUX_PANE goes: aug may run
// in a pane of a task's window, and a claude that loads user settings would
// have its hooks adopt it into that task (and aug-tools would take the pane's
// task for its own).
export function claudeEnv(extra: Record<string, string> = {}): Record<string, string | undefined> {
  const { TMUX_PANE: _, ...env } = process.env;
  return { ...env, ...extra, CLAUDE_CODE_ENTRYPOINT: "aug" };
}
