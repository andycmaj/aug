// The one door to tmux and worktrunk. tmux owns every coding agent's claude,
// so it outlives aug and you can reach it from any client; aug only tags what
// it made and reads the tags back. Identity is the @aug_project / @aug_task
// user options, never a name, so renaming a session or window breaks nothing.
// Only this file imports libtmux (alpha, pinned exactly): its API churn and
// any macOS trouble stay here. Tests swap in a fake with setMux.

import { Server } from "libtmux";
import { loadConfig } from "./config";
import { logger } from "./log";

const log = logger("mux");

export const PROJECT_OPTION = "@aug_project";
export const TASK_OPTION = "@aug_task";

export interface MuxSession {
  id: string;
  name: string;
  projectId: number | null;
  // aug's own grouped viewers, never offered for adoption.
  viewer: boolean;
}

export interface MuxWindow {
  id: string;
  sessionId: string;
  name: string;
  taskId: number | null;
}

// Where a pane sits: what a hook in a hand-started claude needs to know.
export interface PaneInfo {
  windowId: string;
  windowName: string;
  sessionId: string;
  taskId: number | null;
  projectId: number | null;
}

export interface MuxState {
  sessions: MuxSession[];
  windows: MuxWindow[];
}

export interface NewWindow {
  sessionId: string;
  name: string;
  cwd: string;
  env: Record<string, string>;
  argv: string[];
}

export interface Worktree {
  repoPath: string;
  branch: string;
  create: boolean;
  env: Record<string, string>;
}

export interface Mux {
  // No tmux server running is an empty state, not an error.
  state(): Promise<MuxState>;
  newSession(name: string, cwd: string): Promise<MuxSession>;
  tagSession(sessionId: string, projectId: number): Promise<void>;
  newWindow(w: NewWindow): Promise<MuxWindow>;
  tagWindow(windowId: string, taskId: number): Promise<void>;
  killWindow(windowId: string): Promise<void>;
  killSession(sessionId: string): Promise<void>;
  moveWindow(windowId: string, sessionId: string): Promise<void>;
  // Types a line into the window's pane, then Enter.
  sendLine(windowId: string, text: string): Promise<void>;
  // Moves your own tmux client (the one aug runs in) to the window.
  switchClient(windowId: string): Promise<void>;
  // argv for the embedded terminal: attaches a grouped session of its own,
  // so showing a window never moves your real client.
  viewerArgv(viewerName: string, sessionId: string, windowId: string): string[];
  paneInfo(paneId: string): Promise<PaneInfo | null>;
  // A local or origin branch by that name.
  branchExists(repoPath: string, branch: string): Promise<boolean>;
  // Makes the worktree and answers its path.
  worktree(w: Worktree): Promise<MadeWorktree>;
  removeWorktree(repoPath: string, branch: string): Promise<void>;
}

export class MuxError extends Error {}

// ── shell helpers ────────────────────────────────────────────────────────

export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_\-./=:@%+,]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

// The window runs claude, then a login shell, so it stays open when claude
// exits and you can resume or look around.
export function windowCommand(argv: string[]): string {
  return `${argv.map(shellQuote).join(" ")}; exec "\${SHELL:-/bin/sh}" -l`;
}

export function fillTemplate(
  template: string,
  values: Record<string, string>,
): string[] {
  return template
    .split(/\s+/)
    .filter(Boolean)
    .map((part) =>
      part.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? ""),
    )
    .filter(Boolean);
}

export interface MadeWorktree {
  path: string;
  // What wt resolved the branch to (pr:12 becomes the PR's head branch).
  branch: string | null;
}

// wt --format json prints {path, branch, ...}; a custom command may print
// just a path on its last line.
export function parseWorktree(stdout: string): MadeWorktree | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (typeof parsed.path === "string" && parsed.path)
      return {
        path: parsed.path,
        branch: typeof parsed.branch === "string" ? parsed.branch : null,
      };
  } catch {
    // not JSON: fall through to the last line
  }
  const last = text.split("\n").pop()?.trim() ?? "";
  return last.startsWith("/") ? { path: last, branch: null } : null;
}

const WT_TIMEOUT_MS = 5 * 60_000;

// ── tmux ─────────────────────────────────────────────────────────────────

const SEP = "\t";
const SESSION_FORMAT = ["#{session_id}", "#{session_name}", `#{${PROJECT_OPTION}}`].join(SEP);
const WINDOW_FORMAT = [
  "#{window_id}",
  "#{session_id}",
  "#{window_name}",
  `#{${TASK_OPTION}}`,
].join(SEP);

export const VIEWER_PREFIX = "aug-view-";

function idOf(raw: string | undefined): number | null {
  const n = Number(raw);
  return raw && Number.isInteger(n) && n > 0 ? n : null;
}

export interface TmuxSocket {
  socketName?: string;
  socketPath?: string;
}

// Inside a pane, $TMUX names the server the pane lives on.
export function socketFromEnv(tmux = process.env.TMUX): TmuxSocket | null {
  const path = tmux?.split(",")[0];
  return path ? { socketPath: path } : null;
}

export class TmuxMux implements Mux {
  private server: Server;
  private socket: TmuxSocket;

  constructor(socket?: TmuxSocket | string) {
    const name = typeof socket === "string" ? socket : undefined;
    this.socket =
      typeof socket === "object"
        ? socket
        : { socketName: name ?? loadConfig().tmuxSocket };
    const { socketName, socketPath } = this.socket;
    this.server = new Server(
      socketPath ? { socketPath } : socketName ? { socketName } : {},
    );
  }

  private tmuxArgs(): string[] {
    const { socketName, socketPath } = this.socket;
    if (socketPath) return ["tmux", "-S", socketPath];
    return socketName ? ["tmux", "-L", socketName] : ["tmux"];
  }

  async paneInfo(paneId: string): Promise<PaneInfo | null> {
    try {
      const [line] = await this.server.cmd("display-message", [
        "-p",
        "-t",
        paneId,
        ["#{window_id}", "#{window_name}", "#{session_id}", `#{${TASK_OPTION}}`, `#{${PROJECT_OPTION}}`].join(SEP),
      ]);
      if (!line) return null;
      const [windowId, windowName, sessionId, task, project] = line.split(SEP);
      return { windowId, windowName, sessionId, taskId: idOf(task), projectId: idOf(project) };
    } catch {
      return null;
    }
  }

  async state(): Promise<MuxState> {
    let sessionLines: readonly string[];
    let windowLines: readonly string[];
    try {
      sessionLines = await this.server.cmd("list-sessions", ["-F", SESSION_FORMAT]);
      windowLines = await this.server.cmd("list-windows", ["-a", "-F", WINDOW_FORMAT]);
    } catch (err) {
      // No server on the socket yet.
      log.debug("tmux state empty", { err: String(err) });
      return { sessions: [], windows: [] };
    }
    const sessions = sessionLines.filter(Boolean).map((line) => {
      const [id, name, project] = line.split(SEP);
      return {
        id,
        name,
        projectId: idOf(project),
        viewer: name.startsWith(VIEWER_PREFIX),
      };
    });
    // A grouped viewer lists every window again; report each window once,
    // under its project session.
    const viewers = new Set(sessions.filter((s) => s.viewer).map((s) => s.id));
    const seen = new Set<string>();
    const windows: MuxWindow[] = [];
    for (const line of windowLines) {
      if (!line) continue;
      const [id, sessionId, name, task] = line.split(SEP);
      if (viewers.has(sessionId) || seen.has(id)) continue;
      seen.add(id);
      windows.push({ id, sessionId, name, taskId: idOf(task) });
    }
    return { sessions, windows };
  }

  async newSession(name: string, cwd: string): Promise<MuxSession> {
    const session = await this.server.newSession({ name, startDirectory: cwd });
    return { id: session.id, name: session.name ?? name, projectId: null, viewer: false };
  }

  async tagSession(sessionId: string, projectId: number): Promise<void> {
    await this.server.cmd("set-option", ["-t", sessionId, PROJECT_OPTION, String(projectId)]);
  }

  async newWindow(w: NewWindow): Promise<MuxWindow> {
    const args = ["-d", "-P", "-F", "#{window_id}", "-t", `${w.sessionId}:`, "-n", w.name, "-c", w.cwd];
    for (const [key, value] of Object.entries(w.env)) args.push("-e", `${key}=${value}`);
    args.push(windowCommand(w.argv));
    const [id] = await this.server.cmd("new-window", args);
    if (!id) throw new MuxError("tmux new-window printed no window id");
    return { id: id.trim(), sessionId: w.sessionId, name: w.name, taskId: null };
  }

  async tagWindow(windowId: string, taskId: number): Promise<void> {
    await this.server.cmd("set-option", ["-w", "-t", windowId, TASK_OPTION, String(taskId)]);
  }

  async killWindow(windowId: string): Promise<void> {
    await this.server.cmd("kill-window", ["-t", windowId]);
  }

  async killSession(sessionId: string): Promise<void> {
    await this.server.cmd("kill-session", ["-t", sessionId]);
  }

  async moveWindow(windowId: string, sessionId: string): Promise<void> {
    await this.server.cmd("move-window", ["-d", "-s", windowId, "-t", `${sessionId}:`]);
  }

  async sendLine(windowId: string, text: string): Promise<void> {
    await this.server.cmd("send-keys", ["-t", windowId, "-l", text]);
    await this.server.cmd("send-keys", ["-t", windowId, "Enter"]);
  }

  async switchClient(windowId: string): Promise<void> {
    await this.server.cmd("switch-client", ["-t", windowId]);
  }

  viewerArgv(viewerName: string, sessionId: string, windowId: string): string[] {
    // One client process creates the grouped session and attaches to it; the
    // options make it a plain view: no status bar, no prefix (keys reach
    // claude), gone as soon as aug detaches. aug itself may run inside tmux,
    // which refuses to nest while TMUX is set.
    return [
      "env", "-u", "TMUX",
      ...this.tmuxArgs(),
      "new-session", "-t", sessionId, "-s", viewerName,
      ";", "set-option", "status", "off",
      ";", "set-option", "prefix", "None",
      ";", "set-option", "destroy-unattached", "on",
      ";", "select-window", "-t", windowId,
    ];
  }

  async branchExists(repoPath: string, branch: string): Promise<boolean> {
    for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
      const proc = Bun.spawn(["git", "-C", repoPath, "rev-parse", "--verify", "--quiet", ref], {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
      if ((await proc.exited) === 0) return true;
    }
    return false;
  }

  async worktree(w: Worktree): Promise<MadeWorktree> {
    const argv = fillTemplate(loadConfig().worktreeCommand, {
      repo_path: w.repoPath,
      create: w.create ? "-c" : "",
      branch: w.branch,
    });
    const proc = Bun.spawn(argv, {
      cwd: w.repoPath,
      env: { ...process.env, ...w.env },
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      // pre-start hooks (installing deps) run before this returns.
      timeout: WT_TIMEOUT_MS,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0)
      throw new MuxError(stderr.trim().split("\n").pop() || `${argv[0]} exited ${code}`);
    const made = parseWorktree(stdout);
    if (!made) throw new MuxError(`no worktree path in: ${stdout.trim().slice(0, 200)}`);
    return made;
  }

  async removeWorktree(repoPath: string, branch: string): Promise<void> {
    const proc = Bun.spawn(["wt", "-C", repoPath, "remove", branch, "-y"], {
      stdout: "ignore",
      stderr: "pipe",
      stdin: "ignore",
      timeout: WT_TIMEOUT_MS,
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0)
      throw new MuxError(stderr.trim().split("\n").pop() || `wt remove exited ${code}`);
  }
}

let current: Mux | undefined;

export function mux(): Mux {
  current ??= new TmuxMux();
  return current;
}

export function setMux(next: Mux): void {
  current = next;
}
