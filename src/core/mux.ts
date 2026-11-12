// The one door to tmux and worktrunk. tmux owns every coding agent's claude,
// so it outlives aug and you can reach it from any client; aug only tags what
// it made and reads the tags back. Identity is the @aug_project / @aug_task
// user options, never a name, so renaming a session or window breaks nothing.
// Only this file imports libtmux (alpha, pinned exactly): its API churn and
// any macOS trouble stay here. Tests swap in a fake with setMux.

import { Server, TmuxServerRestartedError } from "libtmux";
import { loadConfig } from "./config";
import { logger } from "./log";
import { shellQuote, toolsCommand } from "./self";

const log = logger("mux");

export const PROJECT_OPTION = "@aug_project";
export const TASK_OPTION = "@aug_task";
// How a script in a task's pane calls aug-tools: a hand-started claude has no
// AUG_* env, but its window carries this beside the task tag.
export const TOOLS_OPTION = "@aug_tools";

export interface MuxSession {
  id: string;
  name: string;
  projectId: number | null;
  // aug's own viewers, never offered for adoption.
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
  sessionName: string;
  // The pane's own process (a shell, or claude itself), for telling which
  // server a process found outside tmux lives on.
  panePid: number;
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

// A pane split off a task's own window, so whatever it runs (a diff viewer)
// shows wherever that window does, aug's viewer included, instead of in a
// window of its own.
export interface SplitPane {
  paneId: string;
  cwd: string;
  argv: string[];
  // Fills the window until the command exits.
  zoom: boolean;
  // Gets the command's exit code, for a caller that waits on it.
  exitFile?: string;
}

export interface Worktree {
  repoPath: string;
  branch: string;
  create: boolean;
  env: Record<string, string>;
}

export interface Mux {
  // No tmux server running is an empty state, not an error. Strict throws
  // on any other failure (a timeout) rather than answering empty, for a
  // caller that would read empty as every window gone.
  state(opts?: { strict?: boolean }): Promise<MuxState>;
  newSession(name: string, cwd: string): Promise<MuxSession>;
  tagSession(sessionId: string, projectId: number): Promise<void>;
  newWindow(w: NewWindow): Promise<MuxWindow>;
  tagWindow(windowId: string, taskId: number): Promise<void>;
  killWindow(windowId: string): Promise<void>;
  killSession(sessionId: string): Promise<void>;
  // From names the session to take it out of: a viewer links the same
  // window, and tmux would otherwise pick whichever session it likes.
  moveWindow(windowId: string, fromSessionId: string, toSessionId: string): Promise<void>;
  // Types a line into the window's first pane (claude, even while a split
  // has focus), then Enter.
  sendLine(windowId: string, text: string): Promise<void>;
  // Answers the new pane's id.
  splitPane(s: SplitPane): Promise<string>;
  paneAlive(paneId: string): Promise<boolean>;
  // The panes of a window, or null when tmux has no such window.
  windowPanes(windowId: string): Promise<string[] | null>;
  // Moves your own tmux client (the one aug runs in) to the session, or to
  // one of its windows. The session is named because a viewer links the
  // same window, and tmux would otherwise land you in the viewer.
  switchClient(sessionId: string, windowId?: string): Promise<void>;
  // argv for the embedded terminal: attaches a session of its own holding
  // just that window, so showing it never moves your real client.
  viewerArgv(viewerName: string, sessionId: string, windowId: string): string[];
  paneInfo(paneId: string): Promise<PaneInfo | null>;
  // The window aug itself runs in, when that is on this server: a viewer of
  // it would show aug showing the viewer, nested without end.
  hostWindow(): Promise<string | null>;
  // Calls onChange when windows or sessions come and go, until the signal
  // aborts or the server goes away. Resolves at once with no server.
  watch(onChange: () => void, signal: AbortSignal): Promise<void>;
  // A local or origin branch by that name.
  branchExists(repoPath: string, branch: string): Promise<boolean>;
  // A mapped path can be a worktree that has since been removed.
  isCheckout(path: string): Promise<boolean>;
  // Makes the worktree and answers its path.
  worktree(w: Worktree): Promise<MadeWorktree>;
  removeWorktree(repoPath: string, branch: string): Promise<void>;
}

export class MuxError extends Error {}

// ── shell helpers ────────────────────────────────────────────────────────

// The window runs claude, then a login shell, so it stays open when claude
// exits and you can resume or look around.
export function windowCommand(argv: string[]): string {
  return `${argv.map(shellQuote).join(" ")}; exec "\${SHELL:-/bin/sh}" -l`;
}

// A split pane closes when its command exits; the exit code goes to a file
// first so the caller waiting on it can pass it on.
export function paneCommand(argv: string[], exitFile?: string): string {
  const command = argv.map(shellQuote).join(" ");
  return exitFile ? `${command}; echo $? > ${shellQuote(exitFile)}` : command;
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
const WATCH_PREFIX = `${VIEWER_PREFIX}watch-`;

// Structural changes worth a reconcile; pane output never is.
const WATCHED = new Set([
  "window-add",
  "window-close",
  "unlinked-window-add",
  "unlinked-window-close",
  "window-renamed",
  "unlinked-window-renamed",
  "session-renamed",
  "sessions-changed",
]);

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// tmux's own words when nothing listens on the socket.
function noServer(err: unknown): boolean {
  const text = err instanceof Error ? err.message : String(err);
  return /no server running|error connecting to/i.test(text);
}

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
    this.server = this.connect();
  }

  private connect(): Server {
    const { socketName, socketPath } = this.socket;
    return new Server(
      socketPath ? { socketPath } : socketName ? { socketName } : {},
    );
  }

  // libtmux pins ids to the daemon it first met and refuses (before running
  // anything) once that tmux server has restarted; meet the new one.
  private async retry<T>(run: (server: Server) => Promise<T>): Promise<T> {
    try {
      return await run(this.server);
    } catch (err) {
      if (!(err instanceof TmuxServerRestartedError)) throw err;
      this.server = this.connect();
      return run(this.server);
    }
  }

  private cmd(command: string, args: string[]): Promise<readonly string[]> {
    return this.retry((server) => server.cmd(command, args));
  }

  private tmuxArgs(): string[] {
    const { socketName, socketPath } = this.socket;
    if (socketPath) return ["tmux", "-S", socketPath];
    return socketName ? ["tmux", "-L", socketName] : ["tmux"];
  }

  async paneInfo(paneId: string): Promise<PaneInfo | null> {
    try {
      const [line] = await this.cmd("display-message", [
        "-p",
        "-t",
        paneId,
        [
          "#{pane_id}",
          "#{pane_pid}",
          "#{window_id}",
          "#{window_name}",
          "#{session_id}",
          "#{session_name}",
          `#{${TASK_OPTION}}`,
          `#{${PROJECT_OPTION}}`,
        ].join(SEP),
      ]);
      if (!line) return null;
      const [id, pid, windowId, windowName, sessionId, sessionName, task, project] =
        line.split(SEP);
      // tmux answers for the current pane when the named one is gone.
      if (id !== paneId) return null;
      return {
        windowId,
        windowName,
        sessionId,
        sessionName,
        panePid: Number(pid) || 0,
        taskId: idOf(task),
        projectId: idOf(project),
      };
    } catch {
      return null;
    }
  }

  async hostWindow(): Promise<string | null> {
    const pane = process.env.TMUX_PANE;
    const serverPid = process.env.TMUX?.split(",")[1];
    if (!pane || !serverPid) return null;
    try {
      // tmux answers for some other pane when this one is not on the server,
      // so both the server and the pane have to match.
      const [line] = await this.cmd("display-message", [
        "-p",
        "-t",
        pane,
        ["#{pid}", "#{pane_id}", "#{window_id}"].join(SEP),
      ]);
      const [pid, paneId, windowId] = (line ?? "").split(SEP);
      return pid === serverPid && paneId === pane && windowId ? windowId : null;
    } catch {
      return null;
    }
  }

  async state(opts: { strict?: boolean } = {}): Promise<MuxState> {
    let sessionLines: readonly string[];
    let windowLines: readonly string[];
    try {
      sessionLines = await this.cmd("list-sessions", ["-F", SESSION_FORMAT]);
      windowLines = await this.cmd("list-windows", ["-a", "-F", WINDOW_FORMAT]);
    } catch (err) {
      if (opts.strict && !noServer(err)) throw err;
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
    // A viewer lists its task's window again; report each window once,
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
    const session = await this.retry((server) =>
      server.newSession({ name, startDirectory: cwd }),
    );
    return { id: session.id, name: session.name ?? name, projectId: null, viewer: false };
  }

  async tagSession(sessionId: string, projectId: number): Promise<void> {
    await this.cmd("set-option", ["-t", sessionId, PROJECT_OPTION, String(projectId)]);
  }

  async newWindow(w: NewWindow): Promise<MuxWindow> {
    const args = ["-d", "-P", "-F", "#{window_id}", "-t", `${w.sessionId}:`, "-n", w.name, "-c", w.cwd];
    for (const [key, value] of Object.entries(w.env)) args.push("-e", `${key}=${value}`);
    args.push(windowCommand(w.argv));
    const [id] = await this.cmd("new-window", args);
    if (!id) throw new MuxError("tmux new-window printed no window id");
    return { id: id.trim(), sessionId: w.sessionId, name: w.name, taskId: null };
  }

  async tagWindow(windowId: string, taskId: number): Promise<void> {
    await this.cmd("set-option", ["-w", "-t", windowId, TASK_OPTION, String(taskId)]);
    await this.cmd("set-option", ["-w", "-t", windowId, TOOLS_OPTION, toolsCommand()]);
  }

  async killWindow(windowId: string): Promise<void> {
    await this.cmd("kill-window", ["-t", windowId]);
  }

  async killSession(sessionId: string): Promise<void> {
    await this.cmd("kill-session", ["-t", sessionId]);
  }

  async moveWindow(windowId: string, fromSessionId: string, toSessionId: string): Promise<void> {
    await this.cmd("move-window", ["-d", "-s", `${fromSessionId}:${windowId}`, "-t", `${toSessionId}:`]);
  }

  async sendLine(windowId: string, text: string): Promise<void> {
    // A bare window target is its active pane, which is a diff viewer while
    // one is split off; {top-left} is too, while that split is zoomed.
    const [first] = await this.cmd("list-panes", ["-t", windowId, "-F", "#{pane_id}"]);
    const target = first?.trim() || windowId;
    await this.cmd("send-keys", ["-t", target, "-l", text]);
    await this.cmd("send-keys", ["-t", target, "Enter"]);
  }

  async splitPane(s: SplitPane): Promise<string> {
    const args = ["-P", "-F", "#{pane_id}", "-t", s.paneId, "-c", s.cwd];
    if (s.zoom) args.push("-Z");
    args.push(paneCommand(s.argv, s.exitFile));
    const [id] = await this.cmd("split-window", args);
    if (!id) throw new MuxError("tmux split-window printed no pane id");
    return id.trim();
  }

  // display-message answers for a pane that is gone (it falls back to the
  // current one), so look for the id among the live ones.
  async paneAlive(paneId: string): Promise<boolean> {
    try {
      const panes = await this.cmd("list-panes", ["-a", "-F", "#{pane_id}"]);
      return panes.some((p) => p.trim() === paneId);
    } catch {
      return false;
    }
  }

  async windowPanes(windowId: string): Promise<string[] | null> {
    try {
      const panes = await this.cmd("list-panes", ["-t", windowId, "-F", "#{pane_id}"]);
      return panes.map((p) => p.trim()).filter(Boolean);
    } catch {
      return null;
    }
  }

  async switchClient(sessionId: string, windowId?: string): Promise<void> {
    await this.cmd("switch-client", ["-t", windowId ? `${sessionId}:${windowId}` : sessionId]);
  }

  viewerArgv(viewerName: string, sessionId: string, windowId: string): string[] {
    // One client process makes a session of its own, links the task's window
    // into it and drops the placeholder, so the session holds claude and
    // nothing else. Linked, not grouped: tmux 3.7's choose-tree draws nothing
    // at all while any session group exists. The options make it a plain
    // view: no status bar, no prefix (keys reach claude), gone as soon as aug
    // detaches. aug itself may run inside tmux, which refuses to nest while
    // TMUX is set.
    // It is still an ordinary session, the most recent one, so a bare
    // `tmux a`, switch-client or a destroyed session can drop your own
    // terminal in here with no prefix (and keep it alive past aug). Any
    // client but aug's is sent on to the project session. In a hook,
    // client_name is the session's most recent client (usually aug's), so
    // the one that came in is hook_client, and only run-shell -C expands it
    // for -c. The id is escaped because tmux expands $VARS when the hook
    // runs.
    const bounce =
      `if -F "#{!=:#{hook_client},#{@aug_client}}" ` +
      `"run-shell -C \\"switch-client -c '#{hook_client}' -t '${sessionId.replaceAll("$", "\\\\$")}'\\""`;
    const placeholder = "aug-placeholder";
    return [
      "env", "-u", "TMUX",
      ...this.tmuxArgs(),
      // cat holds the window open without starting your shell.
      "new-session", "-s", viewerName, "-n", placeholder, "cat",
      ";", "set-option", "status", "off",
      ";", "set-option", "prefix", "None",
      ";", "set-option", "destroy-unattached", "on",
      ";", "set-option", "-F", "@aug_client", "#{client_name}",
      ";", "set-hook", "client-attached", bounce,
      ";", "set-hook", "client-session-changed", bounce,
      ";", "link-window", "-s", windowId, "-t", `=${viewerName}:`,
      ";", "kill-window", "-t", `=${viewerName}:=${placeholder}`,
    ];
  }

  // The control client attaches to a session of aug's own, so none of your
  // panes' output streams into aug; tmux still reports structural changes
  // in every other session (the unlinked-* events).
  async watch(onChange: () => void, signal: AbortSignal): Promise<void> {
    const state = await this.state();
    if (state.sessions.length === 0) return;
    for (const s of state.sessions) {
      const pid = Number(s.name.slice(WATCH_PREFIX.length));
      if (s.name.startsWith(WATCH_PREFIX) && pid !== process.pid && !pidAlive(pid))
        await this.cmd("kill-session", ["-t", s.id]).catch(() => []);
    }
    const name = `${WATCH_PREFIX}${process.pid}`;
    const id =
      state.sessions.find((s) => s.name === name)?.id ??
      (await this.cmd("new-session", ["-d", "-P", "-F", "#{session_id}", "-s", name]))[0]?.trim();
    if (!id) return;
    const stream = this.server.watch({ target: id, signal });
    signal.addEventListener("abort", () => {
      void stream.close();
      void this.cmd("kill-session", ["-t", id]).catch(() => []);
    });
    try {
      for await (const event of stream) if (WATCHED.has(event.kind)) onChange();
    } finally {
      await stream.close();
    }
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

  async isCheckout(path: string): Promise<boolean> {
    const proc = Bun.spawn(["git", "-C", path, "rev-parse", "--git-dir"], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    return (await proc.exited) === 0;
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
