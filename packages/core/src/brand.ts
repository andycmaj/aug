// Every name Riker goes by, in one place. Riker was called aug; LEGACY holds
// those spellings, which things already running still carry (agents' env and
// briefs, tagged tmux windows, installed hooks, old text with AUG-0076 in it).
// New code writes only the current names and reads both until the compat
// window closes (docs/rename-riker.md, Phase 4); the ref parsers accept AUG-
// for good, since old text never goes away.

export const NAME = "Riker";
// The command, the home's file stem (riker.db, riker.log, riker.pid) and the
// Claude Code entrypoint of the claudes Riker runs itself.
export const CMD = "riker";
export const TOOLS_NAME = "riker-tools";
export const HOME_DIR = ".riker";
export const ENV_PREFIX = "RIKER_";
// Set to 1 in a coding agent's env, so its own wt and tmux hooks can tell.
export const ENV_FLAG = "RIKER";
export const REF_PREFIX = "RIKER-";
export const OPTION_PREFIX = "@riker_";
export const ENTRYPOINT = CMD;
// The plugin Riker writes under its home for its task actions: skills are
// `riker:summarize`, ...
export const PLUGIN = CMD;
// turns.author of what Riker says itself, and sessions.started_by of what it
// started.
export const SELF = CMD;

export const LEGACY = {
  name: "aug",
  cmd: "aug",
  toolsName: "aug-tools",
  homeDir: ".aug",
  envPrefix: "AUG_",
  envFlag: "AUG",
  refPrefix: "AUG-",
  optionPrefix: "@aug_",
  entrypoint: "aug",
  plugin: "aug",
  self: "aug",
  // The GitHub repo, until the owner renames it (Phase 3).
  repo: "andycmaj/aug",
} as const;

export const REPO = "andycmaj/riker";

type Env = Record<string, string | undefined>;

export const envName = (name: string) => `${ENV_PREFIX}${name}`;

// RIKER_<name>, else the AUG_<name> an older Riker (aug) set.
export function envVar(name: string, from: Env = process.env): string | undefined {
  return from[`${ENV_PREFIX}${name}`] ?? from[`${LEGACY.envPrefix}${name}`];
}

// Inside an agent Riker (or aug) started.
export function inAgentEnv(from: Env = process.env): boolean {
  return Boolean(from[ENV_FLAG] || from[LEGACY.envFlag]);
}

export const option = (name: string) => `${OPTION_PREFIX}${name}`;
export const legacyOption = (name: string) => `${LEGACY.optionPrefix}${name}`;

// A tmux format that reads @riker_<name>, else @aug_<name>: windows tagged by
// aug before the rename keep their identity.
export const optionFormat = (name: string) =>
  `#{?${option(name)},#{${option(name)}},#{${legacyOption(name)}}}`;

// Claude Code entrypoints of claudes Riker runs itself.
export const OWN_ENTRYPOINTS: readonly string[] = [ENTRYPOINT, LEGACY.entrypoint];

// RIKER-0076, AUG-0076, riker76, aug-76 or a bare 76 (with an optional @): the
// task number, else null.
const REF = /^@?(?:(?:riker|aug)-?)?0*(\d+)$/i;
export function refNumber(text: string): number | null {
  const m = text.trim().match(REF);
  return m ? Number(m[1]) : null;
}
// The prefix a ref may carry, for patterns that find refs inside other text.
export const REF_WORD = "(?:RIKER|AUG)";
