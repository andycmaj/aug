// Projects: one tmux session each, one window (and worktree, and claude) per
// task. tmux owns the processes; this module makes and tags them, keeps the
// DB in step with what tmux reports, and never trusts a name over a tag.

import { homedir } from "node:os";
import { codingCwd, codingLaunch, type CodingLaunch } from "./agents";
import { loadConfig, saveConfig } from "./config";
import { now } from "./db";
import { logger } from "./log";
import { mux, VIEWER_PREFIX, type MuxSession, type MuxState } from "./mux";
import { paths } from "./paths";
import * as store from "./store";
import {
  AgentState,
  SessionKind,
  TaskStatus,
  TurnRole,
  type ProjectRow,
  type SessionRow,
  type TaskRow,
} from "./types";

const log = logger("projects");

export function slug(text: string, max = 40): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/, "");
  return s || "task";
}

// Never take over a session you made: an untagged name in use gets a suffix.
export function freeSessionName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function repoPath(repo: string | null): string | null {
  if (!repo) return null;
  return loadConfig().github.repos[repo] ?? null;
}

export function mapRepo(repo: string, path: string): void {
  const config = loadConfig();
  saveConfig({
    ...config,
    github: { ...config.github, repos: { ...config.github.repos, [repo]: path } },
  });
}

// A coding task you made yourself has no repo yet: offer its project's repos
// first, then every mapped one.
export function repoChoices(task: TaskRow): string[] {
  const project = task.project_id ? store.getProject(task.project_id) : null;
  const ours = project ? store.projectRepos(project) : [];
  const mapped = Object.keys(loadConfig().github.repos);
  return [...new Set([...ours, ...mapped])];
}

export function setTaskRepo(taskId: number, repo: string): void {
  const clean = repo.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(clean))
    throw new Error(`${clean || "that"} is not owner/repo`);
  store.updateTask(taskId, { repo: clean });
}

// The env contract: every command aug spawns for a task carries these, so
// your own wt and tmux hooks can test $AUG and skip what aug already does.
export function augEnv(
  task: TaskRow,
  project: ProjectRow | null,
  branch: string | null,
): Record<string, string> {
  return {
    AUG: "1",
    AUG_HOME: paths.home(),
    AUG_TASK_ID: String(task.id),
    ...(project ? { AUG_PROJECT: String(project.id) } : {}),
    ...(branch ? { AUG_BRANCH: branch } : {}),
  };
}

// ── sessions ─────────────────────────────────────────────────────────────

function liveSessionFor(state: MuxState, projectId: number): MuxSession | null {
  return (
    state.sessions.find((s) => s.projectId === projectId && !s.viewer) ?? null
  );
}

export async function createProject(opts: {
  name: string;
  repo?: string | null;
  solo?: boolean;
}): Promise<ProjectRow> {
  const state = await mux().state();
  const name = freeSessionName(
    slug(opts.name),
    new Set(state.sessions.map((s) => s.name)),
  );
  const cwd = repoPath(opts.repo ?? null) ?? homedir();
  const session = await mux().newSession(name, cwd);
  const project = store.createProject({
    name: opts.name,
    tmuxSession: session.name,
    repos: opts.repo ? [opts.repo] : [],
    solo: opts.solo,
  });
  try {
    await mux().tagSession(session.id, project.id);
  } catch (err) {
    store.deleteProject(project.id);
    await mux().killSession(session.id).catch(() => {});
    throw err;
  }
  log.info("project created", { project: project.id, session: session.name });
  return project;
}

// Live sessions that are not projects yet and not aug's own viewers.
export async function adoptableSessions(): Promise<MuxSession[]> {
  const state = await mux().state();
  return state.sessions.filter((s) => !s.viewer && s.projectId === null);
}

export async function adoptSession(sessionId: string): Promise<ProjectRow> {
  const state = await mux().state();
  const session = state.sessions.find((s) => s.id === sessionId);
  if (!session) throw new Error(`no tmux session ${sessionId}`);
  if (session.projectId !== null)
    throw new Error(`${session.name} is already a project`);
  const project = store.createProject({
    name: session.name,
    tmuxSession: session.name,
  });
  try {
    await mux().tagSession(session.id, project.id);
  } catch (err) {
    store.deleteProject(project.id);
    throw err;
  }
  log.info("project adopted", { project: project.id, session: session.name });
  return project;
}

// The project's live session, made again (and re-tagged) if you killed it.
async function ensureSession(project: ProjectRow): Promise<MuxSession> {
  const state = await mux().state();
  const live = liveSessionFor(state, project.id);
  if (live) {
    if (live.name !== project.tmux_session)
      store.updateProject(project.id, { tmux_session: live.name });
    return live;
  }
  const name = freeSessionName(
    project.tmux_session,
    new Set(state.sessions.map((s) => s.name)),
  );
  const first = store.projectRepos(project)[0];
  const session = await mux().newSession(name, repoPath(first ?? null) ?? homedir());
  await mux().tagSession(session.id, project.id);
  store.updateProject(project.id, { tmux_session: session.name });
  return session;
}

// ── tasks ────────────────────────────────────────────────────────────────

export interface StartOptions {
  resume?: string;
  note?: string;
  branch?: string;
  // Set when the owner declined to map the task's repo: work in scratch.
  noWorktree?: boolean;
  launchOverride?: (task: TaskRow, launch: CodingLaunch) => CodingLaunch;
}

export type StartResult =
  | { type: "started"; session: SessionRow; windowId: string; project: ProjectRow }
  | { type: "needs-repo-path"; repo: string }
  | { type: "failed"; error: string };

export function defaultBranch(task: TaskRow): string {
  return slug(task.title);
}

export async function startTask(
  taskId: number,
  opts: StartOptions = {},
): Promise<StartResult> {
  let task = store.getTask(taskId);
  if (!task) return { type: "failed", error: `no task ${taskId}` };
  const path = repoPath(task.repo);
  if (
    task.repo &&
    !opts.noWorktree &&
    !task.worktree &&
    !(path && (await mux().isCheckout(path)))
  )
    return { type: "needs-repo-path", repo: task.repo };

  try {
    let project = task.project_id ? store.getProject(task.project_id) : null;
    if (!project || project.status !== "active") {
      project = await createProject({
        name: task.title,
        repo: task.repo,
        solo: true,
      });
      store.updateTask(task.id, { project_id: project.id });
    }
    const session = await ensureSession(project);

    // A claude still running keeps its window; one that has exited left a
    // shell behind, which a fresh window replaces.
    const latest = store.latestSession(task.id);
    const existing = await liveWindow(task.id);
    if (existing && latest?.kind === SessionKind.tmux && !latest.ended_at) {
      if (opts.note) await typeLine(existing, opts.note);
      return { type: "started", session: latest, windowId: existing, project };
    }
    if (existing) await mux().killWindow(existing);

    let cwd = task.worktree;
    let branch = task.branch;
    if (!cwd && path && !opts.noWorktree) {
      branch = opts.branch ?? task.branch ?? defaultBranch(task);
      // pr:N and branches that exist are switched to; anything else is new.
      const existing =
        branch.startsWith("pr:") || (await mux().branchExists(path, branch));
      const made = await mux().worktree({
        repoPath: path,
        branch,
        create: !existing,
        env: augEnv(task, project, branch),
      });
      cwd = made.path;
      branch = made.branch ?? branch;
      store.updateTask(task.id, { branch, worktree: cwd });
      if (task.repo) store.addProjectRepo(project.id, task.repo);
    }
    task = store.getTask(task.id)!;

    let launch = codingLaunch(task, { resume: opts.resume, note: opts.note });
    launch = { ...launch, cwd: cwd ?? codingCwd(task) };
    if (opts.launchOverride) launch = opts.launchOverride(task, launch);
    const window = await mux().newWindow({
      sessionId: session.id,
      name: branch ?? store.taskRef(task.id),
      cwd: launch.cwd,
      env: { ...augEnv(task, project, branch), ...launch.env },
      argv: launch.argv,
    });
    await mux().tagWindow(window.id, task.id);

    const row = recordStart(task, launch, window.id, opts.resume);
    return { type: "started", session: row, windowId: window.id, project };
  } catch (err) {
    log.error("start failed", { task: taskId, err });
    return { type: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

function recordStart(
  task: TaskRow,
  launch: CodingLaunch,
  windowId: string,
  resume: string | undefined,
): SessionRow {
  return store.batch(() => {
    if (resume && store.getSession(resume)) {
      store.updateSession(resume, {
        state: AgentState.working,
        ended_at: null,
        tmux_window: windowId,
        kind: SessionKind.tmux,
      });
    } else {
      store.createSession({
        id: launch.sessionId,
        taskId: task.id,
        kind: SessionKind.tmux,
        cwd: launch.cwd,
        startedBy: "owner",
        tmuxWindow: windowId,
      });
    }
    if (task.status !== TaskStatus.open) store.reopen(task.id);
    store.updateTask(task.id, {
      agent_state: AgentState.working,
      queue_reason: null,
      agent_says: null,
      unread_result: 0,
    });
    store.addTurn({
      taskId: task.id,
      role: TurnRole.trigger,
      body: resume
        ? "Continued the coding session"
        : `Started a coding session in ${launch.cwd}`,
    });
    return store.getSession(resume ?? launch.sessionId)!;
  });
}

// The window the task's claude lives in, if tmux still has it.
export async function liveWindow(taskId: number): Promise<string | null> {
  const state = await mux().state();
  return state.windows.find((w) => w.taskId === taskId)?.id ?? null;
}

// The window only while claude still runs in it: once claude exits, a shell
// is left behind, and a line typed there would run as a command.
export async function claudeWindow(taskId: number): Promise<string | null> {
  const latest = store.latestSession(taskId);
  if (latest?.kind !== SessionKind.tmux || latest.ended_at) return null;
  return liveWindow(taskId);
}

// A newline would submit claude's prompt halfway through.
function typeLine(windowId: string, text: string): Promise<void> {
  return mux().sendLine(windowId, text.replace(/\s*\n\s*/g, " ").trim());
}

export async function tell(taskId: number, text: string): Promise<boolean> {
  const window = await claudeWindow(taskId);
  if (!window) return false;
  await typeLine(window, text);
  return true;
}

// Stopping keeps the worktree and the claude session id: s resumes it in a
// fresh window.
export async function stopTask(taskId: number): Promise<void> {
  const state = await mux().state();
  for (const w of state.windows.filter((w) => w.taskId === taskId))
    await mux().killWindow(w.id);
  store.batch(() => {
    for (const s of store.sessionsForTask(taskId))
      if (s.kind === SessionKind.tmux && !s.ended_at)
        store.updateSession(s.id, { state: AgentState.saved, ended_at: now() });
    store.updateTask(taskId, { agent_state: AgentState.saved });
  });
}

export interface CloseResult {
  warnings: string[];
  archived: boolean;
}

// Closing a task: kill its window, remove its worktree (wt refuses on a
// dirty tree and keeps an unmerged branch), and archive a project-of-one
// left empty.
export async function closeTask(taskId: number): Promise<CloseResult> {
  const task = store.getTask(taskId);
  const result: CloseResult = { warnings: [], archived: false };
  if (!task) return result;
  const state = await mux().state();
  for (const w of state.windows.filter((w) => w.taskId === taskId)) {
    try {
      await mux().killWindow(w.id);
    } catch (err) {
      result.warnings.push(`kill window: ${String(err)}`);
    }
  }
  endTmuxSessions(taskId);
  const path = repoPath(task.repo);
  if (task.worktree && task.branch && path) {
    try {
      await mux().removeWorktree(path, task.branch);
      store.updateTask(taskId, { worktree: null });
    } catch (err) {
      result.warnings.push(
        `worktree kept: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (task.project_id) {
    const project = store.getProject(task.project_id);
    const open = store
      .tasksForProject(task.project_id)
      .filter((t) => t.id !== taskId && t.status === TaskStatus.open);
    if (project?.solo && open.length === 0) {
      await archive(project, state);
      result.archived = true;
    }
  }
  return result;
}

export function projectIsEmpty(projectId: number): boolean {
  return store
    .tasksForProject(projectId)
    .every((t) => t.status === TaskStatus.done || t.status === TaskStatus.dropped);
}

export async function archiveProject(projectId: number): Promise<void> {
  const project = store.getProject(projectId);
  if (!project) return;
  await archive(project, await mux().state());
}

// Windows go first: a viewer links one, and would otherwise keep it (and its
// claude) alive after the session is gone.
async function archive(project: ProjectRow, state: MuxState): Promise<void> {
  const live = liveSessionFor(state, project.id);
  if (live) {
    try {
      for (const w of state.windows.filter((w) => w.sessionId === live.id))
        await mux().killWindow(w.id);
      await mux().killSession(live.id);
    } catch (err) {
      log.warn("kill session failed", { project: project.id, err });
    }
  }
  for (const task of store.tasksForProject(project.id)) endTmuxSessions(task.id);
  store.archiveProject(project.id);
}

// Moving a task keeps its claude running: the window moves with it.
export async function moveTask(taskId: number, projectId: number): Promise<void> {
  const task = store.getTask(taskId);
  const target = store.getProject(projectId);
  if (!task || !target) return;
  const from = task.project_id ? store.getProject(task.project_id) : null;
  const session = await ensureSession(target);
  const state = await mux().state();
  for (const w of state.windows.filter((w) => w.taskId === taskId))
    await mux().moveWindow(w.id, w.sessionId, session.id);
  store.updateTask(taskId, { project_id: projectId });
  if (task.repo) store.addProjectRepo(projectId, task.repo);
  if (from?.solo && store.tasksForProject(from.id).length === 0)
    await archive(from, await mux().state());
}

export async function jump(taskId: number): Promise<boolean> {
  const state = await mux().state();
  const window = state.windows.find((w) => w.taskId === taskId);
  if (!window) return false;
  await mux().switchClient(window.sessionId, window.id);
  return true;
}

export async function nudge(taskId: number, text: string): Promise<boolean> {
  const window = await liveWindow(taskId);
  if (!window) return false;
  await mux().sendLine(window, text);
  return true;
}

// One viewer per task: each is a session holding just that task's window,
// so the Wall can show several agents of one project at once.
export async function jumpToProject(projectId: number): Promise<boolean> {
  const project = store.getProject(projectId);
  if (!project) return false;
  const session = await ensureSession(project);
  await mux().switchClient(session.id);
  return true;
}

export function viewerName(taskId: number): string {
  return `${VIEWER_PREFIX}${process.pid}-${taskId}`;
}

export type Viewer = { argv: string[] } | { refused: string };

export async function viewerArgv(taskId: number): Promise<Viewer | null> {
  const state = await mux().state();
  const window = state.windows.find((w) => w.taskId === taskId);
  if (!window) return null;
  // aug started in a pane of this very window would embed itself.
  if (window.id === (await mux().hostWindow()))
    return {
      refused: `aug is running in ${store.taskRef(taskId)}'s own tmux window, so it can't show it here. Run aug from another window.`,
    };
  // Strays land in the tagged project session, not whichever session listed it.
  const projectId = store.getTask(taskId)?.project_id;
  const session =
    (projectId ? liveSessionFor(state, projectId) : null)?.id ?? window.sessionId;
  const argv = mux().viewerArgv(viewerName(taskId), session, window.id);
  log.debug("viewer", { task: taskId, argv: argv.join(" ") });
  return { argv };
}

// ── reconcile ────────────────────────────────────────────────────────────

function endTmuxSessions(taskId: number): void {
  for (const s of store.sessionsForTask(taskId)) {
    if (s.kind === SessionKind.tmux && !s.ended_at) markGone(s);
  }
}

function markGone(session: SessionRow): void {
  const task = store.getTask(session.task_id);
  const finished = task?.agent_state === AgentState.agentdone;
  store.batch(() => {
    store.updateSession(session.id, {
      state: finished ? AgentState.agentdone : AgentState.stopped,
      ended_at: now(),
    });
    if (task && !finished && task.status === TaskStatus.open)
      store.updateTask(task.id, { agent_state: AgentState.stopped });
  });
}

// Live reconcile: tmux events, debounced, while aug runs. The watch ends
// when the server does (or never starts without one); the caller's poll
// starts it again.
export function watchTmux(
  onChange: () => void,
  signal: AbortSignal,
  debounceMs = 300,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };
  signal.addEventListener("abort", () => clearTimeout(timer));
  return mux().watch(changed, signal);
}

// tmux is the truth for whether a window lives: a session whose window is
// gone has stopped, and a project whose session was renamed gets the new
// name. Runs at boot, on watch events, and on a slow poll.
export async function reconcile(): Promise<void> {
  const state = await mux().state();
  const windows = new Set(state.windows.map((w) => w.id));
  for (const s of store.liveSessions()) {
    if (s.kind !== SessionKind.tmux) continue;
    if (!s.tmux_window || !windows.has(s.tmux_window)) markGone(s);
  }
  for (const project of store.listProjects()) {
    const live = liveSessionFor(state, project.id);
    if (live && live.name !== project.tmux_session)
      store.updateProject(project.id, { tmux_session: live.name });
  }
}
