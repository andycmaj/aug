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
