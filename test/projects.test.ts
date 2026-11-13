import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, mergeConfig } from "../src/core/config";
import {
  fillTemplate,
  parseWorktree,
  setMux,
  windowCommand,
} from "../src/core/mux";
import { shellQuote } from "../src/core/self";
import {
  adoptSession,
  adoptableSessions,
  archiveProject,
  closeTask,
  createProject,
  endedElsewhere,
  freeSessionName,
  moveTask,
  nudge,
  reconcile,
  slug,
  startTask,
  viewerArgv,
  watchTmux,
} from "../src/core/projects";
import { repoChoices, setTaskRepo } from "../src/core/repos";
import * as store from "../src/core/store";
import { AgentState, Kind, SessionKind } from "../src/core/types";
import { FakeMux } from "./fake-mux";
import { freshHome } from "./helpers";

let fake: FakeMux;

beforeEach(() => {
  freshHome({
    github: { ...DEFAULT_CONFIG.github, repos: { "acme/api": "/src/api" } },
  });
  fake = new FakeMux();
  setMux(fake);
});

function codingTask(repo: string | null = "acme/api", title = "Fix login redirect") {
  return store.createTask({ title, kind: Kind.coding, channel: "github", repo });
}

describe("helpers", () => {
  test("slug and free names never take an existing session", () => {
    expect(slug("Fix the Login!! redirect")).toBe("fix-the-login-redirect");
    expect(slug("***")).toBe("task");
    expect(freeSessionName("api", new Set(["api", "api-2"]))).toBe("api-3");
    expect(freeSessionName("web", new Set(["api"]))).toBe("web");
  });

  test("worktree command template and its output", () => {
    expect(
      fillTemplate(DEFAULT_CONFIG.worktreeCommand, {
        repo_path: "/src/api",
        create: "",
        branch: "pr:12",
      }),
    ).toEqual(["wt", "-C", "/src/api", "switch", "pr:12", "--no-cd", "--format", "json", "-y"]);
    expect(
      parseWorktree('{"action":"created","branch":"feat-x","path":"/src/api.x","created_branch":true}'),
    ).toEqual({ path: "/src/api.x", branch: "feat-x" });
    expect(parseWorktree("making it\n/src/api.y\n")).toEqual({ path: "/src/api.y", branch: null });
    expect(parseWorktree("nothing here")).toBeNull();
  });

  test("window command quotes every argument and keeps a shell", () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    // What a hook command and a tmux window both pass bare.
    expect(shellQuote("AUG-12@host%x+y=z:a,b./c-d_e")).toBe("AUG-12@host%x+y=z:a,b./c-d_e");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(windowCommand(["claude", "--append-system-prompt", "a b"])).toBe(
      `claude --append-system-prompt 'a b'; exec "\${SHELL:-/bin/sh}" -l`,
    );
  });

  test("the old agentsAtOnce key still sets maxActiveAgents", () => {
    expect(mergeConfig({ agentsAtOnce: 2 } as never).maxActiveAgents).toBe(2);
    expect(mergeConfig({}).maxActiveAgents).toBe(4);
  });
});

describe("repo choices", () => {
  test("a coding task with no repo is offered its project's repos first, then mapped ones", async () => {
    freshHome({
      github: {
        ...DEFAULT_CONFIG.github,
        repos: { "acme/api": "/src/api", "acme/web": "/src/web" },
      },
    });
    const t = codingTask(null, "Spike");
    expect(repoChoices(t)).toEqual(["acme/api", "acme/web"]);
    const p = await createProject({ name: "Web", repo: "acme/web" });
    store.addProjectRepo(p.id, "acme/infra");
    store.updateTask(t.id, { project_id: p.id });
    expect(repoChoices(store.getTask(t.id)!)).toEqual(["acme/web", "acme/infra", "acme/api"]);
  });

  test("setting the repo lets start make a worktree", async () => {
    const t = codingTask(null, "Spike");
    setTaskRepo(t.id, "acme/api");
    const r = await startTask(t.id);
    expect(r.type).toBe("started");
    expect(fake.worktrees[0].repoPath).toBe("/src/api");
    expect(() => setTaskRepo(t.id, "not a repo")).toThrow("owner/repo");
  });
});

describe("projects", () => {
  test("a new project is a tagged session with a free name", async () => {
    fake.sessions.push({ id: "$9", name: "billing", projectId: null, viewer: false });
    const p = await createProject({ name: "Billing", repo: "acme/api" });
    expect(p.tmux_session).toBe("billing-2");
    expect(fake.sessions.find((s) => s.name === "billing-2")?.projectId).toBe(p.id);
    expect(store.projectRepos(p)).toEqual(["acme/api"]);
  });

  test("a project whose session cannot be tagged is not kept", async () => {
    fake.sessions.push({ id: "$1", name: "home", projectId: null, viewer: false });
    fake.tagFails = "tmux went away";
    await expect(createProject({ name: "Auth" })).rejects.toThrow("tmux went away");
    await expect(adoptSession("$1")).rejects.toThrow("tmux went away");
    expect(store.listProjects()).toHaveLength(0);
    expect(fake.sessions.map((s) => s.name)).toEqual(["home"]);
  });

  test("only untagged, non-viewer sessions can be adopted", async () => {
    fake.sessions.push(
      { id: "$1", name: "home", projectId: null, viewer: false },
      { id: "$2", name: "aug-view-1-1", projectId: null, viewer: true },
    );
    await createProject({ name: "tagged" });
    expect((await adoptableSessions()).map((s) => s.name)).toEqual(["home"]);
    const p = await adoptSession("$1");
    expect(p.tmux_session).toBe("home");
    expect(fake.sessions[0].projectId).toBe(p.id);
    expect(adoptSession("$1")).rejects.toThrow("already a project");
  });
});

describe("viewer", () => {
  test("a running task's window gets a viewer", async () => {
    const t = codingTask();
    await startTask(t.id);
    expect(await viewerArgv(t.id)).toMatchObject({ argv: expect.any(Array) });
  });

  test("aug never views the window it runs in, which would nest without end", async () => {
    const t = codingTask();
    await startTask(t.id);
    fake.host = fake.windows[0].id;
    const viewer = await viewerArgv(t.id);
    expect(viewer && "refused" in viewer && viewer.refused).toContain("own tmux window");
  });

  test("on a tmux server that can hang under a viewer, the viewer says so", async () => {
    const t = codingTask();
    await startTask(t.id);
    expect(await viewerArgv(t.id)).not.toHaveProperty("warning");
    fake.tmuxVersion = "3.7c";
    const viewer = await viewerArgv(t.id);
    expect(viewer && "argv" in viewer && viewer.warning).toContain("tmux 3.7c can hang");
  });
});

describe("starting a task", () => {
  test("worktree, window, tags and env for a task in a project", async () => {
    const p = await createProject({ name: "Auth" });
    const t = codingTask();
    store.updateTask(t.id, { project_id: p.id });
    const r = await startTask(t.id);
    expect(r.type).toBe("started");
    if (r.type !== "started") return;

    expect(fake.worktrees[0]).toMatchObject({
      repoPath: "/src/api",
      branch: "fix-login-redirect",
      create: true,
    });
    expect(fake.worktrees[0].env.AUG).toBe("1");
    const w = fake.windows[0];
    expect(w.taskId).toBe(t.id);
    expect(w.cwd).toBe("/src/api.fix-login-redirect");
    expect(w.env).toMatchObject({
      AUG: "1",
      AUG_TASK_ID: String(t.id),
      AUG_PROJECT: String(p.id),
      AUG_BRANCH: "fix-login-redirect",
      AUG_SESSION_ID: r.session.id,
    });
    expect(w.argv[0]).toBe("claude");

    const after = store.getTask(t.id)!;
    expect(after.branch).toBe("fix-login-redirect");
    expect(after.worktree).toBe("/src/api.fix-login-redirect");
    expect(after.agent_state).toBe(AgentState.working);
    expect(r.session.kind).toBe(SessionKind.tmux);
    expect(r.session.tmux_window).toBe(w.id);
    expect(store.projectRepos(store.getProject(p.id)!)).toEqual(["acme/api"]);
  });

  test("a task with no project gets a project-of-one", async () => {
    const t = codingTask();
    const r = await startTask(t.id);
    expect(r.type).toBe("started");
    const p = store.getProject(store.getTask(t.id)!.project_id!)!;
    expect(p.solo).toBe(1);
    expect(p.tmux_session).toBe("fix-login-redirect");
  });

  test("existing branches and pr:N switch; pr:N stores the real branch", async () => {
    fake.branches.add("hotfix");
    const a = codingTask();
    await startTask(a.id, { branch: "hotfix" });
    expect(fake.worktrees[0].create).toBe(false);
    const b = codingTask("acme/api", "Review");
    await startTask(b.id, { branch: "pr:12" });
    expect(fake.worktrees[1].create).toBe(false);
    expect(store.getTask(b.id)!.branch).toBe("pr-head-12");
    const c = codingTask("acme/api", "New thing");
    await startTask(c.id);
    expect(fake.worktrees[2].create).toBe(true);
  });

  test("an unmapped repo asks for its path; declining works in scratch", async () => {
    const t = codingTask("acme/web");
    expect(await startTask(t.id)).toEqual({ type: "needs-repo-path", repo: "acme/web" });
    const r = await startTask(t.id, { noWorktree: true });
    expect(r.type).toBe("started");
    expect(fake.worktrees).toHaveLength(0);
    expect(store.getTask(t.id)!.branch).toBeNull();
  });

  test("a mapped checkout that is gone asks for its path again", async () => {
    fake.gone.add("/src/api");
    const t = codingTask("acme/api");
    expect(await startTask(t.id)).toEqual({ type: "needs-repo-path", repo: "acme/api" });
    expect(fake.worktrees).toHaveLength(0);
  });

  test("starting again keeps a running claude's window", async () => {
    const t = codingTask();
    await startTask(t.id);
    const again = await startTask(t.id);
    expect(fake.windows).toHaveLength(1);
    expect(again.type === "started" && again.windowId).toBe(fake.windows[0].id);
    expect(fake.worktrees).toHaveLength(1);
  });

  test("resuming after claude exited replaces the leftover window", async () => {
    const t = codingTask();
    const first = await startTask(t.id);
    if (first.type !== "started") throw new Error("not started");
    store.updateSession(first.session.id, { ended_at: new Date().toISOString() });
    const again = await startTask(t.id, { resume: first.session.id });
    expect(fake.windows).toHaveLength(1);
    expect(again.type === "started" && again.windowId).not.toBe(first.windowId);
    expect(fake.windows[0].argv).toContain("--resume");
    expect(fake.worktrees).toHaveLength(1);
  });

  test("a claude killed for its own resume ends nothing; one that exits in place does", async () => {
    const t = codingTask();
    const first = await startTask(t.id);
    if (first.type !== "started") throw new Error("not started");
    // Marked ended while its claude still ran (a stray reconcile).
    store.updateSession(first.session.id, { ended_at: new Date().toISOString() });
    const again = await startTask(t.id, { resume: first.session.id });
    if (again.type !== "started") throw new Error("not resumed");
    // In the fake a window's pane has the window's id.
    expect(await endedElsewhere(first.session.id, first.windowId)).toBe(true);
    expect(await endedElsewhere(first.session.id, again.windowId)).toBe(false);
    expect(await endedElsewhere(first.session.id, undefined)).toBe(false);
    fake.windows = [];
    expect(await endedElsewhere(first.session.id, first.windowId)).toBe(false);
  });
});

describe("closing, moving, reconciling", () => {
  test("close kills the window, removes the worktree, archives a project-of-one", async () => {
    const t = codingTask();
    await startTask(t.id);
    const projectId = store.getTask(t.id)!.project_id!;
    const r = await closeTask(t.id);
    expect(r).toEqual({ warnings: [], archived: true });
    expect(fake.windows).toHaveLength(0);
    expect(fake.sessions).toHaveLength(0);
    expect(fake.removed).toEqual([{ repoPath: "/src/api", branch: "fix-login-redirect" }]);
    expect(store.getProject(projectId)!.status).toBe("archived");
    expect(store.latestSession(t.id)!.ended_at).not.toBeNull();
  });

  test("a dirty worktree is kept and reported", async () => {
    const p = await createProject({ name: "Auth" });
    const t = codingTask();
    store.updateTask(t.id, { project_id: p.id });
    await startTask(t.id);
    fake.removeFails = "worktree has uncommitted changes";
    const r = await closeTask(t.id);
    expect(r.archived).toBe(false);
    expect(r.warnings[0]).toContain("uncommitted");
    expect(store.getTask(t.id)!.worktree).not.toBeNull();
  });

  test("moving a task moves its live window and empties the solo project", async () => {
    const t = codingTask();
    await startTask(t.id);
    const solo = store.getTask(t.id)!.project_id!;
    const target = await createProject({ name: "Big refactor" });
    await moveTask(t.id, target.id);
    const targetSession = fake.sessions.find((s) => s.projectId === target.id)!;
    expect(fake.windows[0].sessionId).toBe(targetSession.id);
    expect(store.getTask(t.id)!.project_id).toBe(target.id);
    expect(store.getProject(solo)!.status).toBe("archived");
  });

  test("reconcile stops a session whose window is gone", async () => {
    const t = codingTask();
    await startTask(t.id);
    fake.windows = [];
    await reconcile();
    expect(store.latestSession(t.id)!.ended_at).not.toBeNull();
    expect(store.getTask(t.id)!.agent_state).toBe(AgentState.stopped);
  });

  test("reconcile leaves sessions alone when tmux does not answer", async () => {
    const t = codingTask();
    await startTask(t.id);
    fake.stateFails = "command timed out";
    await expect(reconcile()).rejects.toThrow("timed out");
    expect(store.latestSession(t.id)!.ended_at).toBeNull();
  });

  test("reconcile follows a renamed session; a killed one is made again", async () => {
    const p = await createProject({ name: "Auth" });
    fake.sessions[0].name = "auth-renamed";
    await reconcile();
    expect(store.getProject(p.id)!.tmux_session).toBe("auth-renamed");

    fake.sessions = [];
    const t = codingTask();
    store.updateTask(t.id, { project_id: p.id });
    await startTask(t.id);
    expect(fake.sessions[0]).toMatchObject({ name: "auth-renamed", projectId: p.id });
  });

  test("archiving kills the project's windows (viewers too) and stops its tasks", async () => {
    const p = await createProject({ name: "Auth" });
    const t = codingTask();
    store.updateTask(t.id, { project_id: p.id });
    await startTask(t.id);
    const session = fake.sessions.find((s) => s.projectId === p.id)!;
    fake.sessions.push({ id: "$v", name: "aug-view-1-1", projectId: null, viewer: true });
    await archiveProject(p.id);
    expect(fake.windows).toHaveLength(0);
    expect(fake.sessions.some((s) => s.id === session.id)).toBe(false);
    expect(store.getProject(p.id)!.status).toBe("archived");
    expect(store.latestSession(t.id)!.ended_at).not.toBeNull();
    expect(store.getTask(t.id)!.agent_state).toBe(AgentState.stopped);
  });

  test("tmux events are debounced into one reconcile, until aborted", async () => {
    const abort = new AbortController();
    let calls = 0;
    const done = watchTmux(() => calls++, abort.signal, 10);
    await Bun.sleep(0);
    for (const fire of fake.watchers) { fire(); fire(); fire(); }
    await Bun.sleep(30);
    expect(calls).toBe(1);
    abort.abort();
    await done;
    expect(fake.watchers).toHaveLength(0);
  });

  test("nudge types a line into the live window only", async () => {
    const t = codingTask();
    expect(await nudge(t.id, "hi")).toBe(false);
    await startTask(t.id);
    expect(await nudge(t.id, "New review on #12")).toBe(true);
    expect(fake.sent).toEqual([{ windowId: fake.windows[0].id, text: "New review on #12" }]);
  });
});
