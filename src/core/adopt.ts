// Claudes you start by hand inside a project's tmux session. aug-launched
// claudes get their hooks through --settings; these get them from your user
// settings, through a guard script that exits before bun starts unless the
// pane's session is a project and the claude is not one of aug's own. The
// first hook from an untagged window makes it a task in that project.

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { handleHook, type HookEnv, type HookPayload } from "./hooks";
import { logger } from "./log";
import { mux } from "./mux";
import { ensureHome, paths } from "./paths";
import { toolsArgv, shellQuote } from "./self";
import * as store from "./store";
import { Channel, Kind, SessionKind, TurnRole } from "./types";

const log = logger("adopt");

export interface GitInfo {
  branch: string | null;
  toplevel: string | null;
  repo: string | null;
}

function git(cwd: string, args: string[]): string | null {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  if (r.exitCode !== 0) return null;
  return r.stdout.toString().trim() || null;
}

// owner/repo from a GitHub remote, in either URL form.
export function repoFromRemote(url: string | null): string | null {
  const m = url?.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

export function gitInfo(cwd: string): GitInfo {
  const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  return {
    branch: branch === "HEAD" ? null : branch,
    toplevel: git(cwd, ["rev-parse", "--show-toplevel"]),
    repo: repoFromRemote(git(cwd, ["remote", "get-url", "origin"])),
  };
}

const DEFAULT_BRANCHES = new Set(["main", "master", "trunk", "develop"]);

export function adoptedTitle(
  info: GitInfo,
  prompt: string | undefined,
  windowName: string,
): string {
  if (info.branch && !DEFAULT_BRANCHES.has(info.branch)) return info.branch;
  const line = prompt?.trim().split("\n")[0]?.trim();
  if (line) return line.length > 80 ? `${line.slice(0, 79)}…` : line;
  return windowName.trim() || "claude";
}

// Events that mean someone is working; a claude opened and closed without a
// word makes no task.
const STARTS = new Set(["prompt", "tool", "notification"]);

// Resolves the pane to a task (making one if the window has none) and the
// claude's session row, then hands off to the ordinary hook path.
export async function adoptHook(
  event: string,
  payload: HookPayload,
  paneId: string,
  probe: (cwd: string) => GitInfo = gitInfo,
): Promise<HookEnv | null> {
  const sessionId = payload.session_id;
  if (!sessionId) return null;
  const pane = await mux().paneInfo(paneId);
  if (!pane?.projectId) return null;
  const project = store.getProject(pane.projectId);
  if (!project || project.status !== "active") return null;

  let taskId = pane.taskId;
  if (!taskId || !store.getTask(taskId)) {
    if (!STARTS.has(event)) return null;
    const cwd = payload.cwd ?? process.cwd();
    const info = probe(cwd);
    const task = store.createTask({
      title: adoptedTitle(info, payload.prompt, pane.windowName),
      kind: Kind.coding,
      channel: Channel.owner,
      repo: info.repo,
      projectId: project.id,
      branch: info.branch,
    });
    store.updateTask(task.id, { worktree: info.toplevel });
    if (info.repo) store.addProjectRepo(project.id, info.repo);
    store.addTurn({
      taskId: task.id,
      role: TurnRole.trigger,
      body: `Picked up a claude you started in ${project.name}`,
    });
    await mux().tagWindow(pane.windowId, task.id);
    taskId = task.id;
    log.info("adopted", { task: task.id, project: project.id, window: pane.windowId });
  }

  if (!store.getSession(sessionId)) {
    if (!STARTS.has(event)) return null;
    store.createSession({
      id: sessionId,
      taskId,
      kind: SessionKind.tmux,
      cwd: payload.cwd ?? process.cwd(),
      startedBy: "owner",
      tmuxWindow: pane.windowId,
    });
  }
  const env = { taskId, sessionId };
  handleHook(event, payload, env);
  return env;
}

// For aug-tools run by hand inside an adopted window: the task comes from
// the window's tag, the session from its newest live claude.
export async function paneEnv(paneId: string): Promise<HookEnv | null> {
  const pane = await mux().paneInfo(paneId);
  if (!pane?.taskId) return null;
  const session = store
    .sessionsForTask(pane.taskId)
    .find((s) => !s.ended_at && s.tmux_window === pane.windowId);
  return session ? { taskId: pane.taskId, sessionId: session.id } : null;
}

// ── user settings ────────────────────────────────────────────────────────

const HOOK_EVENTS: [claudeEvent: string, augEvent: string, matcher?: string][] = [
  ["UserPromptSubmit", "prompt"],
  ["PreToolUse", "tool", "*"],
  ["Notification", "notification"],
  ["Stop", "stop"],
  ["SessionEnd", "end"],
];

const GUARD_NAME = "adopt-hook.sh";

export function claudeSettingsPath(): string {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  return join(dir, "settings.json");
}

export function guardPath(): string {
  return join(paths.home(), GUARD_NAME);
}

// Exits before bun starts for every claude that is not a hand-started one in
// a project session, so other claudes pay one sh and one tmux call.
export function guardScript(): string {
  const tools = toolsArgv().map(shellQuote).join(" ");
  return [
    "#!/bin/sh",
    "# Installed by `aug hooks install`; removed by `aug hooks uninstall`.",
    '[ -n "$AUG_TASK_ID" ] && exit 0',
    '[ -n "$TMUX_PANE" ] || exit 0',
    '[ -n "$(tmux show-options -qv -t "$TMUX_PANE" @aug_project 2>/dev/null)" ] || exit 0',
    `AUG_HOME=${shellQuote(paths.home())} exec ${tools} adopt-hook "$1"`,
    "",
  ].join("\n");
}

interface HookEntry {
  type: string;
  command: string;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}
type Settings = Record<string, unknown> & {
  hooks?: Record<string, HookGroup[]>;
};

function readSettings(file: string): Settings {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return {};
  return JSON.parse(text) as Settings;
}

const isOurs = (h: HookEntry) => h.command.includes(GUARD_NAME);

function withoutOurs(settings: Settings): Settings {
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const kept = groups
      .map((g) => ({ ...g, hooks: g.hooks.filter((h) => !isOurs(h)) }))
      .filter((g) => g.hooks.length > 0);
    if (kept.length > 0) hooks[event] = kept;
  }
  const { hooks: _, ...rest } = settings;
  return Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest;
}

export function hooksInstalled(file = claudeSettingsPath()): boolean {
  try {
    return Object.values(readSettings(file).hooks ?? {}).some((groups) =>
      groups.some((g) => g.hooks.some(isOurs)),
    );
  } catch {
    return false;
  }
}

// Idempotent: our entries are replaced, nobody else's are touched, and the
// first install keeps a copy of the file as it was.
export function installHooks(file = claudeSettingsPath()): string {
  const settings = withoutOurs(readSettings(file));
  ensureHome();
  writeFileSync(guardPath(), guardScript());
  chmodSync(guardPath(), 0o755);
  const hooks = { ...(settings.hooks ?? {}) };
  for (const [claudeEvent, augEvent, matcher] of HOOK_EVENTS) {
    const group: HookGroup = {
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: "command", command: `sh ${shellQuote(guardPath())} ${augEvent}` }],
    };
    hooks[claudeEvent] = [...(hooks[claudeEvent] ?? []), group];
  }
  const backup = `${file}.before-aug`;
  if (existsSync(file) && !existsSync(backup)) copyFileSync(file, backup);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...settings, hooks }, null, 2) + "\n");
  return file;
}

export function uninstallHooks(file = claudeSettingsPath()): boolean {
  if (!existsSync(file)) return false;
  const before = readSettings(file);
  if (!hooksInstalled(file)) return false;
  writeFileSync(file, JSON.stringify(withoutOurs(before), null, 2) + "\n");
  return true;
}
