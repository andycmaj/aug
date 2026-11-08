import { beforeEach, describe, expect, test } from "bun:test";
import { Lane, laneOf, boardColumnOf } from "../src/core/lanes";
import {
  buildRail,
  flattenRail,
  nextKey,
  isSlipped,
  ageLabel,
  WALKED,
} from "../src/core/rail";
import { railProjects } from "../src/core/lookup";
import * as store from "../src/core/store";
import { AgentState, Kind, TurnRole } from "../src/core/types";
import { freshHome } from "./helpers";

const at = (h: number) => new Date(Date.UTC(2026, 10, 5, h)).toISOString();

describe("lanes", () => {
  beforeEach(() => freshHome());

  test("an asking agent outranks a pending draft", () => {
    const t = store.createTask({
      title: "x",
      kind: Kind.general,
      channel: "slack",
    });
    store.updateTask(t.id, { agent_state: AgentState.blocked });
    expect(laneOf(store.getTask(t.id)!, { hasPendingAction: true })).toBe(
      Lane.blocked,
    );
    store.updateTask(t.id, { agent_state: AgentState.agentdone });
    expect(laneOf(store.getTask(t.id)!, { hasPendingAction: true })).toBe(
      Lane.approve,
    );
  });

  test("an incoming ask nobody works is 'asked you'; the owner's own to-do is 'on you'", () => {
    const a = store.createTask({
      title: "a",
      kind: Kind.reply,
      channel: "slack",
    });
    const b = store.createTask({
      title: "b",
      kind: Kind.task,
      channel: "owner",
    });
    expect(laneOf(a, { hasPendingAction: false })).toBe(Lane.asked);
    expect(laneOf(b, { hasPendingAction: false })).toBe(Lane.yours);
  });

  test("the Board leaves the owner's own to-dos and replies off", () => {
    const t = store.createTask({
      title: "t",
      kind: Kind.task,
      channel: "owner",
    });
    expect(
      boardColumnOf(t, { hasPendingAction: false }, "2026-11-05"),
    ).toBeNull();
    const c = store.createTask({
      title: "c",
      kind: Kind.coding,
      channel: "github",
    });
    store.updateTask(c.id, { agent_state: AgentState.queued });
    expect(
      boardColumnOf(
        store.getTask(c.id)!,
        { hasPendingAction: false },
        "2026-11-05",
      ),
    ).toBe("queued");
  });
});

describe("rail", () => {
  beforeEach(() => freshHome());

  test("sections in order, rows oldest first, done work gone, agent-finished kept until read", () => {
    const late = store.createTask({
      title: "late",
      kind: Kind.general,
      channel: "slack",
      createdAt: at(10),
    });
    const early = store.createTask({
      title: "early",
      kind: Kind.task,
      channel: "owner",
      createdAt: at(8),
    });
    const watched = store.createTask({
      title: "watched",
      kind: Kind.task,
      channel: "github",
      watching: true,
      createdAt: at(9),
    });
    const gone = store.createTask({
      title: "gone",
      kind: Kind.task,
      channel: "owner",
      createdAt: at(7),
    });
    store.markDone(gone.id);
    const finished = store.createTask({
      title: "finished",
      kind: Kind.coding,
      channel: "github",
      createdAt: at(6),
    });
    store.updateTask(finished.id, {
      agent_state: AgentState.agentdone,
      unread_result: 1,
      status: "done",
    });
    const later = store.createTask({
      title: "later",
      kind: Kind.task,
      channel: "owner",
      createdAt: at(5),
    });
    store.remindAt(later.id, at(30));

    const rail = buildRail({
      tasks: store.listTasks(),
      pendingActions: new Set(),
      ideas: [],
      fyi: [],
      lastHeard: new Map(),
      now: new Date(at(12)),
    });
    expect(rail.map((s) => s.section)).toEqual(["tasks", "watching", "later"]);
    expect(
      rail[0].items.map((i) => (i.type === "task" ? i.task.title : "")),
    ).toEqual(["finished", "early", "late"]);
    expect(rail[1].items).toHaveLength(1);
    expect(
      flattenRail(rail).some((i) => i.type === "task" && i.task.id === gone.id),
    ).toBe(false);
    void watched;
    void early;
    void late;
  });

  test("Next walks in order and skips sections the walk does not offer", () => {
    const order = ["t1", "t2", "l1", "m1"];
    const walkable = new Set(["t1", "t2", "m1"]);
    expect(nextKey(order, walkable, "t2", 1)).toBe("m1");
    expect(nextKey(order, walkable, "m1", -1)).toBe("t2");
    expect(nextKey(order, walkable, "m1", 1)).toBeNull();
    expect(nextKey(order, walkable, null, 1)).toBe("t1");
  });

  test("a thread waiting on them goes slipped after three quiet days", () => {
    const t = store.createTask({
      title: "x",
      kind: Kind.task,
      channel: "slack",
      createdAt: at(0),
    });
    store.updateTask(t.id, { waiting_on: "Ruth" });
    const row = store.getTask(t.id)!;
    expect(isSlipped(row, at(0), new Date(at(24)))).toBe(false);
    expect(isSlipped(row, at(0), new Date(at(24 * 4)))).toBe(true);
  });

  test("age labels", () => {
    const now = new Date(at(12));
    expect(ageLabel(at(12), now)).toBe("<5m");
    expect(ageLabel(at(9), now)).toBe("3h");
    expect(ageLabel(at(36), now)).toBe("in 1d");
  });

  test("reminders wake on their day with a line saying why", () => {
    const t = store.createTask({
      title: "x",
      kind: Kind.task,
      channel: "owner",
    });
    store.remindAt(t.id, at(1));
    expect(store.wakeReminders(at(2))).toBe(1);
    expect(store.getTask(t.id)!.status).toBe("open");
    expect(store.turnsForTask(t.id).at(-1)!.role).toBe(TurnRole.trigger);
  });
});

describe("projects on the rail", () => {
  beforeEach(() => freshHome());

  test("each active project is a row under Home, with its open and working counts", () => {
    const home = store.homeTask();
    const api = store.createProject({ name: "api", tmuxSession: "api", repos: ["acme/api"] });
    const old = store.createProject({ name: "old", tmuxSession: "old" });
    store.archiveProject(old.id);
    const a = store.createTask({ title: "a", kind: Kind.coding, channel: "owner", projectId: api.id });
    store.createTask({ title: "b", kind: Kind.coding, channel: "owner", projectId: api.id });
    const c = store.createTask({ title: "c", kind: Kind.coding, channel: "owner", projectId: api.id });
    store.updateTask(a.id, { agent_state: AgentState.working });
    store.markDone(c.id);

    const rail = buildRail({
      home,
      projects: railProjects(),
      tasks: store.listTasks(),
      pendingActions: new Set(),
      ideas: [],
      fyi: [],
      lastHeard: new Map(),
      now: new Date(),
    });
    expect(rail.map((s) => s.section)).toEqual(["home", "projects", "tasks"]);
    const rows = rail[1].items;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "project",
      key: `p${api.id}`,
      open: 2,
      working: 1,
      repos: ["acme/api"],
    });
  });

  test("projects are never walked", () => {
    expect(WALKED).not.toContain("projects");
    expect(WALKED).not.toContain("home");
  });
});
