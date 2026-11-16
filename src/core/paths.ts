// Where aug keeps its state. Everything lives under one home so a fixture run
// (or a test) can point AUG_HOME at a scratch dir and touch nothing real.

import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function defaultHome(): string {
  return join(homedir(), ".aug");
}

export function augHome(): string {
  return process.env.AUG_HOME ?? defaultHome();
}

export const paths = {
  home: () => augHome(),
  db: () => join(augHome(), "aug.db"),
  config: () => join(augHome(), "config.json"),
  docs: () => join(augHome(), "docs"),
  // A general agent's scratch folder: it may read and write there, and
  // nowhere that matters.
  work: (taskId: number) => join(augHome(), "work", String(taskId)),
  drafts: () => join(augHome(), "drafts"),
  // Where the Assistant writes a whole doc before `move propose_doc --file`:
  // a doc's Markdown headings cannot go on a Bash line (see propose_doc).
  docDrafts: () => join(augHome(), "drafts", "docs"),
  log: () => join(augHome(), "aug.log"),
  // Perf counters (core/perf.ts): its own file, so recording them never
  // moves aug.db's data_version and wakes the TUI or the engine.
  perfDb: () => join(augHome(), "perf.db"),
  lock: () => join(augHome(), "aug.pid"),
};

export function ensureHome(): void {
  for (const dir of [paths.home(), paths.docs(), paths.drafts(), paths.docDrafts()]) {
    mkdirSync(dir, { recursive: true });
  }
}

// docDrafts made and resolved: allow rules and the move's path check compare
// real paths (/tmp is /private/tmp on macOS).
export function docDraftsDir(): string {
  mkdirSync(paths.docDrafts(), { recursive: true });
  return realpathSync(paths.docDrafts());
}
