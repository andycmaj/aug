import { beforeEach, describe, expect, test } from "bun:test";
import { codingBrief, turnPrompt } from "../src/core/agents";
import { Engine } from "../src/core/engine";
import {
  projectContext,
  projectDetail,
  projectLine,
  projectProgress,
  taskLine,
} from "../src/core/lookup";
import { setMux } from "../src/core/mux";
import { applyProjectDoc, parseProjectDoc, renderProjectDoc } from "../src/core/project-doc";
import * as store from "../src/core/store";
import { GoalStatus, Kind, TaskStatus } from "../src/core/types";
import { FakeMux } from "./fake-mux";
import { fakeBrain, freshHome } from "./helpers";

let engine: Engine;

beforeEach(() => {
  freshHome();
  fakeBrain(() => null);
  setMux(new FakeMux());
  engine = new Engine();
});

const notion = "https://notion.so/ledger-plan";

function ledger() {
  return store.createProject({ name: "Ledger", tmuxSession: "ledger" });
}

describe("project brief, goals and docs", () => {
  test("moves write the brief, add goals and attach docs", async () => {
    const p = ledger();
    expect(
      await engine.runMove("project_brief", { project: "ledger", text: " Ship the ledger export. " }),
    ).toEqual({ ok: true, result: "Ledger's brief rewritten" });
    const goal = await engine.runMove("goal_new", { project: "Ledger", title: "CSV export works" });
    const g = store.goalsForProject(p.id)[0];
    expect(goal.result).toBe(`${store.goalRef(g.id)} added to Ledger: CSV export works`);
    const link = await engine.runMove("project_link", { project: "Ledger", url: notion, title: "the plan" });
    expect(link.result).toBe(`linked the plan (${notion}) to Ledger`);
    expect(store.getProject(p.id)!.brief).toBe("Ship the ledger export.");
    expect(store.linksForProject(p.id).map((l) => [l.url, l.title])).toEqual([[notion, "the plan"]]);

    const bad = await engine.runMove("project_link", { project: "Ledger", url: "file:///etc/passwd" });
    expect(bad.ok).toBe(false);
    const miss = await engine.runMove("project_unlink", { project: "Ledger", url: "https://x.test" });
    expect(miss.result).toBe(`Ledger has no link https://x.test. Links: ${notion}`);
    expect((await engine.runMove("project_unlink", { project: "Ledger", url: notion })).ok).toBe(true);
    expect(store.linksForProject(p.id)).toEqual([]);
  });

  test("goal_set marks a goal met and back, and refuses an unknown status", async () => {
    const p = ledger();
    const g = store.addGoal(p.id, "CSV export works");
    const ref = store.goalRef(g.id);
    expect((await engine.runMove("goal_set", { goal: ref, status: "met" })).result).toBe(
      `${ref} [met] CSV export works`,
    );
    expect(store.getGoal(g.id)!.met_at).not.toBeNull();
    await engine.runMove("goal_set", { goal: ref.toLowerCase(), status: "open", title: "CSV and XLSX" });
    expect(store.getGoal(g.id)).toMatchObject({ status: "open", met_at: null, title: "CSV and XLSX" });
    const bad = await engine.runMove("goal_set", { goal: ref, status: "done" });
    expect(bad).toEqual({ ok: false, result: "status must be open | met | dropped: got done" });
    const none = await engine.runMove("goal_set", { goal: ref });
    expect(none.result).toBe("goal_set needs --status or --title");
    const missing = await engine.runMove("goal_set", { goal: "G999", status: "met" });
    expect(missing.result).toBe("no goal G999.");
  });

  test("new --goal places the task in the goal's project; without one it names the goals", async () => {
    const p = ledger();
    const g = store.addGoal(p.id, "CSV export works");
    const ref = store.goalRef(g.id);
    const made = await engine.runMove("new", { title: "Write the exporter", goal: ref });
    const task = store.listTasks().at(-1)!;
    expect(made.result).toBe(`${store.taskRef(task.id)} made (general in project Ledger for ${ref})`);
    expect(task).toMatchObject({ project_id: p.id, goal_id: g.id });

    const loose = await engine.runMove("new", { title: "Tidy", project: "Ledger" });
    const tidy = store.listTasks().at(-1)!;
    expect(loose.result).toContain(`It serves no goal; Ledger's are ${ref} CSV export works.`);
    expect((await engine.runMove("goal", { task: store.taskRef(tidy.id), goal: ref })).ok).toBe(true);
    expect(store.getTask(tidy.id)!.goal_id).toBe(g.id);

    const other = store.createProject({ name: "Other", tmuxSession: "other" });
    const wrong = await engine.runMove("new", { title: "x", project: "Other", goal: ref });
    expect(wrong.result).toBe(`no goal ${ref} in Other.`);
    expect(store.goalsForProject(other.id)).toEqual([]);
  });

  test("a task leaves its goal behind when it moves to another project", async () => {
    const p = ledger();
    store.createProject({ name: "Other", tmuxSession: "other" });
    const g = store.addGoal(p.id, "CSV export works");
    const task = engine.desk.newTask("x", Kind.general, "", { projectId: p.id, goalId: g.id });
    await engine.runMove("project", { task: store.taskRef(task.id), project: "Other" });
    expect(store.getTask(task.id)!.goal_id).toBeNull();
  });

  test("an agent may set its own goal and attach project docs, not rewrite the brief or goals", async () => {
    const p = ledger();
    const g = store.addGoal(p.id, "CSV export works");
    const task = engine.desk.newTask("x", Kind.coding, "", { projectId: p.id });
    const by = `agent ${store.taskRef(task.id)}`;
    const goal = await engine.runMove("goal", { task: store.taskRef(task.id), goal: store.goalRef(g.id) }, by);
    expect(goal.ok).toBe(true);
    expect((await engine.runMove("project_link", { project: "Ledger", url: notion }, by)).ok).toBe(true);
    for (const [verb, args] of [
      ["project_brief", { project: "Ledger", text: "mine now" }],
      ["goal_new", { project: "Ledger", title: "more" }],
      ["goal_set", { goal: store.goalRef(g.id), status: "met" }],
    ] as const) {
      const out = await engine.runMove(verb, args, by);
      expect(out.result).toStartWith(`${verb} is the owner's move`);
    }
  });
});

describe("progress against goals", () => {
  test("each goal counts its tasks; open work for no goal is loose", () => {
    const p = ledger();
    const csv = store.addGoal(p.id, "CSV export works");
    const xlsx = store.addGoal(p.id, "XLSX export works");
    store.addGoal(p.id, "PDF");
    store.updateGoal(store.goalsForProject(p.id)[2].id, { status: GoalStatus.dropped });
    store.updateGoal(csv.id, { status: GoalStatus.met });
    const a = engine.desk.newTask("a", Kind.general, "", { projectId: p.id, goalId: csv.id });
    engine.desk.newTask("b", Kind.general, "", { projectId: p.id, goalId: xlsx.id });
    const loose = engine.desk.newTask("c", Kind.general, "", { projectId: p.id });
    store.updateTask(a.id, { status: TaskStatus.done });

    const progress = projectProgress(p);
    expect(progress.goals.map((g) => [g.goal.title, g.done, g.open, g.tasks.length])).toEqual([
      ["CSV export works", 1, 0, 1],
      ["XLSX export works", 0, 1, 1],
      ["PDF", 0, 0, 0],
    ]);
    expect(progress.loose.map((t) => t.id)).toEqual([loose.id]);
    expect(projectLine(p)).toEndWith("; goals 1/2 met");

    const detail = projectDetail(store.getProject(p.id)!);
    expect(detail).toContain("No brief yet.");
    expect(detail).toContain(`${store.goalRef(csv.id)} [met] CSV export works: 1/1 tasks done`);
    expect(detail).toContain(`${store.goalRef(xlsx.id)} [open] XLSX export works: 0/1 tasks done`);
    expect(detail).not.toContain("PDF");
    expect(detail).toContain(`Open tasks for no goal:\n  ${taskLine(loose)}`);
  });
});

describe("what a task in a project is told", () => {
  test("the coding brief and a turn carry the project's brief, goals and docs", () => {
    const p = ledger();
    store.updateProject(p.id, { brief: "Ship the ledger export." });
    const g = store.addGoal(p.id, "CSV export works");
    store.addProjectLink(p.id, notion, "the plan", "you");
    const task = engine.desk.newTask("x", Kind.coding, "do x", { projectId: p.id, goalId: g.id });
    const ref = store.goalRef(g.id);
    const context = projectContext(task);
    expect(context).toBe(
      [
        "## The project: Ledger",
        "Ship the ledger export.",
        `This task works toward ${ref}: CSV export works`,
        `Project goals:\n- ${ref} [open] CSV export works`,
        `Project doc: the plan ${notion}`,
      ].join("\n"),
    );
    expect(codingBrief(task)).toContain(context);
    expect(turnPrompt(task, [], "test")).toContain(context);
  });

  test("a project with nothing written adds nothing", () => {
    const p = ledger();
    const task = engine.desk.newTask("x", Kind.coding, "", { projectId: p.id });
    expect(projectContext(task)).toBe("");
    expect(codingBrief(task)).not.toContain("## The project");
  });
});

describe("the project file the owner edits", () => {
  test("it renders the brief, goals and docs, and an unchanged file changes nothing", () => {
    const p = ledger();
    store.updateProject(p.id, { brief: "Ship the ledger export." });
    const g = store.addGoal(p.id, "CSV export works");
    store.addProjectLink(p.id, notion, "the plan", "you");
    const text = renderProjectDoc(store.getProject(p.id)!);
    expect(text).toContain(`## Goals\n- [ ] ${store.goalRef(g.id)} CSV export works`);
    expect(text).toContain(`## Docs\n- the plan ${notion}`);
    expect(parseProjectDoc(text)).toEqual({
      brief: "Ship the ledger export.",
      goals: [{ id: g.id, title: "CSV export works", status: GoalStatus.open }],
      docs: [{ url: notion, title: "the plan" }],
    });
    expect(applyProjectDoc(p.id, text, "you")).toBe("");
  });

  test("editing it retitles, meets, adds and drops goals and rewrites docs", () => {
    const p = ledger();
    const csv = store.addGoal(p.id, "CSV export works");
    const pdf = store.addGoal(p.id, "PDF export");
    store.addProjectLink(p.id, notion, "the plan", "you");
    const task = engine.desk.newTask("x", Kind.general, "", { projectId: p.id, goalId: csv.id });
    const edited = [
      "# Ledger",
      "Ship the export.",
      "",
      "Both formats, by Friday.",
      "## Goals",
      `- [x] ${store.goalRef(csv.id)} CSV export, all columns`,
      "- [ ] XLSX export works",
      "- [ ]",
      "## Docs",
      "- https://example.com/spec",
      "- not a link",
    ].join("\n");
    expect(applyProjectDoc(p.id, edited, "you")).toBe(
      "Ledger: brief rewritten, 1 goal added, 1 goal changed, 1 goal dropped, docs updated",
    );
    expect(store.getProject(p.id)!.brief).toBe("Ship the export.\n\nBoth formats, by Friday.");
    const goals = store.goalsForProject(p.id);
    expect(goals.map((g) => [g.id, g.title, g.status])).toEqual([
      [csv.id, "CSV export, all columns", GoalStatus.met],
      [pdf.id, "PDF export", GoalStatus.dropped],
      [goals[2].id, "XLSX export works", GoalStatus.open],
    ]);
    // The task still points at its goal, retitled.
    expect(store.getTask(task.id)!.goal_id).toBe(csv.id);
    expect(store.linksForProject(p.id).map((l) => [l.url, l.title])).toEqual([
      ["https://example.com/spec", null],
    ]);
  });

  test("a doc line without a title clears the old one", () => {
    const p = ledger();
    store.addProjectLink(p.id, notion, "the plan", "you");
    applyProjectDoc(p.id, `## Docs\n- ${notion}`, "you");
    expect(store.linksForProject(p.id).map((l) => l.title)).toEqual([null]);
  });
});
