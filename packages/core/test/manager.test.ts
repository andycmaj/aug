import { beforeEach, describe, expect, test } from "bun:test";
import type { BrainCall } from "../src/brain";
import { db } from "../src/db";
import { Engine } from "../src/engine";
import { standingLine } from "../src/journal";
import { projectDetail, railProjects } from "../src/lookup";
import { overseerCandidates } from "../src/manager";
import { managerAsker } from "../src/moves";
import { setMux } from "../src/mux";
import { ManagerMark, managerMark } from "../src/rail";
import * as store from "../src/store";
import { AgentState, Kind, SpendRole, TaskStatus, TurnRole } from "../src/types";
import { FakeMux } from "./support/fake-mux";
import { fakeBrain, freshHome, testConfig } from "./support/helpers";

let engine: Engine;
let calls: BrainCall[];

beforeEach(() => {
  freshHome({ repos: { "acme/api": "/src/api" } });
  calls = fakeBrain(() => null, { costUsd: 0.01 });
  setMux(new FakeMux());
  engine = new Engine({ config: testConfig() });
});

function project(name = "Billing") {
  return store.createProject({
    name,
    tmuxSession: name.toLowerCase(),
    repos: ["acme/api"],
  });
}

function taskIn(projectId: number, title: string, kind: Kind = Kind.general) {
  return engine.desk.newTask(title, kind, "", { projectId });
}

const events = (taskId: number) =>
  db()
    .query("SELECT kind FROM task_events WHERE task_id = ?")
    .all(taskId) as { kind: string }[];

describe("a project's manager", () => {
  test("starts absent; the owner's first line makes it, hidden from everything that lists work", async () => {
    const p = project();
    const work = taskIn(p.id, "Invoice export");
    expect(store.managerOf(p.id)).toBeNull();
    expect(railProjects()[0]?.manager).toBeNull();

    await engine.desk.sayToProject(p.id, "where are we?");
    const manager = store.managerOf(p.id)!;
    expect(manager.kind).toBe(Kind.manager);
    expect(store.ensureManager(p.id).id).toBe(manager.id);
    expect(store.listTasks().map((t) => t.id)).toEqual([work.id]);
    expect(store.tasksForProject(p.id).map((t) => t.id)).toEqual([work.id]);
    expect(store.closedTasks().map((t) => t.id)).not.toContain(manager.id);
    expect(store.agentStates().map((t) => t.id)).not.toContain(manager.id);
    expect(events(manager.id)).toEqual([]);
    expect(railProjects()[0]?.manager?.id).toBe(manager.id);
  });

  test("a turn reads the project whole, asks as the manager and counts as manager spend", async () => {
    const p = project();
    store.updateProject(p.id, { brief: "Bill customers monthly." });
    const work = taskIn(p.id, "Invoice export");
    await engine.desk.sayToProject(p.id, `what is left on @${store.taskRef(work.id)}?`);
    await until(() => calls.length === 1 && !engine.pool.isRunning(store.managerOf(p.id)!.id));

    const manager = store.managerOf(p.id)!;
    const call = calls[0];
    expect(call.system).toContain("You are the manager of the project Billing");
    expect(call.system).toContain("move project_standing");
    expect(call.system).not.toContain("move noise");
    expect(call.system).not.toContain("move project_archive");
    expect(call.env).toMatchObject({ RIKER_ASKED_BY: managerAsker(manager) });
    expect(call.prompt).toContain("## The project now");
    expect(call.prompt).toContain("Bill customers monthly.");
    expect(call.prompt).toContain(`${store.taskRef(work.id)} [general, open`);
    expect(call.prompt).toContain("## Tasks the owner named");
    expect(call.prompt).not.toContain("Manager: ");
    expect(call.spend).toMatchObject({ role: SpendRole.manager, taskId: manager.id });

    const answer = store.turnsForTask(manager.id).at(-1)!;
    expect(answer).toMatchObject({ role: TurnRole.agent, author: "manager", status: "done" });
  });

  test("its moves reach only its project's tasks; a project it names none of is its own", async () => {
    const p = project();
    const other = project("Search");
    const mine = taskIn(p.id, "Invoice export");
    const theirs = taskIn(other.id, "Index rebuild");
    const manager = store.ensureManager(p.id);
    const by = managerAsker(manager);

    expect(await engine.runMove("retitle", { task: store.taskRef(mine.id), title: "CSV export" }, by)).toMatchObject({ ok: true });
    const outside = await engine.runMove("retitle", { task: store.taskRef(theirs.id), title: "x" }, by);
    expect(outside).toMatchObject({ ok: false });
    expect(outside.result).toContain("not in Billing");
    expect(store.getTask(theirs.id)!.title).toBe("Index rebuild");

    const made = await engine.runMove("new", { title: "Dunning emails" }, by);
    expect(made.result).toContain("in project Billing");
    const dunning = store.listTasks().find((t) => t.title === "Dunning emails")!;
    expect(dunning.project_id).toBe(p.id);
    expect(dunning.from_task_id).toBe(manager.id);

    expect(await engine.runMove("project_brief", { text: "Bill monthly." }, by)).toMatchObject({ ok: true });
    expect(store.getProject(p.id)!.brief).toBe("Bill monthly.");
    expect(await engine.runMove("project_brief", { project: "Search", text: "x" }, by)).toMatchObject({ ok: false });
    expect(await engine.runMove("new", { title: "x", project: "Search" }, by)).toMatchObject({ ok: false });

    const noise = await engine.runMove("noise", { reason: "bots", author: "bot" }, by);
    expect(noise).toMatchObject({ ok: false });
    expect(noise.result).toContain("the owner's move");
    expect(await engine.runMove("project_archive", { project: "Billing" }, by)).toMatchObject({ ok: false });

    const g = store.addGoal(other.id, "Faster search");
    expect(await engine.runMove("goal_set", { goal: store.goalRef(g.id), status: "met" }, by)).toMatchObject({ ok: false });
    expect(await engine.runMove("retitle", { task: store.taskRef(manager.id), title: "x" }, by)).toMatchObject({ ok: false });
  });

  test("is not work to move: only tell and stop reach it", async () => {
    const p = project();
    const manager = store.ensureManager(p.id);
    const done = await engine.runMove("done", { task: store.taskRef(manager.id) });
    expect(done).toMatchObject({ ok: false });
    expect(done.result).toContain("Billing's manager");
    expect(await engine.runMove("tell", { task: store.taskRef(manager.id), text: "status?" })).toMatchObject({ ok: true });
    expect(store.turnsForTask(manager.id).some((t) => t.body === "status?")).toBe(true);
  });

  test("the standing it writes shows in the project's detail and its journal's status", async () => {
    const p = project();
    const manager = store.ensureManager(p.id);
    const by = managerAsker(manager);
    const wrote = await engine.runMove("project_standing", { text: "Export done.\nNext: dunning." }, by);
    expect(wrote).toMatchObject({ ok: true, result: "Billing's standing written" });
    const fresh = store.getProject(p.id)!;
    expect(fresh.standing).toBe("Export done.\nNext: dunning.");
    expect(projectDetail(fresh)).toContain("Standing (");
    expect(projectDetail(fresh)).toContain(`Manager: ${store.taskRef(manager.id)}`);
    expect(standingLine(fresh)[0]).toContain("Export done.; Next: dunning.");
    // Its own write is not echoed into its chat; the owner's is.
    expect(store.turnsForTask(manager.id)).toHaveLength(0);
    await engine.runMove("project_standing", { project: "Billing", text: "Paused." });
    expect(store.turnsForTask(manager.id).at(-1)!.body).toContain("you wrote the standing");
  });
});

describe("promoting a task to manager", () => {
  test("an overview task becomes the manager, keeping its chat; undo puts it back", async () => {
    const p = project();
    const overview = taskIn(p.id, "Billing overview");
    store.addTurn({ taskId: overview.id, role: TurnRole.you, author: "you", body: "the plan is A then B" });
    expect(overseerCandidates(store.tasksForProject(p.id)).map((t) => t.id)).toEqual([overview.id]);

    const moved = await engine.runMove("manager", { task: store.taskRef(overview.id) });
    expect(moved).toMatchObject({ ok: true });
    expect(store.managerOf(p.id)?.id).toBe(overview.id);
    expect(store.listTasks().map((t) => t.id)).not.toContain(overview.id);
    expect(store.turnsForTask(overview.id).map((t) => t.body)).toContain("the plan is A then B");

    expect((await engine.desk.undo()).ok).toBe(true);
    expect(store.getTask(overview.id)!.kind).toBe(Kind.general);
    expect(store.managerOf(p.id)).toBeNull();
  });

  test("one manager to a project", async () => {
    const p = project();
    store.ensureManager(p.id);
    const again = taskIn(p.id, "Other overview");
    const second = await engine.runMove("manager", { task: store.taskRef(again.id) });
    expect(second).toMatchObject({ ok: false });
    expect(second.result).toContain("already has a manager");
  });

  test("refuses a task in no project and one whose agent runs", async () => {
    const loose = engine.desk.newTask("Overview", Kind.general);
    expect(engine.desk.promoteManager(loose.id)).toMatchObject({ ok: false });
    const p = project();
    const running = taskIn(p.id, "Plan");
    store.updateTask(running.id, { agent_state: AgentState.working });
    engine.pool.isRunning = (id: number) => id === running.id;
    const refused = engine.desk.promoteManager(running.id);
    expect(refused).toMatchObject({ ok: false });
    if (!refused.ok) expect(refused.why).toContain("stop it first");
  });

  test("a closed overview comes back open as the manager", () => {
    const p = project();
    const t = taskIn(p.id, "Roadmap");
    store.updateTask(t.id, { status: TaskStatus.done, closed_at: new Date().toISOString() });
    expect(engine.desk.promoteManager(t.id)).toMatchObject({ ok: true });
    expect(store.getTask(t.id)!.status).toBe(TaskStatus.open);
  });
});

describe("the rail's manager mark", () => {
  const now = new Date("2026-11-25T12:00:00Z");
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
  test("working while a turn runs, active within the idle hour, asleep past it, none without one", () => {
    expect(managerMark(null, now, 55)).toBeNull();
    expect(managerMark({ id: 1, state: AgentState.working, lastAt: at(500) }, now, 55)).toBe(ManagerMark.working);
    expect(managerMark({ id: 1, state: AgentState.ready, lastAt: at(10) }, now, 55)).toBe(ManagerMark.active);
    expect(managerMark({ id: 1, state: AgentState.waiting, lastAt: at(10) }, now, 55)).toBe(ManagerMark.waiting);
    expect(managerMark({ id: 1, state: AgentState.ready, lastAt: at(60) }, now, 55)).toBe(ManagerMark.asleep);
    expect(managerMark({ id: 1, state: AgentState.none, lastAt: null }, now, 55)).toBe(ManagerMark.asleep);
    // Just promoted: its task changed now, but no manager turn has run.
    expect(managerMark({ id: 1, state: AgentState.none, lastAt: at(0) }, now, 55)).toBe(ManagerMark.asleep);
    expect(managerMark({ id: 1, state: AgentState.stopped, lastAt: at(1) }, now, 55)).toBe(ManagerMark.asleep);
  });
});

async function until(ok: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!ok()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await Bun.sleep(5);
  }
}
