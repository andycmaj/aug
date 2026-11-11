import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/core/config";
import { Engine } from "../src/core/engine";
import { movesHelp } from "../src/core/assistant";
import { codingBrief } from "../src/core/agents";
import { taskDetail } from "../src/core/lookup";
import { drainMoves, MOVE_STALE_MS, waitForMove } from "../src/core/moves";
import { setMux } from "../src/core/mux";
import * as store from "../src/core/store";
import { handleDone } from "../src/core/hooks";
import { Kind, MoveStatus, SessionKind, TaskStatus } from "../src/core/types";
import { FakeMux } from "./fake-mux";
import { fakeBrain, freshHome } from "./helpers";

let engine: Engine;
let fake: FakeMux;

beforeEach(() => {
  freshHome({
    github: { ...DEFAULT_CONFIG.github, repos: { "acme/api": "/src/api" } },
  });
  fakeBrain(() => null);
  fake = new FakeMux();
  setMux(fake);
  engine = new Engine();
});

function ask(verb: string, args: Record<string, string>) {
  return store.enqueueMove(verb, args, "you");
}

describe("the moves bus", () => {
  test("a pending move runs once and records its result", async () => {
    const task = engine.desk.newTask("Fix the build", Kind.general);
    const move = ask("done", { task: store.taskRef(task.id) });
    expect(await engine.drainMoves()).toBe(1);
    expect(await engine.drainMoves()).toBe(0);
    const row = store.getMove(move.id)!;
    expect(row.status).toBe(MoveStatus.done);
    expect(row.result).toBe(`${store.taskRef(task.id)} marked done`);
    expect(store.getTask(task.id)!.status).toBe(TaskStatus.done);
  });

  test("two drains at once never run a move twice", async () => {
    const task = engine.desk.newTask("Ping Sam", Kind.general);
    ask("tell", { task: store.taskRef(task.id), text: "hello" });
    const [a, b] = await Promise.all([engine.drainMoves(), engine.drainMoves()]);
    expect(a + b).toBe(1);
  });

  test("an unknown task, verb or missing arg fails with a reason", async () => {
    const task = engine.desk.newTask("Ping Sam", Kind.general);
    const noTask = ask("done", { task: "AUG-0999" });
    const noVerb = ask("explode", {});
    const noArg = ask("remind", { task: store.taskRef(task.id) });
    await engine.drainMoves();
    expect(store.getMove(noTask.id)!.result).toBe("no task AUG-0999");
    expect(store.getMove(noVerb.id)!.result).toStartWith("no move explode");
    expect(store.getMove(noArg.id)!.result).toBe("remind needs --days");
    for (const m of [noTask, noVerb, noArg])
      expect(store.getMove(m.id)!.status).toBe(MoveStatus.failed);
  });

  test("a move older than a minute expires instead of running", async () => {
    const task = engine.desk.newTask("Old ask", Kind.general);
    const move = ask("done", { task: store.taskRef(task.id) });
    await drainMoves(engine.desk, Date.now() + MOVE_STALE_MS + 1);
    expect(store.getMove(move.id)!.status).toBe(MoveStatus.failed);
    expect(store.getTask(task.id)!.status).toBe(TaskStatus.open);
  });

  test("waiting gives up on a move nobody picks up, so it never runs later", async () => {
    const task = engine.desk.newTask("Nobody home", Kind.general);
    const move = ask("done", { task: store.taskRef(task.id) });
    const row = await waitForMove(move.id, { pickupMs: 20, pollMs: 5 });
    expect(row.status).toBe(MoveStatus.failed);
    expect(row.result).toContain("is aug running");
    await engine.drainMoves();
    expect(store.getTask(task.id)!.status).toBe(TaskStatus.open);
  });

  test("waiting returns the result once the engine has run it", async () => {
    const task = engine.desk.newTask("Later", Kind.general);
    const move = ask("remind", { task: store.taskRef(task.id), days: "2" });
    setTimeout(() => void engine.drainMoves(), 10);
    const row = await waitForMove(move.id, { pollMs: 5 });
    expect(row.status).toBe(MoveStatus.done);
    expect(row.result).toStartWith(`${store.taskRef(task.id)} back on `);
  });
});

describe("start", () => {
  test("a coding task with no repo asks which, naming the known ones", async () => {
    const task = engine.desk.newTask("Add a flag", Kind.coding);
    const out = await engine.runMove("start", { task: store.taskRef(task.id) });
    expect(out.ok).toBe(false);
    expect(out.result).toContain("needs repo");
    expect(out.result).toContain("acme/api");
  });

  test("an unmapped repo asks where it is checked out", async () => {
    const task = engine.desk.newTask("Add a flag", Kind.coding);
    const out = await engine.runMove("start", {
      task: store.taskRef(task.id),
      repo: "acme/web",
    });
    expect(out.ok).toBe(false);
    expect(out.result).toContain("needs path");
    expect(store.getTask(task.id)!.repo).toBe("acme/web");
  });

  test("a coding task with a mapped repo starts in a worktree", async () => {
    const task = engine.desk.newTask("Add a flag", Kind.coding);
    const out = await engine.runMove("start", {
      task: store.taskRef(task.id),
      repo: "acme/api",
    });
    expect(out).toEqual({
      ok: true,
      result: expect.stringContaining(`started ${store.taskRef(task.id)}'s coding agent`),
    });
    expect(store.getTask(task.id)!.worktree).toBeTruthy();
  });

  test("--path never moves a repo whose checkout is still there", async () => {
    const task = engine.desk.newTask("Add a flag", Kind.coding);
    const out = await engine.runMove("start", {
      task: store.taskRef(task.id),
      repo: "acme/api",
      path: "/src/api.some-worktree",
    });
    expect(out.ok).toBe(true);
    expect(fake.worktrees[0].repoPath).toBe("/src/api");
  });

  test("a mapped checkout that is gone asks for a path, and --path replaces it", async () => {
    fake.gone.add("/src/api");
    const task = engine.desk.newTask("Add a flag", Kind.coding);
    const ref = store.taskRef(task.id);
    const out = await engine.runMove("start", { task: ref, repo: "acme/api" });
    expect(out.ok).toBe(false);
    expect(out.result).toContain("needs path");
    const again = await engine.runMove("start", { task: ref, repo: "acme/api", path: "/src/api2" });
    expect(again.ok).toBe(true);
    expect(fake.worktrees[0].repoPath).toBe("/src/api2");
  });

  test("scratch starts with no repo at all", async () => {
    const task = engine.desk.newTask("Try a thing", Kind.coding);
    const out = await engine.runMove("start", {
      task: store.taskRef(task.id),
      scratch: "yes",
    });
    expect(out.ok).toBe(true);
    expect(store.getTask(task.id)!.worktree).toBeNull();
  });
});

describe("telling a coding agent", () => {
  async function started(title = "Add a flag") {
    const task = engine.desk.newTask(title, Kind.coding);
    await engine.runMove("start", { task: store.taskRef(task.id), repo: "acme/api" });
    return task;
  }

  function stopClaude(taskId: number) {
    const session = store.latestSession(taskId)!;
    store.updateSession(session.id, { ended_at: new Date().toISOString() });
  }

  test("a line for a running claude is typed into its window", async () => {
    const task = await started();
    const out = await engine.runMove("tell", { task: store.taskRef(task.id), text: "also check s" });
    expect(out.result).toBe(`told ${store.taskRef(task.id)}'s agent`);
    expect(fake.sent).toEqual([{ windowId: fake.windows[0].id, text: "also check s" }]);
  });

  test("a line for a stopped claude waits for start, which resumes with it once", async () => {
    const task = await started();
    stopClaude(task.id);
    const out = await engine.runMove("tell", { task: store.taskRef(task.id), text: "can't re-attach with s" });
    expect(out.result).toContain("when it starts");
    expect(fake.sent).toEqual([]);

    await engine.runMove("start", { task: store.taskRef(task.id) });
    expect(fake.windows[0].argv).toContain("--resume");
    expect(fake.windows[0].argv.at(-1)).toBe("can't re-attach with s");

    stopClaude(task.id);
    await engine.runMove("start", { task: store.taskRef(task.id) });
    expect(fake.windows[0].argv).not.toContain("can't re-attach with s");
  });

  test("lines typed before the first start go in with the brief", async () => {
    const task = engine.desk.newTask("Add a flag", Kind.coding);
    await engine.desk.say(task.id, "use the new parser");
    await engine.desk.say(task.id, "and keep the old flag");
    await engine.runMove("start", { task: store.taskRef(task.id), repo: "acme/api" });
    const first = fake.windows[0].argv.at(-1)!;
    expect(first).toContain("use the new parser");
    expect(first).toContain("and keep the old flag");
  });

  test("start's note reaches a claude that is already running", async () => {
    const task = await started();
    await engine.runMove("start", { task: store.taskRef(task.id), note: "look at #12 too" });
    expect(fake.windows).toHaveLength(1);
    expect(fake.sent).toEqual([{ windowId: fake.windows[0].id, text: "look at #12 too" }]);
  });
});

describe("making and placing tasks", () => {
  test("a coding task made from another, in a named project, takes its repo", async () => {
    const project = await engine.desk.createProject("aug-bootstrap", "acme/api");
    const parent = engine.desk.newTask("JOB.md is empty", Kind.general);
    const out = await engine.runMove(
      "new",
      {
        title: "Fill in JOB.md",
        kind: "coding",
        project: "AUG Bootstrap",
        brief: "Write JOB.md from the thread in AUG-0001",
        from: store.taskRef(parent.id),
      },
      "agent AUG-0001",
    );
    expect(out.ok).toBe(true);
    const made = store.listTasks().find((t) => t.title === "Fill in JOB.md")!;
    expect(out.result).toStartWith(`${store.taskRef(made.id)} made (coding in project aug-bootstrap, repo acme/api)`);
    expect(made).toMatchObject({
      kind: Kind.coding,
      project_id: project.id,
      repo: "acme/api",
      from_task_id: parent.id,
      summary: "Write JOB.md from the thread in AUG-0001",
    });
    expect(store.turnsForTask(made.id)[0].body).toBe(
      `Made from ${store.taskRef(parent.id)} by agent AUG-0001`,
    );
    expect(store.turnsForTask(parent.id).at(-1)!.body).toContain(
      `agent AUG-0001 made ${store.taskRef(made.id)} (coding in aug-bootstrap)`,
    );
  });

  test("a project that does not exist is named back with the ones that do", async () => {
    await engine.desk.createProject("aug-mvp");
    const out = await engine.runMove("new", {
      title: "x",
      project: "aug-bootstrap",
    });
    expect(out).toEqual({
      ok: false,
      result: "no project aug-bootstrap. Projects: aug-mvp. Make one with project_new.",
    });
    expect(store.listTasks()).toHaveLength(0);
  });

  test("a bad kind or repo is refused before anything is made", async () => {
    expect((await engine.runMove("new", { title: "x", kind: "home" })).result).toStartWith(
      "kind must be",
    );
    expect((await engine.runMove("new", { title: "x", repo: "nope" })).result).toBe(
      "nope is not owner/repo",
    );
    expect(store.listTasks()).toHaveLength(0);
  });

  test("an unstarted task joins a project without waking its session", async () => {
    const project = await engine.desk.createProject("api");
    const task = engine.desk.newTask("Add a flag", Kind.coding);
    // You killed the session; nothing about this task needs it back yet.
    fake.sessions = [];
    const out = await engine.runMove("project", {
      task: store.taskRef(task.id),
      project: "api",
    });
    expect(out.ok).toBe(true);
    expect(store.getTask(task.id)!.project_id).toBe(project.id);
    expect(fake.sessions).toHaveLength(0);
  });

  test("retitle, kind and wait_on edit the task", async () => {
    const task = engine.desk.newTask("old", Kind.general);
    const t = store.taskRef(task.id);
    await engine.runMove("retitle", { task: t, title: "new" });
    await engine.runMove("kind", { task: t, kind: "coding" });
    await engine.runMove("wait_on", { task: t, who: "Sam" });
    expect(store.getTask(task.id)).toMatchObject({
      title: "new",
      kind: Kind.coding,
      waiting_on: "Sam",
    });
  });

  test("a brief can be rewritten until the agent starts", async () => {
    const task = engine.desk.newTask("Add a flag", Kind.coding, "add --dry-run");
    const t = store.taskRef(task.id);
    const out = await engine.runMove("brief", {
      task: t,
      text: "  add --dry-run to sync, and test it\n",
    });
    expect(out).toEqual({ ok: true, result: `${t}'s brief rewritten` });
    expect(store.getTask(task.id)!.summary).toBe("add --dry-run to sync, and test it");

    store.createSession({ id: "s1", taskId: task.id, kind: SessionKind.tmux, cwd: "/w", startedBy: "owner" });
    const late = await engine.runMove("brief", { task: t, text: "something else" });
    expect(late.ok).toBe(false);
    expect(late.result).toContain("already started");
    expect(store.getTask(task.id)!.summary).toBe("add --dry-run to sync, and test it");
  });

  test("an empty brief is refused", async () => {
    const task = engine.desk.newTask("Add a flag", Kind.general, "keep me");
    const out = await engine.runMove("brief", { task: store.taskRef(task.id), text: "   " });
    expect(out.ok).toBe(false);
    expect(store.getTask(task.id)!.summary).toBe("keep me");
  });

  async function child(parentTitle: string, by = "agent AUG-0001") {
    const parent = engine.desk.newTask(parentTitle, Kind.general);
    await engine.runMove(
      "new",
      { title: "Fill in JOB.md", kind: "coding", from: store.taskRef(parent.id) },
      by,
    );
    const made = store.listTasks().find((t) => t.title === "Fill in JOB.md")!;
    return { parent, made, last: () => store.turnsForTask(parent.id).at(-1)! };
  }

  test("the task it was made from hears back when it is marked done", async () => {
    const { parent, made, last } = await child("JOB.md is empty");
    await engine.runMove("done", { task: store.taskRef(made.id) });
    expect(last().role).toBe("trigger");
    expect(last().body).toBe(`${store.taskRef(made.id)} marked done by you: Fill in JOB.md`);
    // done again (close after the agent closed it) says nothing new
    const count = store.turnsForTask(parent.id).length;
    await engine.desk.close(made.id);
    expect(store.turnsForTask(parent.id)).toHaveLength(count);
  });

  test("when its agent finishes, the result line goes back to the task it came from", async () => {
    const { parent, made, last } = await child("JOB.md is empty");
    store.createSession({ id: "s1", taskId: made.id, kind: SessionKind.tmux, cwd: "/w", startedBy: "aug" });
    handleDone({ taskId: made.id, sessionId: "s1" }, { summary: "JOB.md written; 3 sections" });
    expect(store.getTask(made.id)!.status).toBe(TaskStatus.done);
    expect(last().body).toBe(
      `${store.taskRef(made.id)} finished: Fill in JOB.md\nResult: JOB.md written; 3 sections`,
    );
    const count = store.turnsForTask(parent.id).length;
    await engine.desk.close(made.id);
    expect(store.turnsForTask(parent.id)).toHaveLength(count);
  });

  test("an agent that finishes but leaves the task to its owner says so, then the close follows", async () => {
    const { made, last } = await child("JOB.md is empty");
    store.createSession({ id: "s1", taskId: made.id, kind: SessionKind.tmux, cwd: "/w", startedBy: "owner" });
    handleDone({ taskId: made.id, sessionId: "s1" }, { summary: "PR opened" });
    expect(last().body).toBe(
      `${store.taskRef(made.id)} finished; it waits for the owner: Fill in JOB.md\nResult: PR opened`,
    );
    await engine.desk.close(made.id);
    expect(last().body).toBe(
      `${store.taskRef(made.id)} marked done by you: Fill in JOB.md\nResult: PR opened`,
    );
  });

  test("a task made from nothing tells no one", async () => {
    const made = engine.desk.newTask("Alone", Kind.general);
    const before = store.listTasks().flatMap((t) => store.turnsForTask(t.id)).length;
    await engine.desk.close(made.id);
    expect(store.listTasks().flatMap((t) => store.turnsForTask(t.id)).length).toBe(before);
  });
});

describe("projects", () => {
  test("project_new refuses a name already taken", async () => {
    expect((await engine.runMove("project_new", { name: "web" })).ok).toBe(true);
    expect((await engine.runMove("project_new", { name: "Web" })).result).toBe(
      "there is already a project web",
    );
  });

  test("project_repo adds a repo new coding tasks default to", async () => {
    await engine.runMove("project_new", { name: "web" });
    await engine.runMove("project_repo", { project: "web", repo: "acme/web" });
    await engine.runMove("new", { title: "x", kind: "coding", project: "web" });
    expect(store.listTasks()[0].repo).toBe("acme/web");
  });

  test("archiving a project with open tasks needs force", async () => {
    const project = await engine.desk.createProject("web");
    engine.desk.newTask("open one", Kind.general, "", { projectId: project.id });
    const refused = await engine.runMove("project_archive", { project: "web" });
    expect(refused.ok).toBe(false);
    expect(refused.result).toContain("--force yes");
    expect(store.getProject(project.id)!.status).toBe("active");
    const forced = await engine.runMove("project_archive", {
      project: "web",
      force: "yes",
    });
    expect(forced.ok).toBe(true);
    expect(store.getProject(project.id)!.status).toBe("archived");
  });
});

describe("what an agent may ask for", () => {
  test("it makes tasks, and edits only its own", async () => {
    const mine = engine.desk.newTask("mine", Kind.general);
    const other = engine.desk.newTask("other", Kind.general);
    const by = `agent ${store.taskRef(mine.id)}`;
    expect((await engine.runMove("new", { title: "follow-up", from: store.taskRef(mine.id) }, by)).ok).toBe(true);
    expect((await engine.runMove("wait_on", { task: store.taskRef(mine.id), who: "Sam" }, by)).ok).toBe(true);
    const theirs = await engine.runMove("priority", { task: store.taskRef(other.id), level: "urgent" }, by);
    expect(theirs).toEqual({ ok: false, result: `an agent changes only its own task (${store.taskRef(mine.id)})` });
  });

  test("it makes a project and a task in it", async () => {
    const mine = engine.desk.newTask("mine", Kind.general);
    const by = `agent ${store.taskRef(mine.id)}`;
    const project = await engine.runMove("project_new", { name: "2027-scaling-plan" }, by);
    expect(project.ok).toBe(true);
    const task = await engine.runMove(
      "new",
      { title: "create initial scaling challenges doc", project: "2027-scaling-plan", from: store.taskRef(mine.id) },
      by,
    );
    expect(task.ok).toBe(true);
    expect(task.result).toContain("in project 2027-scaling-plan");
  });

  test("starting, closing and archiving stay the owner's", async () => {
    const mine = engine.desk.newTask("mine", Kind.general);
    const by = `agent ${store.taskRef(mine.id)}`;
    await engine.runMove("project_new", { name: "x" });
    for (const [verb, args] of [
      ["done", { task: store.taskRef(mine.id) }],
      ["start", { task: store.taskRef(mine.id) }],
      ["project_archive", { project: "x" }],
    ] as const) {
      const out = await engine.runMove(verb, args, by);
      expect(out.ok).toBe(false);
      expect(out.result).toStartWith(`${verb} is the owner's move`);
    }
    expect(store.getTask(mine.id)!.status).toBe(TaskStatus.open);
  });
});

describe("links", () => {
  const doc = "https://docs.example.com/plan";

  test("link attaches a URL, and again only retitles it", async () => {
    const task = engine.newTask("Plan the launch", Kind.general);
    const ref = store.taskRef(task.id);
    const first = await engine.runMove("link", { task: ref, url: ` ${doc} ` });
    expect(first).toEqual({ ok: true, result: `linked ${doc} to ${ref}` });
    const again = await engine.runMove("link", { task: ref, url: doc, title: "the plan" });
    expect(again.result).toBe(`linked the plan (${doc}) to ${ref}`);
    await engine.runMove("link", { task: ref, url: doc });
    const links = store.linksForTask(task.id);
    expect(links.map((l) => [l.url, l.title, l.added_by])).toEqual([
      [doc, "the plan", "you"],
    ]);
  });

  test("only http(s) URLs attach", async () => {
    const task = engine.newTask("Plan the launch", Kind.general);
    for (const url of ["docs/plan.md", "file:///etc/passwd", "javascript:alert(1)"]) {
      const out = await engine.runMove("link", { task: store.taskRef(task.id), url });
      expect(out).toEqual({ ok: false, result: `${url} is not an http(s) URL` });
    }
    expect(store.linksForTask(task.id)).toEqual([]);
  });

  test("unlink takes it off, and names the links when the URL is not one", async () => {
    const task = engine.newTask("Plan the launch", Kind.general);
    const ref = store.taskRef(task.id);
    await engine.runMove("link", { task: ref, url: doc });
    const miss = await engine.runMove("unlink", { task: ref, url: "https://x.test" });
    expect(miss).toEqual({ ok: false, result: `${ref} has no link https://x.test. Links: ${doc}` });
    const out = await engine.runMove("unlink", { task: ref, url: doc });
    expect(out).toEqual({ ok: true, result: `unlinked ${doc} from ${ref}` });
    expect(store.linksForTask(task.id)).toEqual([]);
  });

  test("an agent links its own task only", async () => {
    const mine = engine.newTask("mine", Kind.general);
    const other = engine.newTask("other", Kind.general);
    const by = `agent ${store.taskRef(mine.id)}`;
    const own = await engine.runMove("link", { task: store.taskRef(mine.id), url: doc }, by);
    expect(own.ok).toBe(true);
    expect(store.linksForTask(mine.id)[0].added_by).toBe(by);
    const theirs = await engine.runMove("link", { task: store.taskRef(other.id), url: doc }, by);
    expect(theirs.ok).toBe(false);
  });

  test("lookups and the coding brief carry the links", async () => {
    const task = engine.newTask("Plan the launch", Kind.coding);
    store.addTaskLink(task.id, doc, "the plan", "you");
    expect(taskDetail(task)).toContain(`Link: the plan ${doc}`);
    expect(codingBrief(task)).toContain(`Link: the plan ${doc}`);
    expect(movesHelp()).toContain("- move link AUG-0000 <url> [--title <what it is, in a few words>]");
  });
});
