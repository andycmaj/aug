import { beforeEach, describe, expect, test } from "bun:test";
import { Lane, laneOf, boardColumnOf } from "../src/core/lanes";
import {
  buildRail,
  flattenRail,
  foldRail,
  nextKey,
  isSlipped,
  ageLabel,
  WALKED,
  RAIL_FILTERS,
  filterOf,
  filterRail,
  filterCounts,
  cycleFilter,
  type RailFilter,
} from "../src/core/rail";
import { railProjects } from "../src/core/lookup";
import { taskClosed } from "../src/core/lifecycle";
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
    taskClosed(gone.id);
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

  test("a task a review request filed sits under Code Reviews, after Tasks, and is walked", () => {
    const mine = store.createTask({
      title: "mine",
      kind: Kind.task,
      channel: "owner",
      createdAt: at(8),
    });
    const review = store.createTask({
      title: "review web#88",
      kind: Kind.reply,
      channel: "github",
      createdAt: at(7),
    });
    const mention = store.createTask({
      title: "mentioned on web#90",
      kind: Kind.reply,
      channel: "github",
      createdAt: at(6),
    });
    const file = (id: string, taskId: number, reason: string) => {
      const m = store.insertMessage({
        channel: "github",
        externalId: id,
        threadKey: `github:northwind/web#${id}`,
        author: "priya",
        authorName: "priya",
        title: "t",
        body: "b",
        receivedAt: at(6),
        meta: { repo: "northwind/web", type: "PullRequest", reason },
      })!;
      store.fileMessage(m.id, "reply", null, taskId);
    };
    file("88", review.id, "review_requested");
    file("90", mention.id, "mention");
    expect([...store.tasksFromReviewRequests()]).toEqual([review.id]);

    const rail = buildRail({
      tasks: store.listTasks(),
      pendingActions: new Set(),
      reviews: store.tasksFromReviewRequests(),
      ideas: [],
      fyi: [],
      lastHeard: new Map(),
      now: new Date(at(12)),
    });
    expect(rail.map((s) => s.section)).toEqual(["tasks", "reviews"]);
    const titles = (i: number) =>
      rail[i].items.map((x) => (x.type === "task" ? x.task.title : ""));
    expect(titles(0)).toEqual(["mentioned on web#90", "mine"]);
    expect(titles(1)).toEqual(["review web#88"]);
    expect(WALKED).toContain("reviews");
    void mine;
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

  function railNow() {
    return buildRail({
      home: store.homeTask(),
      projects: railProjects(),
      tasks: store.listTasks(),
      pendingActions: new Set(),
      ideas: [],
      fyi: [],
      lastHeard: new Map(),
      now: new Date(),
    });
  }

  test("each active project is a row in Tasks with its open tasks under it, then tasks in no project", () => {
    const api = store.createProject({ name: "api", tmuxSession: "api", repos: ["acme/api"] });
    const old = store.createProject({ name: "old", tmuxSession: "old" });
    store.archiveProject(old.id);
    const a = store.createTask({ title: "a", kind: Kind.coding, channel: "owner", projectId: api.id, createdAt: at(2) });
    store.createTask({ title: "b", kind: Kind.coding, channel: "owner", projectId: api.id, createdAt: at(1) });
    const c = store.createTask({ title: "c", kind: Kind.coding, channel: "owner", projectId: api.id });
    store.createTask({ title: "loose", kind: Kind.task, channel: "owner", createdAt: at(0) });
    store.createTask({ title: "archived's", kind: Kind.coding, channel: "owner", projectId: old.id, createdAt: at(3) });
    store.updateTask(a.id, { agent_state: AgentState.working });
    taskClosed(c.id);

    const rail = railNow();
    expect(rail.map((s) => s.section)).toEqual(["home", "tasks"]);
    const rows = rail[1].items;
    expect(rows[0]).toMatchObject({
      type: "project",
      key: `p${api.id}`,
      open: 2,
      working: 1,
      repos: ["acme/api"],
    });
    expect(
      rows.map((i) => (i.type === "task" ? `${i.task.title}:${i.group ?? "-"}` : i.key)),
    ).toEqual([`p${api.id}`, `b:${api.id}`, `a:${api.id}`, "loose:-", "archived's:-"]);
    expect(rail[1].count).toBe(4);
  });

  test("a project with nothing open still has its row", () => {
    const api = store.createProject({ name: "api", tmuxSession: "api" });
    const rail = railNow();
    expect(flattenRail(rail).map((i) => i.key)).toContain(`p${api.id}`);
  });

  test("a folded project keeps its row and hides its tasks; the count does not change", () => {
    const api = store.createProject({ name: "api", tmuxSession: "api" });
    const t = store.createTask({ title: "a", kind: Kind.coding, channel: "owner", projectId: api.id });
    const loose = store.createTask({ title: "loose", kind: Kind.task, channel: "owner" });
    const folded = foldRail(railNow(), new Set([api.id]));
    const keys = flattenRail(folded).map((i) => i.key);
    expect(keys).toContain(`p${api.id}`);
    expect(keys).not.toContain(`t${t.id}`);
    expect(keys).toContain(`t${loose.id}`);
    expect(folded.find((s) => s.section === "tasks")!.count).toBe(2);
  });

  test("projects and Home are never walked", () => {
    expect(WALKED).not.toContain("home");
  });
});

describe("the rail's status filter", () => {
  beforeEach(() => freshHome());

  function railNow(ideas = store.openIdeas()) {
    return buildRail({
      home: store.homeTask(),
      projects: railProjects(),
      tasks: store.listTasks(),
      pendingActions: new Set(),
      ideas,
      fyi: [],
      lastHeard: new Map(),
      now: new Date(),
    });
  }

  function setup() {
    const api = store.createProject({ name: "api", tmuxSession: "api" });
    const web = store.createProject({ name: "web", tmuxSession: "web" });
    const working = store.createTask({ title: "working", kind: Kind.coding, channel: "owner", projectId: api.id });
    const asks = store.createTask({ title: "asks", kind: Kind.coding, channel: "owner", projectId: web.id });
    const saved = store.createTask({ title: "saved", kind: Kind.coding, channel: "owner" });
    const mine = store.createTask({ title: "mine", kind: Kind.task, channel: "owner" });
    store.updateTask(working.id, { agent_state: AgentState.working });
    store.updateTask(asks.id, { agent_state: AgentState.blocked });
    store.updateTask(saved.id, { agent_state: AgentState.saved });
    return { api, web, working, asks, saved, mine };
  }

  test("every lane but done has a pill, and each lane only one", () => {
    const lanes = RAIL_FILTERS.flatMap((f) => f.lanes);
    expect(new Set(lanes).size).toBe(lanes.length);
    for (const lane of Object.values(Lane))
      expect(filterOf(lane) === null).toBe(lane === Lane.done);
  });

  test("no filter shows everything", () => {
    setup();
    const rail = railNow();
    expect(filterRail(rail, new Set())).toBe(rail);
  });

  test("a filter keeps Home, its tasks and the project rows they sit under", () => {
    const { api, web, working, saved } = setup();
    const keys = (active: RailFilter[]) =>
      flattenRail(filterRail(railNow(), new Set(active))).map((i) => i.key);
    expect(keys(["working"])).toEqual([`t${store.homeTask().id}`, `p${api.id}`, `t${working.id}`]);
    expect(keys(["working", "stopped"])).toEqual([
      `t${store.homeTask().id}`,
      `p${api.id}`,
      `t${working.id}`,
      `t${saved.id}`,
    ]);
    expect(keys(["queued"])).toEqual([`t${store.homeTask().id}`]);
    expect(keys(["asks"])).not.toContain(`p${api.id}`);
    expect(keys(["asks"])).toContain(`p${web.id}`);
  });

  test("Advisor ideas have no status, so any filter hides them", () => {
    setup();
    store.addIdea("idea", "body", null);
    const sections = (active: RailFilter[]) =>
      filterRail(railNow(), new Set(active)).map((s) => s.section);
    expect(sections([])).toContain("advisor");
    expect(sections(["open"])).not.toContain("advisor");
  });

  test("a section's count is what the filter left in it", () => {
    setup();
    const tasks = filterRail(railNow(), new Set<RailFilter>(["open", "stopped"]))
      .find((s) => s.section === "tasks")!;
    expect(tasks.count).toBe(2);
  });

  test("the pills count tasks, not Home", () => {
    setup();
    expect(filterCounts(railNow())).toEqual({
      asks: 1,
      send: 0,
      working: 1,
      queued: 0,
      stopped: 1,
      finished: 0,
      open: 1,
      waiting: 0,
    });
  });

  test("f steps through the statuses that have tasks, then back to all", () => {
    setup();
    const counts = filterCounts(railNow());
    const seen: string[] = [];
    let active = new Set<RailFilter>();
    do {
      active = cycleFilter(active, counts);
      seen.push([...active].join("+") || "all");
    } while (active.size > 0);
    expect(seen).toEqual(["asks", "working", "stopped", "open", "all"]);
    // From a mix of pills, f starts over at one.
    expect([...cycleFilter(new Set<RailFilter>(["open", "working"]), counts)]).toEqual(["asks"]);
  });
});
