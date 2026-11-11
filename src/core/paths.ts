// Where aug keeps its state. Everything lives under one home so a fixture run
// (or a test) can point AUG_HOME at a scratch dir and touch nothing real.

import { mkdirSync } from "node:fs";
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
  log: () => join(augHome(), "aug.log"),
};

export function ensureHome(): void {
  for (const dir of [paths.home(), paths.docs(), paths.drafts()]) {
    mkdirSync(dir, { recursive: true });
  }
}
