import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, mergeConfig } from "../src/core/config";
import {
  fillTemplate,
  parseWorktree,
  setMux,
  shellQuote,
  windowCommand,
} from "../src/core/mux";
import {
  adoptSession,
  adoptableSessions,
  archiveProject,
  closeTask,
  createProject,
  freeSessionName,
  moveTask,
  nudge,
  reconcile,
  slug,
  startTask,
  watchTmux,
} from "../src/core/projects";
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
    expect(windowCommand(["claude", "--append-system-prompt", "a b"])).toBe(
      `claude --append-system-prompt 'a b'; exec "\${SHELL:-/bin/sh}" -l`,
    );
  });

  test("the old agentsAtOnce key still sets maxActiveAgents", () => {
    expect(mergeConfig({ agentsAtOnce: 2 } as never).maxActiveAgents).toBe(2);
    expect(mergeConfig({}).maxActiveAgents).toBe(4);
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
