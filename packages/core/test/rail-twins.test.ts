// A Win or a watched task is listed under its header and stays in
// its project. The two rows are one task: counted once, found once, walked
// once.

import { beforeEach, describe, expect, test } from "bun:test";
import {
  baseKey,
  buildRail,
  filterCounts,
  filterRail,
  flattenRail,
  foldRail,
  nextKey,
  rowFor,
  walkableKeys,
  type RailItem,
  type RailSection,
} from "../src/rail";
import { searchIndex } from "../src/search";
import { railProjects } from "../src/lookup";
import { taskClosed } from "../src/lifecycle";
import * as store from "../src/store";
import { AgentState, Kind } from "../src/types";
import { freshHome } from "./support/helpers";

const at = (h: number) => new Date(Date.UTC(2026, 10, 5, h)).toISOString();

function setup() {
  const project = store.createProject({ name: "api", tmuxSession: "api" });
  const make = (title: string, h: number) =>
    store.createTask({
      title,
      kind: Kind.coding,
      channel: "owner",
      projectId: project.id,
      createdAt: at(h),
    });
  const neither = make("neither", 1);
  const win = make("win", 2);
  const watched = make("watched", 3);
  const both = make("both", 4);
  store.setWatching(watched.id, true);
  store.setWatching(both.id, true);
  // Idle, so its lane is not watching and the row wears the ◉ tag.
  store.updateTask(watched.id, { agent_state: AgentState.idle });
  return { project, neither, win, watched, both };
}

function railNow(wins: number[]): RailSection[] {
  return buildRail({
    home: store.homeTask(),
    projects: railProjects(),
    tasks: store.listTasks(),
    pendingActions: new Set(),
    lastHeard: new Map(),
    now: new Date(at(12)),
    wins,
  });
}

const keysOf = (rail: RailSection[], section: string) =>
  rail.find((s) => s.section === section)?.items.map((i) => i.key) ?? [];

const task = (item: RailItem | null | undefined) =>
  item?.type === "task" ? item : null;

describe("a Win or watched task under its header and in its project", () => {
  beforeEach(() => freshHome());

  test("each sits in its project; Wins and Watching list their own as copies", () => {
    const { project, neither, win, watched, both } = setup();
    const rail = railNow([both.id, win.id]);
    expect(rail.map((s) => s.section)).toEqual([
      "home",
      "wins",
      "tasks",
      "watching",
    ]);
    expect(keysOf(rail, "tasks")).toEqual([
      `p${project.id}`,
      `t${neither.id}`,
      `t${win.id}`,
      `t${watched.id}`,
      `t${both.id}`,
    ]);
    expect(keysOf(rail, "wins")).toEqual([
      `t${both.id}@wins`,
      `t${win.id}@wins`,
    ]);
    expect(keysOf(rail, "watching")).toEqual([
      `t${watched.id}@watching`,
      `t${both.id}@watching`,
    ]);
    const items = flattenRail(rail);
    // Every row has its own key, so the cursor can tell them apart.
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
    for (const i of items) {
      if (i.type !== "task" || i.task.kind === Kind.home) {
        continue;
      }
      // Rows in the project nest under it; copies do not, and fold with
      // nothing.
      expect(i.group).toBe(i.copy ? null : project.id);
      expect(i.copy).toBe(i.key.includes("@"));
    }
  });

  test("the project's row shows its tags; a copy leaves out the one its header says", () => {
    const { neither, win, watched, both } = setup();
    const items = flattenRail(railNow([win.id, both.id]));
    const tags = (key: string) => task(items.find((i) => i.key === key))?.tags;
    expect(tags(`t${neither.id}`)).toEqual([]);
    expect(tags(`t${win.id}`)).toEqual(["win"]);
    expect(tags(`t${win.id}@wins`)).toEqual([]);
    expect(tags(`t${watched.id}`)).toEqual(["watching"]);
    expect(tags(`t${watched.id}@watching`)).toEqual([]);
    // Its lane is watching, whose mark already says so.
    expect(tags(`t${both.id}`)).toEqual(["win"]);
    expect(tags(`t${both.id}@wins`)).toEqual([]);
    expect(tags(`t${both.id}@watching`)).toEqual(["win"]);
  });

  test("headers count their own members; pills and the project count each task once", () => {
    const { project, win, both } = setup();
    const rail = railNow([win.id, both.id]);
    const count = (section: string) =>
      rail.find((s) => s.section === section)!.count;
    expect(count("tasks")).toBe(4);
    expect(count("wins")).toBe(2);
    expect(count("watching")).toBe(2);
    const pills = Object.values(filterCounts(rail)).reduce((a, b) => a + b, 0);
    expect(pills).toBe(4);
    const row = rail[2].items.find((i) => i.key === `p${project.id}`);
    expect(row?.type === "project" && row.open).toBe(4);
  });

  test("a filter keeps both rows of a task it keeps, and counts each header's own", () => {
    const { both } = setup();
    const rail = filterRail(railNow([both.id]), new Set(["waiting"]));
    // Only the two watched tasks are in a waiting lane (watching); the idle
    // one is not.
    expect(rail.map((s) => [s.section, s.count])).toEqual([
      ["home", 1],
      ["wins", 1],
      ["tasks", 1],
      ["watching", 1],
    ]);
    expect(filterCounts(railNow([both.id])).waiting).toBe(1);
  });

  test("folding the project hides its rows, not the copies under Wins or Watching", () => {
    const { project, win, watched } = setup();
    const shown = flattenRail(
      foldRail(railNow([win.id]), new Set([project.id])),
    ).map((i) => i.key);
    expect(shown).toContain(`t${win.id}@wins`);
    expect(shown).toContain(`t${watched.id}@watching`);
    expect(shown).not.toContain(`t${win.id}`);
    expect(shown).toContain(`p${project.id}`);
  });

  test("a task's key finds its own row; a copy's key finds the copy", () => {
    const { win } = setup();
    const items = flattenRail(railNow([win.id]));
    expect(rowFor(items, `t${win.id}`)?.key).toBe(`t${win.id}`);
    expect(rowFor(items, `t${win.id}@wins`)?.key).toBe(`t${win.id}@wins`);
    expect(baseKey(`t${win.id}@wins`)).toBe(`t${win.id}`);
    // Folded away, the task's key still finds it, under Wins.
    expect(
      rowFor(
        items.filter((i) => i.key !== `t${win.id}`),
        `t${win.id}`,
      )?.key,
    ).toBe(`t${win.id}@wins`);
  });

  test("a done Win has no row in its project: its row under Wins is its own", () => {
    const { win } = setup();
    taskClosed(win.id);
    const rail = railNow([win.id]);
    expect(keysOf(rail, "wins")).toEqual([`t${win.id}`]);
    expect(keysOf(rail, "tasks")).not.toContain(`t${win.id}`);
    expect(task(rowFor(flattenRail(rail), `t${win.id}`))?.copy).toBe(false);
  });

  test("Next walks each task once, at its first row, and never to the selected task's other row", () => {
    const { project, neither, win, watched, both } = setup();
    const rail = railNow([both.id, win.id]);
    const order = flattenRail(rail).map((i) => i.key);
    const walk = (from: string | null) =>
      nextKey(order, walkableKeys(rail, from && baseKey(from)), from, 1);
    const visited: string[] = [];
    let at: string | null = null;
    for (let n = walk(at); n; n = walk(at)) {
      visited.push(n);
      at = n;
    }
    expect(visited).toEqual([
      `t${both.id}@wins`,
      `t${win.id}@wins`,
      `t${neither.id}`,
      `t${watched.id}`,
    ]);
    // On a Win's row in its project, its copy under Wins is not a stop.
    expect(walkableKeys(rail, `t${win.id}`)).not.toContain(`t${win.id}@wins`);
    expect(
      nextKey(
        order,
        walkableKeys(rail, `t${neither.id}`),
        `t${neither.id}`,
        -1,
      ),
    ).toBe(`t${win.id}@wins`);
    void project;
  });

  test("up and down pass through every row, copies included, without repeats", () => {
    const { win, both } = setup();
    const order = flattenRail(railNow([win.id, both.id])).map((i) => i.key);
    // Each step moves to a different row: a duplicate key would stop the
    // cursor on it (indexOf finds the first).
    for (let i = 0; i < order.length; i++) {
      expect(order.indexOf(order[i])).toBe(i);
    }
  });

  test("search finds each task once, at its own row", () => {
    const { win, watched, both } = setup();
    const rail = railNow([win.id, both.id]);
    const docs = searchIndex(rail, { messages: new Map(), turns: new Map() });
    const keys = docs.map((d) => d.item.key);
    for (const id of [win.id, watched.id, both.id]) {
      expect(keys.filter((k) => baseKey(k) === `t${id}`)).toEqual([`t${id}`]);
    }
    expect(docs.find((d) => d.item.key === `t${both.id}`)?.section).toBe(
      "Tasks",
    );
  });
});
