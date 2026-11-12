// What aug puts in your files outside its home: hooks for claudes you start
// by hand, the task in Claude Code's status line, revdiff's launcher. One
// registry feeds `aug install`, `aug uninstall` and the engine's refresh at
// start, so a machine is set up by one command and stays current after aug
// moves; a new one goes here, nowhere else. Each install is idempotent and
// touches only what it marked as its own.

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import revdiffLauncher from "../../contrib/revdiff/launch-revdiff.sh" with { type: "text" };
import {
  claudeSettingsPath,
  hooksCurrent,
  hooksHere,
  hooksInstalled,
  installHooks,
  readSettings,
  uninstallHooks,
  writeSettings,
} from "./adopt";
import { ensureHome, paths } from "./paths";
import { shellQuote, toolsArgv } from "./self";

export const InstallState = {
  installed: "installed",
  stale: "out of date",
  missing: "not installed",
  unavailable: "unavailable",
} as const;
export type InstallState = (typeof InstallState)[keyof typeof InstallState];

export interface Installable {
  help: string;
  // Why it cannot go in here: the tool it extends is absent.
  unavailable(): string | null;
  state(): Exclude<InstallState, "unavailable">;
  // Installed for this aug home. A scratch AUG_HOME (a test, a real-mode
  // check) must never take over the real one's setup.
  here(): boolean;
  // One line each of what was written or removed.
  install(): string;
  uninstall(): string | null;
}

const BACKUP = ".before-aug";

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// lstat, not exists: a dangling symlink still has to be moved aside.
function present(file: string): boolean {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

// A file aug owns outright. Someone else's is moved aside once (a symlink is
// moved, never written through) and put back by uninstall.
function writeOwned(file: string, text: string, marker: string): void {
  mkdirSync(dirname(file), { recursive: true });
  if (present(file) && !(readText(file) ?? "").includes(marker)) {
    if (present(file + BACKUP)) rmSync(file);
    else renameSync(file, file + BACKUP);
  } else if (present(file)) rmSync(file);
  writeFileSync(file, text);
  chmodSync(file, 0o755);
}

function removeOwned(file: string, marker: string): boolean {
  if (!(readText(file) ?? "").includes(marker)) return false;
  rmSync(file);
  if (present(file + BACKUP)) renameSync(file + BACKUP, file);
  return true;
}

function marked(script: string, name: string): string {
  const marker = `${markerOf(name)} for ${homeMark()} removed by \`aug uninstall ${name}\`.`;
  const [shebang, ...rest] = script.split("\n");
  return [shebang, marker, ...rest].join("\n");
}

const markerOf = (name: string) => `# Installed by \`aug install ${name}\``;
// Ends in ";" so one home is never a prefix match for another.
const homeMark = () => `aug home ${paths.home()};`;

// ── statusline ───────────────────────────────────────────────────────────

const STATUS = "statusline";
export const STARSHIP_PROFILE = "claude-code";
export const STARSHIP_MODULE = "${custom.aug_task}";
const STARSHIP_DEFAULT = "$claude_model$claude_context$claude_cost";
const BLOCK_START = "# >>> aug statusline >>>";
const BLOCK_END = "# <<< aug statusline <<<";
const ADDED = "# added by aug install statusline";
const PROFILE_LINE = new RegExp(
  `^(\\s*"?${STARSHIP_PROFILE}"?\\s*=\\s*)(["'])(.*)$`,
  "m",
);

export function starshipConfigPath(): string {
  return (
    process.env.STARSHIP_CONFIG ?? join(homedir(), ".config", "starship.toml")
  );
}

export function statusHelperPath(): string {
  return join(paths.home(), "statusline.sh");
}

// Claude Code runs the status line inside the agent's process, so the task
// comes from its env (or its window's tag, in aug-tools). An aug-tools too old
// to know `statusline` prints usage and fails; that is dropped, not shown.
export function statusHelper(): string {
  const tools = toolsArgv().map(shellQuote).join(" ");
  return marked(
    [
      "#!/bin/sh",
      "# The aug task this Claude session works, for starship's [custom.aug_task].",
      '[ -n "$AUG_TASK_ID$TMUX_PANE" ] || exit 0',
      `out=$(AUG_HOME="\${AUG_HOME:-${paths.home()}}" ${tools} statusline 2>/dev/null) && printf '%s' "$out"`,
      "exit 0",
      "",
    ].join("\n"),
    STATUS,
  );
}

// The ( ) group hides the module and its divider when the helper prints
// nothing; starship would draw a bare │ otherwise.
function starshipBlock(withProfile: boolean): string {
  return [
    BLOCK_START,
    "[custom.aug_task]",
    `command = ${JSON.stringify(statusHelperPath())}`,
    "when = true",
    'format = "([$output]($style)[ │ ](fg:244))"',
    'style = "bold fg:178"',
    'shell = ["sh"]',
    'description = "aug task this Claude session works"',
    ...(withProfile
      ? [
          "",
          "[profiles]",
          `${STARSHIP_PROFILE} = "${STARSHIP_MODULE}${STARSHIP_DEFAULT}"`,
        ]
      : []),
    BLOCK_END,
  ].join("\n");
}

function blockOf(toml: string): string | null {
  const start = toml.indexOf(BLOCK_START);
  const end = toml.indexOf(BLOCK_END);
  return start < 0 || end < start
    ? null
    : toml.slice(start, end + BLOCK_END.length);
}

function withoutBlock(toml: string): string {
  const start = toml.indexOf(BLOCK_START);
  const end = toml.indexOf(BLOCK_END);
  if (start < 0 || end < start) return toml;
  const before = toml.slice(0, start).replace(/\n+$/, "\n");
  const after = toml.slice(end + BLOCK_END.length).replace(/^\n+/, "");
  return before + after;
}

function withoutProfile(toml: string): string {
  return toml
    .split("\n")
    .filter((l) => !l.endsWith(ADDED))
    .join("\n")
    .replace(PROFILE_LINE, (line) => line.replace(STARSHIP_MODULE, ""));
}

// Your claude-code profile gets the module in front; one aug adds is marked
// so uninstall can take the whole line back out.
export function withStatusline(toml: string): string {
  let rest = withoutProfile(withoutBlock(toml));
  let ownProfiles = false;
  if (PROFILE_LINE.test(rest))
    rest = rest.replace(
      PROFILE_LINE,
      (_: string, head: string, quote: string, tail: string) =>
        `${head}${quote}${STARSHIP_MODULE}${tail}`,
    );
  else if (/^\[profiles\]\s*$/m.test(rest))
    rest = rest.replace(
      /^\[profiles\]\s*$/m,
      (h) =>
        `${h}\n${STARSHIP_PROFILE} = "${STARSHIP_MODULE}${STARSHIP_DEFAULT}"  ${ADDED}`,
    );
  else ownProfiles = true;
  const body = rest.replace(/\n*$/, "");
  return `${body ? `${body}\n\n` : ""}${starshipBlock(ownProfiles)}\n`;
}

export function withoutStatusline(toml: string): string {
  return withoutProfile(withoutBlock(toml));
}

const STATUS_COMMAND = `starship statusline ${STARSHIP_PROFILE}`;

const statusline: Installable = {
  help: "the aug task in Claude Code's status line (a starship module)",
  unavailable: () =>
    Bun.which("starship", { PATH: process.env.PATH ?? "" })
      ? null
      : "starship is not on PATH",
  state() {
    const toml = readText(starshipConfigPath()) ?? "";
    const block = blockOf(toml);
    if (!block) return InstallState.missing;
    const current =
      block === starshipBlock(block.includes("\n[profiles]\n")) &&
      Boolean(PROFILE_LINE.exec(toml)?.[0].includes(STARSHIP_MODULE)) &&
      readText(statusHelperPath()) === statusHelper();
    return current ? InstallState.installed : InstallState.stale;
  },
  here: () =>
    blockOf(readText(starshipConfigPath()) ?? "")?.includes(
      JSON.stringify(statusHelperPath()),
    ) ?? false,
  install() {
    ensureHome();
    writeOwned(statusHelperPath(), statusHelper(), markerOf(STATUS));
    const file = starshipConfigPath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, withStatusline(readText(file) ?? ""));
    const lines = [
      `${file} [custom.aug_task] in the ${STARSHIP_PROFILE} profile`,
    ];
    // A status line you already set is yours; say when it is not the one
    // that shows the module.
    const settingsFile = claudeSettingsPath();
    const settings = readSettings(settingsFile);
    const current = (settings.statusLine as { command?: string } | undefined)
      ?.command;
    if (!settings.statusLine) {
      writeSettings(settingsFile, {
        ...settings,
        statusLine: { type: "command", command: STATUS_COMMAND },
      });
      lines.push(`${settingsFile} statusLine runs ${STATUS_COMMAND}`);
    } else if (!current?.includes(STATUS_COMMAND))
      lines.push(
        `${settingsFile} statusLine runs ${current ?? "something else"}, not ${STATUS_COMMAND}: left as is`,
      );
    return lines.join("\n");
  },
  uninstall() {
    const file = starshipConfigPath();
    const toml = readText(file);
    const removed = removeOwned(statusHelperPath(), markerOf(STATUS));
    if (toml === null || !toml.includes(BLOCK_START))
      return removed ? statusHelperPath() : null;
    writeFileSync(file, withoutStatusline(toml));
    return `${file} (Claude's statusLine left as is)`;
  },
};

// ── revdiff ──────────────────────────────────────────────────────────────

const REVDIFF = "revdiff";

function claudeDir(): string {
  return dirname(claudeSettingsPath());
}

// Where the revdiff plugin looks for a user-layer launcher, one per
// marketplace it is installed from.
export function revdiffTargets(): string[] {
  const plugins = join(claudeDir(), "plugins");
  let installed: Record<string, unknown> = {};
  try {
    const json = JSON.parse(
      readFileSync(join(plugins, "installed_plugins.json"), "utf8"),
    ) as {
      plugins?: Record<string, unknown>;
    };
    installed = json.plugins ?? {};
  } catch {
    return [];
  }
  return Object.keys(installed)
    .map((key) => /^revdiff@(.+)$/.exec(key)?.[1])
    .filter((m): m is string => Boolean(m))
    .map((market) =>
      join(
        plugins,
        "data",
        `revdiff-${market}`,
        "scripts",
        "launch-revdiff.sh",
      ),
    );
}

export function revdiffScript(): string {
  return marked(revdiffLauncher, REVDIFF);
}

const revdiff: Installable = {
  help: "revdiff opens in a split of the task's window, inside aug's viewer",
  unavailable: () =>
    revdiffTargets().length
      ? null
      : "the revdiff Claude Code plugin is not installed",
  state() {
    const texts = revdiffTargets().map(readText);
    if (texts.every((t) => t === revdiffScript()))
      return InstallState.installed;
    return texts.some((t) => t?.includes(markerOf(REVDIFF)))
      ? InstallState.stale
      : InstallState.missing;
  },
  here: () =>
    revdiffTargets().some((file) => readText(file)?.includes(homeMark())),
  install() {
    const targets = revdiffTargets();
    for (const file of targets)
      writeOwned(file, revdiffScript(), markerOf(REVDIFF));
    return targets.join("\n");
  },
  uninstall() {
    const removed = revdiffTargets().filter((file) =>
      removeOwned(file, markerOf(REVDIFF)),
    );
    return removed.length ? removed.join("\n") : null;
  },
};

// ── hooks ────────────────────────────────────────────────────────────────

const hooks: Installable = {
  help: "pick up claudes you start by hand in a project's tmux session",
  unavailable: () => null,
  state() {
    if (!hooksInstalled()) return InstallState.missing;
    return hooksCurrent() ? InstallState.installed : InstallState.stale;
  },
  here: () => hooksHere(),
  install: () => installHooks(),
  uninstall: () => (uninstallHooks() ? claudeSettingsPath() : null),
};

export const INSTALLS: Record<string, Installable> = {
  hooks,
  statusline,
  revdiff,
};

export function installState(name: string): InstallState {
  const item = INSTALLS[name];
  return item.unavailable() ? InstallState.unavailable : item.state();
}

// At start: what you installed is rewritten when it no longer matches this
// aug (a moved checkout, a new hook event), and nothing new goes in.
export function refreshInstalls(): string[] {
  const refreshed: string[] = [];
  for (const [name, item] of Object.entries(INSTALLS)) {
    if (installState(name) !== InstallState.stale || !item.here()) continue;
    item.install();
    refreshed.push(name);
  }
  return refreshed;
}
