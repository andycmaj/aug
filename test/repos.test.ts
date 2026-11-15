import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/core/config";
import { Engine } from "../src/core/engine";
import { setMux } from "../src/core/mux";
import { applyProjectDoc, renderProjectDoc } from "../src/core/project-doc";
import {
  candidates,
  checkMapped,
  cloneDest,
  mapRepo,
  renameRepo,
  repoReport,
  reportText,
} from "../src/core/repos";
import * as store from "../src/core/store";
import { Kind, TaskStatus } from "../src/core/types";
import { FakeMux } from "./fake-mux";
import { config, fakeBrain, freshHome, testConfig } from "./helpers";

let engine: Engine;
let fake: FakeMux;

beforeEach(() => {
  freshHome({
    github: { ...DEFAULT_CONFIG.github, repos: { "acme/api": "/src/api" } },
  });
  fakeBrain(() => null);
  fake = new FakeMux();
  setMux(fake);
  fake.checkouts.set("/src/api", { kind: "checkout", repos: ["acme/api"] });
  engine = new Engine({ config: testConfig() });
});

function codingTask(repo: string) {
  return store.createTask({ title: "Add a flag", kind: Kind.coding, channel: "github", repo });
}

describe("checking a mapped path", () => {
  test("each way a path can be wrong is told apart", () => {
    expect(checkMapped(config(), "acme/api")).toBeNull();
    expect(checkMapped(config(), "acme/web")).toEqual({ kind: "unmapped" });
    fake.checkouts.set("/src/api", { kind: "worktree", main: "/src/main-api" });
    expect(checkMapped(config(), "acme/api")).toEqual({
      kind: "worktree",
      path: "/src/api",
      main: "/src/main-api",
    });
    fake.checkouts.set("/src/api", { kind: "not-git" });
    expect(checkMapped(config(), "acme/api")?.kind).toBe("not-git");
    fake.checkouts.set("/src/api", { kind: "checkout", repos: ["acme/api-v2"] });
    expect(checkMapped(config(), "acme/api")).toEqual({
      kind: "mismatch",
      path: "/src/api",
      remotes: ["acme/api-v2"],
    });
  });

  test("a fork matches by any remote; no GitHub remote is not a mismatch", () => {
    fake.checkouts.set("/src/api", { kind: "checkout", repos: ["me/api", "Acme/API"] });
    expect(checkMapped(config(), "acme/api")).toBeNull();
    fake.checkouts.set("/src/api", { kind: "checkout", repos: [] });
    expect(checkMapped(config(), "acme/api")).toBeNull();
  });

  test("a path that is not a checkout is never saved", () => {
    fake.gone.add("/nowhere");
    expect(() => mapRepo(testConfig(), "acme/web", "/nowhere")).toThrow("/nowhere is gone");
    expect(config().github.repos["acme/web"]).toBeUndefined();
    fake.checkouts.set("/src/web.fix", { kind: "worktree", main: "/src/web" });
    expect(() => mapRepo(testConfig(), "acme/web", "/src/web.fix")).toThrow("worktree of /src/web");
  });
});

describe("found on disk", () => {
  test("candidates match by remote, then by folder name when there is no remote", async () => {
    fake.checkouts.set("/w/acme/web", { kind: "checkout", repos: ["acme/web"] });
    fake.checkouts.set("/w/web-2", { kind: "checkout", repos: ["acme/web"] });
    fake.checkouts.set("/w/other/web", { kind: "checkout", repos: [] });
    fake.checkouts.set("/w/unrelated", { kind: "checkout", repos: ["acme/x"] });
    expect(await candidates(config(), "acme/web")).toEqual([
      { path: "/w/acme/web", guess: false },
      { path: "/w/web-2", guess: false },
      { path: "/w/other/web", guess: true },
    ]);
    expect(await candidates(config(), "acme/api")).toEqual([]);
  });

  test("the report lists every repo's state and the unmapped checkouts", async () => {
    store.addProjectRepo(store.createProject({ name: "web", tmuxSession: "web" }).id, "acme/web");
    fake.checkouts.set("/w/acme/web", { kind: "checkout", repos: ["acme/web"] });
    fake.checkouts.set("/w/acme/tools", { kind: "checkout", repos: ["acme/tools"] });
    const r = await repoReport(config(), true);
    expect(r.repos.map((s) => [s.repo, s.path, s.problem?.kind ?? null])).toEqual([
      ["acme/api", "/src/api", null],
      ["acme/web", null, "unmapped"],
    ]);
    expect(r.unmapped).toEqual([{ path: "/w/acme/tools", repos: ["acme/tools"] }]);
    const text = reportText(r);
    expect(text).toContain("acme/web  no path [web]; also at /w/acme/web");
    expect(text).toContain("On disk, not mapped:\nacme/tools  /w/acme/tools");
  });
});

describe("rename", () => {
  test("moves the mapping, project repos and open tasks; closed ones keep history", () => {
    const p = store.createProject({ name: "api", tmuxSession: "api", repos: ["acme/api", "acme/web"] });
    const open = codingTask("acme/api");
    const closed = codingTask("acme/api");
    store.updateTask(closed.id, { status: TaskStatus.done });
    renameRepo(testConfig(), "acme/api", "acme/api-v2");
    expect(config().github.repos).toEqual({ "acme/api-v2": "/src/api" });
    expect(store.projectRepos(store.getProject(p.id)!)).toEqual(["acme/api-v2", "acme/web"]);
    expect(store.getTask(open.id)!.repo).toBe("acme/api-v2");
    expect(store.getTask(closed.id)!.repo).toBe("acme/api");
  });
});

describe("a coding start", () => {
  test("a checkout of another repo asks; rename or anyway lets it start", async () => {
    fake.checkouts.set("/src/api", { kind: "checkout", repos: ["acme/api-v2"] });
    const task = codingTask("acme/api");
    const ref = store.taskRef(task.id);
    const asked = await engine.runMove("start", { task: ref });
    expect(asked.ok).toBe(false);
    expect(asked.result).toContain("needs path: /src/api is acme/api-v2, not acme/api.");
    expect(asked.result).toContain("--rename acme/api-v2");
    const anyway = await engine.runMove("start", { task: ref, repo: "acme/api", anyway: "yes", branch: "x" });
    expect(anyway.ok).toBe(true);
    expect(fake.worktrees[0].repoPath).toBe("/src/api");
  });

  test("--rename takes the remote's name and starts", async () => {
    fake.checkouts.set("/src/api", { kind: "checkout", repos: ["acme/api-v2"] });
    const task = codingTask("acme/api");
    const out = await engine.runMove("start", {
      task: store.taskRef(task.id),
      repo: "acme/api",
      rename: "acme/api-v2",
    });
    expect(out.ok).toBe(true);
    expect(store.getTask(task.id)!.repo).toBe("acme/api-v2");
  });

  test("a worktree path names its main checkout; found checkouts are offered", async () => {
    fake.checkouts.set("/src/api", { kind: "worktree", main: "/w/api" });
    fake.checkouts.set("/w/api", { kind: "checkout", repos: ["acme/api"] });
    const task = codingTask("acme/api");
    const need = await engine.desk.startAgent(task.id);
    expect(need).toMatchObject({
      type: "needs",
      need: {
        what: "path",
        problem: { kind: "worktree", main: "/w/api" },
        candidates: [{ path: "/w/api", guess: false }],
      },
    });
    const out = await engine.runMove("start", { task: store.taskRef(task.id) });
    expect(out.result).toContain("Found on disk: /w/api.");
    expect(out.result).toContain("--path /w/api");
  });

  test("--clone clones to the first root and maps it", async () => {
    const task = codingTask("acme/web");
    const out = await engine.runMove("start", {
      task: store.taskRef(task.id),
      repo: "acme/web",
      clone: "yes",
      branch: "x",
    });
    expect(out.ok).toBe(true);
    expect(fake.cloned).toEqual([{ repo: "acme/web", dest: cloneDest(config(), "acme/web") }]);
    expect(config().github.repos["acme/web"]).toBe(cloneDest(config(), "acme/web"));
    expect(fake.worktrees[0].repoPath).toBe(cloneDest(config(), "acme/web"));
  });

  test("a worktree removed by hand is made again on its branch", async () => {
    const task = codingTask("acme/api");
    const first = await engine.desk.startAgent(task.id, { branch: "flag" });
    expect(first.type).toBe("started");
    const made = store.getTask(task.id)!.worktree!;
    await engine.desk.stopAgent(task.id);
    fake.gone.add(made);
    fake.branches.add("flag");
    const again = await engine.desk.startAgent(task.id);
    expect(again.type).toBe("started");
    expect(fake.worktrees).toHaveLength(2);
    expect(fake.worktrees[1]).toMatchObject({ branch: "flag", create: false });
    expect(store.turnsForTask(task.id).map((t) => t.body).join("\n")).toContain("was gone");
  });
});

describe("the repo move", () => {
  test("maps, refuses a bad path in words, forgets", async () => {
    fake.checkouts.set("/w/web", { kind: "checkout", repos: ["acme/web"] });
    expect((await engine.runMove("repo", { repo: "acme/web", path: "/w/web" })).result).toBe(
      "acme/web  /w/web  ok",
    );
    fake.gone.add("/w/gone");
    expect(await engine.runMove("repo", { repo: "acme/web", path: "/w/gone" })).toEqual({
      ok: false,
      result: "/w/gone is gone",
    });
    expect((await engine.runMove("repo", { repo: "acme/web", remove: "yes" })).result).toBe(
      "acme/web: path forgotten",
    );
    expect(config().github.repos["acme/web"]).toBeUndefined();
  });

  test("project_repo names an unmapped repo's checkouts, and --remove takes it out", async () => {
    store.createProject({ name: "web", tmuxSession: "web" });
    fake.checkouts.set("/w/web", { kind: "checkout", repos: ["acme/web"] });
    const out = await engine.runMove("project_repo", { project: "web", repo: "acme/web" });
    expect(out.result).toContain("found at /w/web");
    const removed = await engine.runMove("project_repo", { project: "web", repo: "acme/web", remove: "yes" });
    expect(removed.result).toContain("repos: none");
  });
});

describe("the project file's Repos", () => {
  test("renders each repo with its path and what is wrong with it", () => {
    fake.gone.add("/src/web");
    store.createProject({ name: "api", tmuxSession: "api", repos: ["acme/api", "acme/web", "acme/x"] });
    mapRepoUnchecked("acme/web", "/src/web");
    const text = renderProjectDoc(store.listProjects()[0], config());
    expect(text).toContain(
      "## Repos\n- acme/api  /src/api\n- acme/web  /src/web  <!-- /src/web is gone -->\n- acme/x\n",
    );
  });

  test("editing it reorders, adds and drops repos and sets paths; a bad path is not saved", () => {
    const p = store.createProject({ name: "api", tmuxSession: "api", repos: ["acme/api", "acme/old"] });
    fake.gone.add("/nowhere");
    fake.checkouts.set("/w/web", { kind: "checkout", repos: ["acme/web"] });
    const said = applyProjectDoc(
      testConfig(),
      p.id,
      ["## Repos", "- acme/web  /w/web", "- acme/api", "- acme/new  /nowhere", "- not a repo"].join("\n"),
      "you",
    );
    expect(said).toBe("api: repos updated, acme/web at /w/web, acme/new path not saved: /nowhere is gone");
    expect(store.projectRepos(store.getProject(p.id)!)).toEqual(["acme/web", "acme/api", "acme/new"]);
    expect(config().github.repos).toEqual({ "acme/api": "/src/api", "acme/web": "/w/web" });
  });

  test("a file with no Repos heading leaves them alone", () => {
    const p = store.createProject({ name: "api", tmuxSession: "api", repos: ["acme/api"] });
    applyProjectDoc(testConfig(), p.id, "## Goals\n- [ ] ship", "you");
    expect(store.projectRepos(store.getProject(p.id)!)).toEqual(["acme/api"]);
  });
});

function mapRepoUnchecked(repo: string, path: string) {
  testConfig().update((c) => ({ ...c, github: { ...c.github, repos: { ...c.github.repos, [repo]: path } } }));
}
