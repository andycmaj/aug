// The one door to tmux, worktrunk and the checkouts on disk. tmux owns every coding agent's claude,
// so it outlives Riker and you can reach it from any client; Riker only tags what
// it made and reads the tags back. Identity is the @riker_project / @riker_task
// user options, never a name, so renaming a session or window breaks nothing.
// Only this file imports libtmux (alpha, pinned exactly): its API churn and
// any macOS trouble stay here. Tests swap in a fake with setMux.

import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { Server, TmuxServerRestartedError } from "libtmux";
import { perfOn, perfStart } from "./perf";
import { inspect, scan, type CheckoutState, type FoundCheckout } from "./checkouts";
import { logger } from "./log";
import { CMD, LEGACY, legacyOption, NAME, option, optionFormat } from "./brand";
import { shellQuote, toolsCommand } from "./self";

const log = logger("mux");

export const PROJECT_OPTION = option("project");
export const TASK_OPTION = option("task");
// How a script in a task's pane calls riker-tools: a hand-started claude has no
// RIKER_* env, but its window carries this beside the task tag.
export const TOOLS_OPTION = option("tools");
// Tags aug wrote before the rename: read when the new one is not set yet, and
// copied over by copyLegacyTags (core/migrate-home.ts, and the engine's start).
const CLIENT_OPTION = option("client");
const PROJECT_READ = optionFormat("project");
const TASK_READ = optionFormat("task");

export interface MuxSession {
  id: string;
  name: string;
  projectId: number | null;
  // Riker's own viewers, never offered for adoption.
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
// shows wherever that window does, Riker's viewer included, instead of in a
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
  // config's worktreeCommand: {repo_path}, {create} and {branch} filled in.
  command: string;
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
  // Gives every session and window aug tagged before the rename (@aug_*) the
  // same tags under Riker's names, leaving ones already tagged alone.
  // Answers how many it tagged.
  copyLegacyTags(): Promise<number>;
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
  // Moves your own tmux client (the one Riker runs in) to the session, or to
  // one of its windows. The session is named because a viewer links the
  // same window, and tmux would otherwise land you in the viewer.
  // It also tells that client, on its status line, how to get back to Riker.
  switchClient(sessionId: string, windowId?: string): Promise<void>;
  // The shell line that attaches a terminal to the session (or one of its
  // windows), for when Riker is not in a client of this server to move.
  attachCommand(sessionId: string, windowId?: string): string;
  // argv for the embedded terminal: attaches a session of its own holding
  // just that window, so showing it never moves your real client.
  viewerArgv(viewerName: string, sessionId: string, windowId: string): string[];
  paneInfo(paneId: string): Promise<PaneInfo | null>;
  // The window Riker itself runs in, when that is on this server: a viewer of
  // it would show Riker showing the viewer, nested without end.
  hostWindow(): Promise<string | null>;
  // Where Riker's own terminal is, which says whether a jump can move it.
  hostServer(): Promise<HostServer>;
  // The running server's version (not the tmux on PATH: an upgrade leaves the
  // old server up until it is killed), or null with no server.
  version(): Promise<string | null>;
  // Calls onChange when windows or sessions come and go, until the signal
  // aborts or the server goes away. Resolves at once with no server.
  watch(onChange: () => void, signal: AbortSignal): Promise<void>;
  // A local or origin branch by that name.
  branchExists(repoPath: string, branch: string): Promise<boolean>;
  // Whether the branch's work has landed in the repo's base branch: the base
  // it landed in, false if it has not, null when git cannot say (no such
  // branch, no reflog to tell where it started).
  branchMerged(repoPath: string, branch: string): Promise<string | false | null>;
  // How many of the branch's commits are not in the base (the local one or
  // origin's, whichever is ahead), null when git cannot say. A squash merge
  // still counts its commits: ask branchMerged first.
  branchAhead(repoPath: string, branch: string): Promise<number | null>;
  // What branchMerged's answer rests on, per branch, in one cheap read: the
  // base's name and tips and the branch's tip. Same key, same answer; a
  // branch with no tip is left out (branchMerged would say null). Null when
  // git cannot read the repo.
  mergeKeys(repoPath: string, branches: string[]): Promise<Map<string, string> | null>;
  // What is at a path: gone, a checkout and its GitHub repos, a worktree.
  inspectCheckout(path: string): CheckoutState;
  // Main checkouts under the roots, depth folders down.
  findCheckouts(roots: string[], depth: number): Promise<FoundCheckout[]>;
  // gh repo clone into dest.
  clone(repo: string, dest: string): Promise<void>;
  // Makes the worktree and answers its path.
  worktree(w: Worktree): Promise<MadeWorktree>;
  removeWorktree(repoPath: string, branch: string): Promise<void>;
}

export class MuxError extends Error {}

// ── shell helpers ────────────────────────────────────────────────────────

// Well under tmux's ~16KB command, with the target and flags beside it.
const SEND_KEYS_MAX = 8000;

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
const GIT_TIMEOUT_MS = 10_000;

type Git = (...args: string[]) => Promise<string | null>;

function gitIn(repoPath: string): Git {
  return async (...args) => {
    const proc = Bun.spawn(["git", "-C", repoPath, ...args], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
      timeout: GIT_TIMEOUT_MS,
    });
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return code === 0 ? out.trim() : null;
  };
}

// The repo's base (origin's HEAD, else main), its local and origin tips, and
// each branch's tip, in two calls. A pattern also matches refs under it
// (refs/heads/main/x), so only exact names count. Null when the listing
// fails.
async function baseTips(
  git: Git,
  branches: string[],
): Promise<{ base: string; local?: string; remote?: string; tips: Map<string, string> } | null> {
  const head = await git("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
  const base = head?.replace(/^origin\//, "") || "main";
  const localRef = `refs/heads/${base}`;
  const remoteRef = `refs/remotes/origin/${base}`;
  const wanted = new Set(branches.map((b) => `refs/heads/${b}`));
  const listed = await git("for-each-ref", "--format=%(refname) %(objectname)", localRef, remoteRef, ...wanted);
  if (listed === null) return null;
  let local: string | undefined;
  let remote: string | undefined;
  const tips = new Map<string, string>();
  for (const line of listed.split("\n")) {
    const [ref, sha] = line.split(" ");
    if (!ref || !sha) continue;
    if (ref === localRef) local = sha;
    if (ref === remoteRef) remote = sha;
    if (wanted.has(ref)) tips.set(ref.slice("refs/heads/".length), sha);
  }
  return { base, local, remote, tips };
}
// A big repo over a slow link.
const CLONE_TIMEOUT_MS = 10 * 60_000;

// ── tmux ─────────────────────────────────────────────────────────────────

const SEP = "\t";
const SESSION_FORMAT = ["#{session_id}", "#{session_name}", PROJECT_READ].join(SEP);
const WINDOW_FORMAT = [
  "#{window_id}",
  "#{session_id}",
  "#{window_name}",
  TASK_READ,
].join(SEP);

export const VIEWER_PREFIX = `${CMD}-view-`;
// An aug from before the rename may still have a viewer session open.
const LEGACY_VIEWER_PREFIX = `${LEGACY.cmd}-view-`;
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

// tmux 3.7's pane status drawing wraps a column below zero and loops for
// hours on a split window shown to two clients of different sizes, which is
// what an embedded viewer beside your own terminal makes (pane-border-status
// on). 3.8 rewrote that code. test/mux-tmux.test.ts checks this against the
// tmux it runs on.
export function viewerMayHang(version: string | null): boolean {
  return version?.startsWith("3.7") ?? false;
}

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

// Shown on your client after a jump. #{prefix} is your prefix key.
export const BACK_TO_RIKER = `${CMD}: #{prefix} L goes back to ${NAME}`;

// "none": Riker is not in tmux. "other": it is in a client of another
// server than its agents'. lost: that server is alive at this very socket
// path but no longer owns it (its socket file was deleted and a second
// server started there), so nothing can reach it by path.
export type HostServer =
  | { at: "here"; windowId: string }
  | { at: "none" }
  | { at: "other"; socket: string; lost: boolean };

// $TMUX is "socket path,server pid,session".
function hostFromEnv(tmux = process.env.TMUX): { path: string; pid: number } | null {
  const [path, raw] = (tmux ?? "").split(",");
  const pid = Number(raw);
  return path && Number.isInteger(pid) && pid > 0 ? { path, pid } : null;
}

// /tmp is /private/tmp on macOS. The socket file itself may be gone, so
// only its directory is resolved.
function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return join(realpathSync(dirname(p)), basename(p));
    } catch {
      return p;
    }
  };
  return real(a) === real(b);
}

function isTmux(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const run = Bun.spawnSync(["ps", "-o", "comm=", "-p", String(pid)], { stderr: "ignore" });
  return run.exitCode === 0 && /tmux/.test(run.stdout.toString());
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

  // A name is config's tmuxSocket; none is your default server.
  constructor(socket?: TmuxSocket | string) {
    this.socket = typeof socket === "object" ? socket : { socketName: socket };
    this.server = this.connect();
  }

  private connect(): Server {
    const { socketName, socketPath } = this.socket;
    return new Server(
      socketPath ? { socketPath } : socketName ? { socketName } : {},
    );
  }

  // Where tmux puts this server's socket: -S as given, else
  // $TMUX_TMPDIR (or /tmp)/tmux-<uid>/<-L name or default>.
  private socketFile(): string {
    const { socketName, socketPath } = this.socket;
    if (socketPath) return socketPath;
    const dir = process.env.TMUX_TMPDIR || "/tmp";
    return join(dir, `tmux-${process.getuid?.() ?? 0}`, socketName ?? "default");
  }

  // A live server's socket file can be deleted under it (macOS cleans /tmp,
  // a stray rm): the server runs on, unreachable, and the next new-session
  // starts a second server at the same path. Riker's own client is then on
  // one server and its agents on the other, and no jump can cross. When the
  // server Riker runs in is the one missing from this path, SIGUSR1 makes
  // tmux remake its socket (tmux(1)), so Riker reaches it again instead.
  private async reviveHost(): Promise<void> {
    const host = hostFromEnv();
    const path = this.socketFile();
    if (!host || existsSync(path) || !samePath(host.path, path) || !isTmux(host.pid)) return;
    log.info("tmux socket gone; asking Riker's own server to remake it", { pid: host.pid, path });
    try {
      process.kill(host.pid, "SIGUSR1");
    } catch (err) {
      log.warn("could not signal tmux", { pid: host.pid, err: String(err) });
      return;
    }
    for (let i = 0; i < 40 && !existsSync(path); i++) await Bun.sleep(25);
  }

  // libtmux pins ids to the daemon it first met and refuses (before running
  // anything) once that tmux server has restarted; meet the new one.
  private async retry<T>(run: (server: Server) => Promise<T>): Promise<T> {
    await this.reviveHost();
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
          TASK_READ,
          PROJECT_READ,
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

  async version(): Promise<string | null> {
    try {
      const [line] = await this.cmd("display-message", ["-p", "#{version}"]);
      return line?.trim() || null;
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

  async hostServer(): Promise<HostServer> {
    const host = hostFromEnv();
    if (!host || !process.env.TMUX_PANE) return { at: "none" };
    const windowId = await this.hostWindow();
    if (windowId) return { at: "here", windowId };
    // Its pid answered for no server here, though the path is this one's.
    const lost = samePath(host.path, this.socketFile()) && isTmux(host.pid);
    return { at: "other", socket: host.path, lost };
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
        viewer: name.startsWith(VIEWER_PREFIX) || name.startsWith(LEGACY_VIEWER_PREFIX),
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

  async copyLegacyTags(): Promise<number> {
    let sessionLines: readonly string[];
    let windowLines: readonly string[];
    try {
      sessionLines = await this.cmd("list-sessions", [
        "-F",
        ["#{session_id}", `#{${PROJECT_OPTION}}`, `#{${legacyOption("project")}}`].join(SEP),
      ]);
      windowLines = await this.cmd("list-windows", [
        "-a",
        "-F",
        ["#{window_id}", `#{${TASK_OPTION}}`, `#{${legacyOption("task")}}`].join(SEP),
      ]);
    } catch (err) {
      if (noServer(err)) return 0;
      throw err;
    }
    let tagged = 0;
    for (const line of sessionLines) {
      const [id, now, old] = line.split(SEP);
      if (!id || now || !idOf(old)) continue;
      await this.tagSession(id, idOf(old)!);
      tagged++;
    }
    // A window linked into a viewer is listed twice.
    const seen = new Set<string>();
    for (const line of windowLines) {
      const [id, now, old] = line.split(SEP);
      if (!id || seen.has(id) || now || !idOf(old)) continue;
      seen.add(id);
      // @riker_tools from this Riker, not aug's copy (its path is gone).
      await this.tagWindow(id, idOf(old)!);
      tagged++;
    }
    return tagged;
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
    if (Buffer.byteLength(text) <= SEND_KEYS_MAX) await this.cmd("send-keys", ["-t", target, "-l", text]);
    else await this.paste(target, text);
    await this.cmd("send-keys", ["-t", target, "Enter"]);
  }

  // tmux refuses a command past about 16KB, send-keys' text included, but
  // load-buffer reads stdin in pieces: no file, and no limit. -p pastes as a
  // paste (bracketed, when the program asked for that), so claude takes it
  // whole; -d drops the buffer after.
  private async paste(target: string, text: string): Promise<void> {
    const buffer = `riker-${randomUUID()}`;
    const proc = Bun.spawn([...this.tmuxArgs(), "load-buffer", "-b", buffer, "-"], {
      stdin: new TextEncoder().encode(text),
      stdout: "ignore",
      stderr: "pipe",
    });
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new MuxError(`tmux load-buffer failed: ${err.trim() || `exit ${code}`}`);
    await this.cmd("paste-buffer", ["-d", "-p", "-b", buffer, "-t", target]);
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
    // Named before the switch: tmux finds "the current client" through the
    // session Riker's pane is in, and once moved that client is not in it, so
    // the message after would go to whichever client tmux likes (a viewer).
    const [client] = await this.cmd("display-message", ["-p", "#{client_name}"]);
    const target = windowId ? `${sessionId}:${windowId}` : sessionId;
    const on = client?.trim() ? ["-c", client.trim()] : [];
    await this.cmd("switch-client", [...on, "-t", target]);
    // switch-client -l (prefix L) is tmux's own "last session": Riker's.
    await this.cmd("display-message", [...on, "-d", "5000", BACK_TO_RIKER]).catch(
      (err: unknown) => log.debug("back-to-riker message failed", { err: String(err) }),
    );
  }

  attachCommand(sessionId: string, windowId?: string): string {
    const target = windowId ? `${sessionId}:${windowId}` : sessionId;
    return [...this.tmuxArgs(), "attach", "-t", target].map(shellQuote).join(" ");
  }

  viewerArgv(viewerName: string, sessionId: string, windowId: string): string[] {
    // One client process makes a session of its own, links the task's window
    // into it and drops the placeholder, so the session holds claude and
    // nothing else. Linked, not grouped: tmux 3.7's choose-tree draws nothing
    // at all while any session group exists. The options make it a plain
    // view: no status bar, no prefix (keys reach claude), gone as soon as Riker
    // detaches. Riker itself may run inside tmux, which refuses to nest while
    // TMUX is set.
    // It is still an ordinary session, the most recent one, so a bare
    // `tmux a`, switch-client or a destroyed session can drop your own
    // terminal in here with no prefix (and keep it alive past Riker). Any
    // client but Riker's is sent on to the project session. In a hook,
    // client_name is the session's most recent client (usually Riker's), so
    // the one that came in is hook_client, and only run-shell -C expands it
    // for -c. The id is escaped because tmux expands $VARS when the hook
    // runs.
    const bounce =
      `if -F "#{!=:#{hook_client},#{${CLIENT_OPTION}}}" ` +
      `"run-shell -C \\"switch-client -c '#{hook_client}' -t '${sessionId.replaceAll("$", "\\\\$")}'\\""`;
    const placeholder = `${CMD}-placeholder`;
    return [
      "env", "-u", "TMUX",
      ...this.tmuxArgs(),
      // cat holds the window open without starting your shell.
      "new-session", "-s", viewerName, "-n", placeholder, "cat",
      ";", "set-option", "status", "off",
      ";", "set-option", "prefix", "None",
      ";", "set-option", "destroy-unattached", "on",
      ";", "set-option", "-F", CLIENT_OPTION, "#{client_name}",
      // A program's OSC 52 clipboard read (nvim's, over ssh) goes unanswered
      // on tmux's defaults: set-clipboard external drops it, and get-clipboard
      // buffer replies only from a paste buffer, silent when there is none.
      // nvim then hangs 10s per paste. With these tmux asks the most recent
      // client's terminal, Riker's while you type in the viewer, and Riker
      // answers from the system clipboard. Both are server-wide, so only
      // tmux's defaults are changed and a value set on purpose is kept.
      ";", "if-shell", "-F", "#{==:#{set-clipboard},external}", "set-option -s set-clipboard on",
      ";", "if-shell", "-F", "#{==:#{get-clipboard},buffer}", "set-option -s get-clipboard request",
      ";", "set-hook", "client-attached", bounce,
      ";", "set-hook", "client-session-changed", bounce,
      ";", "link-window", "-s", windowId, "-t", `=${viewerName}:`,
      ";", "kill-window", "-t", `=${viewerName}:=${placeholder}`,
    ];
  }

  // The control client attaches to a session of Riker's own, so none of your
  // panes' output streams into Riker; tmux still reports structural changes
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

  // A branch with work on it (its tip is not where it was created) whose
  // tip is in base, or whose squash is: the commit-tree of its tree on the
  // merge base, which git cherry finds already applied (git-delete-squashed).
  // The base is the local one or origin's, whichever is ahead: a PR merged
  // on GitHub reaches origin/<base> with any fetch, while the checkout's own
  // <base> waits for the owner's pull. Nothing here fetches.
  async branchMerged(repoPath: string, branch: string): Promise<string | false | null> {
    const git = gitIn(repoPath);
    const read = await baseTips(git, [branch]);
    if (!read) return null;
    const { base, local, remote } = read;
    const tip = read.tips.get(branch);
    if (!tip || (!local && !remote)) return null;
    let baseTip = (local ?? remote)!;
    let into = local ? base : `origin/${base}`;
    if (local && remote && local !== remote) {
      if ((await git("merge-base", "--is-ancestor", local, remote)) !== null) {
        baseTip = remote;
        into = `origin/${base}`;
      }
    }
    const created = (await git("reflog", "show", "--format=%H", `refs/heads/${branch}`))
      ?.split("\n")
      .filter(Boolean)
      .at(-1);
    if (!created) return null;
    if (created === tip) return false;
    if ((await git("merge-base", "--is-ancestor", tip, baseTip)) !== null) return into;
    const forkPoint = await git("merge-base", baseTip, tip);
    const tree = await git("rev-parse", `${tip}^{tree}`);
    if (!forkPoint || !tree) return false;
    const squash = await git("commit-tree", tree, "-p", forkPoint, "-m", "riker: squash check");
    if (!squash) return false;
    const cherry = await git("cherry", baseTip, squash);
    return cherry?.startsWith("-") ? into : false;
  }

  async branchAhead(repoPath: string, branch: string): Promise<number | null> {
    const git = gitIn(repoPath);
    const read = await baseTips(git, [branch]);
    const tip = read?.tips.get(branch);
    if (!read || !tip || (!read.local && !read.remote)) return null;
    let baseTip = (read.local ?? read.remote)!;
    if (read.local && read.remote && read.local !== read.remote)
      if ((await git("merge-base", "--is-ancestor", read.local, read.remote)) !== null) baseTip = read.remote;
    const count = await git("rev-list", "--count", `${baseTip}..${tip}`);
    return count === null ? null : Number(count);
  }

  async mergeKeys(repoPath: string, branches: string[]): Promise<Map<string, string> | null> {
    const read = await baseTips(gitIn(repoPath), branches);
    if (!read) return null;
    const keys = new Map<string, string>();
    for (const [branch, tip] of read.tips)
      keys.set(branch, `${tip} ${read.base} ${read.local ?? "-"} ${read.remote ?? "-"}`);
    return keys;
  }

  inspectCheckout(path: string): CheckoutState {
    return inspect(path);
  }

  findCheckouts(roots: string[], depth: number): Promise<FoundCheckout[]> {
    return scan(roots, depth);
  }

  async clone(repo: string, dest: string): Promise<void> {
    const proc = Bun.spawn(["gh", "repo", "clone", repo, dest], {
      stdout: "ignore",
      stderr: "pipe",
      stdin: "ignore",
      timeout: CLONE_TIMEOUT_MS,
    });
    const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0)
      throw new MuxError(stderr.trim().split("\n").pop() || `gh repo clone exited ${code}`);
  }

  async worktree(w: Worktree): Promise<MadeWorktree> {
    const argv = fillTemplate(w.command, {
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
      throw new MuxError(wtError(stderr, `${argv[0]} exited ${code}`));
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
    if (code !== 0) throw new MuxError(wtError(stderr, `wt remove exited ${code}`));
  }
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

// wt puts the reason on a ✗ line, the files it is about indented under it,
// and a ↳ hint last: the last line alone is the hint, which hid the reason
// ("To list branches, run ..." for a branch that is gone).
export function wtError(stderr: string, fallback: string): string {
  let reason = "";
  const detail: string[] = [];
  const hints: string[] = [];
  for (const raw of stderr.replace(ANSI, "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("↳")) hints.push(line.slice(1).trim());
    else if (line.startsWith("✗")) reason = line.slice(1).trim();
    else if (!reason) reason = line;
    else detail.push(line);
  }
  if (!reason) return hints.join(" ") || fallback;
  const head = detail.length ? `${reason} (${detail.join(", ")})` : reason;
  return [head, ...hints].join(". ");
}

// Every call to the real tmux is timed while perf is on, as mux.<method>.
// watch is left alone: it runs until aborted, so its length says nothing.
export function timedMux(inner: Mux): Mux {
  const wrapped = new Map<string, unknown>();
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string" || prop === "watch") return value;
      const known = wrapped.get(prop);
      if (known) return known;
      const fn = value as (...args: unknown[]) => unknown;
      const op = `mux.${prop}`;
      const call = (...args: unknown[]): unknown => {
        if (!perfOn()) return fn.apply(target, args);
        const done = perfStart(op);
        try {
          const out = fn.apply(target, args);
          if (out instanceof Promise) return out.finally(() => done());
          done();
          return out;
        } catch (err) {
          done({ ok: false });
          throw err;
        }
      };
      wrapped.set(prop, call);
      return call;
    },
  });
}

let current: Mux | undefined;

export function mux(): Mux {
  current ??= timedMux(new TmuxMux());
  return current;
}

// The real tmux is timed; a test's fake is used as given.
export function setMux(next: Mux): void {
  current = next instanceof TmuxMux ? timedMux(next) : next;
}
