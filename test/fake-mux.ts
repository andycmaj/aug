import type {
  Mux,
  MuxSession,
  MuxState,
  MuxWindow,
  MadeWorktree,
  NewWindow,
  PaneInfo,
  Worktree,
} from "../src/core/mux";

// tmux and wt in memory. Records what aug asked for so tests can read it.
export class FakeMux implements Mux {
  sessions: MuxSession[] = [];
  windows: (MuxWindow & { cwd: string; env: Record<string, string>; argv: string[] })[] = [];
  worktrees: (Worktree & { path: string })[] = [];
  removed: { repoPath: string; branch: string }[] = [];
  sent: { windowId: string; text: string }[] = [];
  switched: string[] = [];
  removeFails: string | null = null;
  branches = new Set<string>();
  private next = 0;

  async state(): Promise<MuxState> {
    return {
      sessions: this.sessions.map((s) => ({ ...s })),
      windows: this.windows.map(({ id, sessionId, name, taskId }) => ({
        id,
        sessionId,
        name,
        taskId,
      })),
    };
  }

  async newSession(name: string): Promise<MuxSession> {
    const session = { id: `$${this.next++}`, name, projectId: null, viewer: false };
    this.sessions.push(session);
    return { ...session };
  }

  async tagSession(sessionId: string, projectId: number): Promise<void> {
    const s = this.sessions.find((s) => s.id === sessionId);
    if (!s) throw new Error(`no session ${sessionId}`);
    s.projectId = projectId;
  }

  async newWindow(w: NewWindow): Promise<MuxWindow> {
    const window = {
      id: `@${this.next++}`,
      sessionId: w.sessionId,
      name: w.name,
      taskId: null,
      cwd: w.cwd,
      env: w.env,
      argv: w.argv,
    };
    this.windows.push(window);
    return { id: window.id, sessionId: w.sessionId, name: w.name, taskId: null };
  }

  async tagWindow(windowId: string, taskId: number): Promise<void> {
    const w = this.windows.find((w) => w.id === windowId);
    if (!w) throw new Error(`no window ${windowId}`);
    w.taskId = taskId;
  }

  async killWindow(windowId: string): Promise<void> {
    this.windows = this.windows.filter((w) => w.id !== windowId);
  }

  async killSession(sessionId: string): Promise<void> {
    this.sessions = this.sessions.filter((s) => s.id !== sessionId);
    this.windows = this.windows.filter((w) => w.sessionId !== sessionId);
  }

  async moveWindow(windowId: string, sessionId: string): Promise<void> {
    const w = this.windows.find((w) => w.id === windowId);
    if (w) w.sessionId = sessionId;
  }

  async sendLine(windowId: string, text: string): Promise<void> {
    this.sent.push({ windowId, text });
  }

  async switchClient(windowId: string): Promise<void> {
    this.switched.push(windowId);
  }

  viewerArgv(viewerName: string, sessionId: string, windowId: string): string[] {
    return ["tmux", "new-session", "-t", sessionId, "-s", viewerName, ";", "select-window", "-t", windowId];
  }

  // In the fake a pane id is its window id.
  async paneInfo(paneId: string): Promise<PaneInfo | null> {
    const w = this.windows.find((w) => w.id === paneId);
    if (!w) return null;
    const s = this.sessions.find((s) => s.id === w.sessionId);
    return {
      windowId: w.id,
      windowName: w.name,
      sessionId: w.sessionId,
      taskId: w.taskId,
      projectId: s?.projectId ?? null,
    };
  }

  async branchExists(_repoPath: string, branch: string): Promise<boolean> {
    return this.branches.has(branch);
  }

  async worktree(w: Worktree): Promise<MadeWorktree> {
    const branch = w.branch.startsWith("pr:") ? `pr-head-${w.branch.slice(3)}` : w.branch;
    const path = `${w.repoPath}.${branch}`;
    this.worktrees.push({ ...w, path });
    return { path, branch };
  }

  async removeWorktree(repoPath: string, branch: string): Promise<void> {
    if (this.removeFails) throw new Error(this.removeFails);
    this.removed.push({ repoPath, branch });
  }
}
