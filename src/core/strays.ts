// Claudes started outside aug: in a tmux session of your own, or a plain
// terminal. Each running claude writes ~/.claude/sessions/<pid>.json (its
// session id, cwd and, inside tmux, its pane), which is how they are found.
// Adopting one makes it a coding task in a project: a claude in tmux keeps
// running and its window moves into the project's session; one outside tmux
// is recorded as saved, so Start resumes it in a window of the project.

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { adoptedTitle, claudeDir, gitInfo, type GitInfo } from "./adopt";
import { sessionActivity, sessionEnded, sessionStarted } from "./lifecycle";
import { logger } from "./log";
import { mux, type PaneInfo } from "./mux";
import { takeWindow } from "./projects";
import * as store from "./store";
import {
  AgentState,
  Channel,
  Kind,
  SessionKind,
  TaskStatus,
  TurnRole,
  type ProjectRow,
  type TaskRow,
} from "./types";

const log = logger("strays");

// What a running claude says about itself. The file is Claude Code's own
// and undocumented, so every field but the ids is optional.
export interface ClaudeProcess {
  pid: number;
  sessionId: string;
  cwd: string;
  // "%12", from "session:@window.%pane".
  pane: string | null;
  name: string | null;
  // "busy" or "idle".
  status: string | null;
}

export function parseClaudeProcess(text: string): ClaudeProcess | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const pid = typeof raw.pid === "number" ? raw.pid : 0;
  const sessionId = str(raw.sessionId);
  const cwd = str(raw.cwd);
  // claude -p and SDK sessions run once and go; only interactive ones are
  // someone's work in progress.
  const kind = str(raw.kind);
  if (!pid || !sessionId || !cwd || (kind && kind !== "interactive")) return null;
  // aug's own headless claudes (claudeEnv).
  if (str(raw.entrypoint) === "aug") return null;
  const pane = str(raw.tmux)?.match(/(%\d+)$/)?.[1] ?? null;
  // A name claude derived from the folder (beanstream-00) names nothing.
  const source = str(raw.nameSource);
  const name = !source || source === "user" ? str(raw.name) : null;
  return { pid, sessionId, cwd, pane, name, status: str(raw.status) };
}

export function readClaudeProcesses(dir = join(claudeDir(), "sessions")): ClaudeProcess[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const found: ClaudeProcess[] = [];
  for (const file of files) {
    try {
      const p = parseClaudeProcess(readFileSync(join(dir, file), "utf8"));
      if (p) found.push(p);
    } catch {
      // gone between the listing and the read
    }
  }
  return found;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parentMap(): Map<number, number> {
  const r = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="], { stdout: "pipe", stderr: "ignore" });
  const parents = new Map<number, number>();
  for (const line of r.stdout.toString().split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (pid && ppid) parents.set(pid, ppid);
  }
  return parents;
}

// Where strays come from, swapped in tests.
export interface StraySource {
  claudes(): ClaudeProcess[];
  alive(pid: number): boolean;
  // Whether pid runs under ancestor: a pane id names a pane on aug's tmux
  // server only if the claude is that pane's process or below it.
  under(pid: number, ancestor: number): boolean;
  git(cwd: string): GitInfo;
}

export function realSource(): StraySource {
  let parents: Map<number, number> | undefined;
  return {
    claudes: () => readClaudeProcesses(),
    alive: pidAlive,
    under(pid, ancestor) {
      parents ??= parentMap();
      for (let p: number | undefined = pid, n = 0; p && n < 64; p = parents.get(p), n++)
        if (p === ancestor) return true;
      return false;
    },
    git: gitInfo,
  };
}

let current: (() => StraySource) | undefined;

// Tests swap in their own claudes, like setMux and setBrain.
export function setStraySource(source: StraySource | null): void {
  current = source ? () => source : undefined;
}

export interface Stray {
  claude: ClaudeProcess;
  // Its pane on aug's tmux server; null outside tmux (or on another server).
  pane: PaneInfo | null;
  git: GitInfo;
}

export function strayLabel(s: Stray): string {
  const where = s.pane ? `${s.pane.sessionName}:${s.pane.windowName}` : "terminal";
  const branch = s.git.branch ?? basename(s.claude.cwd);
  return [where, branch, s.claude.name, s.claude.status].filter(Boolean).join(" · ");
}

// What a move or the CLI names a stray by.
export function strayRef(s: Stray): string {
  return s.claude.sessionId.slice(0, 8);
}

// Running claudes that are nobody's task: not aug's own, not in a window a
// task already holds, and not the claude in the window aug runs in.
export async function findStrays(source: StraySource = (current ?? realSource)()): Promise<Stray[]> {
  const host = await mux().hostWindow();
  const strays: Stray[] = [];
  const windows = new Set<string>();
  for (const claude of source.claudes()) {
    if (!source.alive(claude.pid)) continue;
    if (store.getSession(claude.sessionId)) continue;
    let pane = claude.pane ? await mux().paneInfo(claude.pane) : null;
    if (pane && !source.under(claude.pid, pane.panePid)) pane = null;
    if (pane) {
      if (pane.taskId && store.getTask(pane.taskId)) continue;
      if (pane.windowId === host || windows.has(pane.windowId)) continue;
      windows.add(pane.windowId);
    }
    strays.push({ claude, pane, git: source.git(claude.cwd) });
  }
  return strays;
}

// By its ref (a session id's start), its pane (%12), its tmux session's name
// or its pid. Several matches (a tmux session with two claudes) is an error.
export function matchStray(strays: Stray[], ref: string): Stray {
  const want = ref.trim();
  const hits = strays.filter(
    (s) =>
      (want.length >= 4 && s.claude.sessionId.startsWith(want)) ||
      s.claude.pane === want ||
      s.pane?.sessionName === want ||
      String(s.claude.pid) === want,
  );
  if (hits.length === 1) return hits[0];
  const list = strays.map((s) => `${strayRef(s)} (${strayLabel(s)})`).join("; ");
  if (hits.length > 1)
    throw new Error(`${want} names ${hits.length} claudes: ${hits.map((s) => `${strayRef(s)} (${strayLabel(s)})`).join("; ")}`);
  throw new Error(`no stray claude ${want}. ${strays.length ? `Strays: ${list}.` : "There are none."}`);
}

export async function adoptStray(stray: Stray, project: ProjectRow): Promise<TaskRow> {
  const { claude, pane, git } = stray;
  const task = store.createTask({
    title: adoptedTitle(git, claude.name ?? undefined, pane?.sessionName || basename(claude.cwd)),
    kind: Kind.coding,
    channel: Channel.owner,
    repo: git.repo,
    projectId: project.id,
    // The main checkout's branch is shared and not the task's to remove.
    branch: git.worktree ? git.branch : null,
  });
  // claude --resume finds a session by the directory it ran in.
  store.updateTask(task.id, { worktree: claude.cwd });
  if (git.repo) store.addProjectRepo(project.id, git.repo);
  store.addTurn({
    taskId: task.id,
    role: TurnRole.trigger,
    body: pane
      ? `Adopted the claude in tmux ${pane.sessionName}:${pane.windowName} into ${project.name}`
      : `Adopted the claude running in ${claude.cwd} into ${project.name}. Quit it there, then Start continues it here.`,
  });
  const ref = { taskId: task.id, sessionId: claude.sessionId };
  if (pane) {
    try {
      await takeWindow(task.id, pane.windowId);
    } catch (err) {
      // No window, no task: it would sit there with nothing behind it.
      store.updateTask(task.id, { status: TaskStatus.dropped });
      throw err;
    }
    sessionStarted({
      id: claude.sessionId,
      taskId: task.id,
      kind: SessionKind.tmux,
      cwd: claude.cwd,
      startedBy: "owner",
      tmuxWindow: pane.windowId,
    });
    if (claude.status === "idle") sessionActivity(ref, AgentState.blocked, "is waiting at its prompt");
  } else {
    sessionStarted({
      id: claude.sessionId,
      taskId: task.id,
      kind: SessionKind.tmux,
      cwd: claude.cwd,
      startedBy: "owner",
    });
    sessionEnded(ref, AgentState.saved);
  }
  log.info("adopted stray", { task: task.id, project: project.id, pane: claude.pane, tmux: !!pane });
  return store.getTask(task.id)!;
}
