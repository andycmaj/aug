// Where Riker keeps its state. Everything lives under one home so a fixture run
// (or a test) can point RIKER_HOME at a scratch dir and touch nothing real.

import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { CMD, envVar, HOME_DIR, LEGACY } from "./brand";

export function defaultHome(): string {
  return join(homedir(), HOME_DIR);
}

// Where aug kept the default home before the rename (core/migrate-home.ts
// moves it and leaves a symlink).
export function legacyHome(): string {
  return join(homedir(), LEGACY.homeDir);
}

// The default home, while aug's ~/.aug is still a folder of its own (not yet
// moved and linked by core/migrate-home.ts).
export function homeUnmoved(): boolean {
  if (rikerHome() !== defaultHome()) return false;
  try {
    return lstatSync(legacyHome()).isDirectory();
  } catch {
    return false;
  }
}

// What this home was called before the rename, for things written then that
// name it (installed hooks, the statusline block): a home named .riker was
// the .aug beside it (core/migrate-home.ts); any other home kept its path.
export function homeAliases(home = rikerHome()): string[] {
  return basename(home) === HOME_DIR ? [home, join(dirname(home), LEGACY.homeDir)] : [home];
}

// An agent aug started has AUG_HOME=~/.aug, which is now a link to the
// default home: that is the default home, by its own name.
export function rikerHome(): string {
  const home = envVar("HOME");
  return !home || home === legacyHome() ? defaultHome() : home;
}

export const paths = {
  home: () => rikerHome(),
  db: () => join(rikerHome(), `${CMD}.db`),
  config: () => join(rikerHome(), "config.json"),
  docs: () => join(rikerHome(), "docs"),
  // A general agent's scratch folder: it may read and write there, and
  // nowhere that matters.
  work: (taskId: number) => join(rikerHome(), "work", String(taskId)),
  // What a coding start hands claude in files (its brief, a long note):
  // tmux refuses a command line past about 16KB.
  launch: (taskId: number) => join(rikerHome(), "work", String(taskId), "launch"),
  drafts: () => join(rikerHome(), "drafts"),
  // Where the Assistant writes a whole doc before `move propose_doc --file`:
  // a doc's Markdown headings cannot go on a Bash line (see propose_doc).
  docDrafts: () => join(rikerHome(), "drafts", "docs"),
  log: () => join(rikerHome(), `${CMD}.log`),
  // Perf counters (core/perf.ts): its own file, so recording them never
  // moves riker.db's data_version and wakes the TUI or the engine.
  perfDb: () => join(rikerHome(), "perf.db"),
  lock: () => join(rikerHome(), `${CMD}.pid`),
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
