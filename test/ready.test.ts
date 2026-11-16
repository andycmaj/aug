import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { migrate } from "../src/core/db";
import { handleDone, handleHook } from "../src/core/hooks";
import { Lane, laneOf } from "../src/core/lanes";
import {
  finishSuperseded,
  sessionActivity,
  sessionEnded,
  sessionStarted,
  taskClosed,
  turnFinished,
  workFinished,
  workMerged,
} from "../src/core/lifecycle";
import { filterOf, RAIL_FILTERS, RailFilter } from "../src/core/rail";
import * as store from "../src/core/store";
import {
  AgentState,
  Kind,
  PrState,
  SessionKind,
  TaskStatus,
} from "../src/core/types";
import { freshHome } from "./helpers";

// Ready for review (AUG-0113): the agent is finished and the result waits on
// the owner. docs/rail-status-design.md has the states and the lane order.

let n = 0;

function coding() {
  return store.createTask({ title: `c${++n}`, kind: Kind.coding, channel: "github" });
}

function start(taskId: number, startedBy: "aug" | "owner" = "aug") {
  const id = `s${++n}`;
  sessionStarted({ id, taskId, kind: SessionKind.tmux, cwd: "/w", startedBy });
  return { taskId, sessionId: id };
}

const fresh = (id: number) => store.getTask(id)!;
const lane = (id: number, facts: Partial<Parameters<typeof laneOf>[1]> = {}) =>
  laneOf(fresh(id), { hasPendingAction: false, ...facts });

describe("ready for review", () => {
  beforeEach(() => freshHome());

  test("done on an owner's session leaves the task open, ready, yours to close", () => {
    const t = coding();
    const ref = start(t.id, "owner");
    handleDone(ref, { summary: "committed 5199e4c, not pushed" });
    expect(fresh(t.id).status).toBe(TaskStatus.open);
    expect(fresh(t.id).agent_state).toBe(AgentState.ready);
    expect(lane(t.id)).toBe(Lane.ready);
    const last = store.turnsForTask(t.id).at(-1)!;
    expect(last.next).toStartWith("Ready for review: yours to close");
  });

  test("reading the result keeps an open task ready; only closing ends it", () => {
    const t = coding();
    const ref = start(t.id, "owner");
    workFinished(ref, { summary: "done", closes: false });
    store.updateTask(t.id, { unread_result: 0 });
    expect(lane(t.id)).toBe(Lane.ready);
    taskClosed(t.id);
    expect(lane(t.id)).toBe(Lane.done);
  });

  test("a task its agent closed is ready until the result is read", () => {
    const t = coding();
    const ref = start(t.id);
    handleDone(ref, { summary: "fixed" });
    expect(fresh(t.id).status).toBe(TaskStatus.done);
    expect(lane(t.id)).toBe(Lane.ready);
    store.updateTask(t.id, { unread_result: 0 });
    expect(lane(t.id)).toBe(Lane.done);
  });

  test("winding down and the window closing leave it ready", () => {
    const t = coding();
    const ref = start(t.id, "owner");
    workFinished(ref, { summary: "done", closes: false });
    handleHook("stop", { last_assistant_message: "Next steps: yours to close" }, ref);
    sessionActivity(ref, AgentState.waiting, "asked you something");
    expect(fresh(t.id).agent_state).toBe(AgentState.ready);
    sessionEnded(ref, "its window closed");
    expect(fresh(t.id).agent_state).toBe(AgentState.ready);
  });

  test("new input from the owner clears it", () => {
    const t = coding();
    const ref = start(t.id, "owner");
    workFinished(ref, { summary: "done", closes: false });
    handleHook("prompt", {}, ref);
    expect(fresh(t.id).agent_state).toBe(AgentState.working);
    expect(lane(t.id)).toBe(Lane.working);
  });

  test("restarting the agent clears it", () => {
    const t = coding();
    const ref = start(t.id, "owner");
    workFinished(ref, { summary: "done", closes: false });
    sessionEnded(ref, "claude exited");
    start(t.id, "owner");
    expect(fresh(t.id).agent_state).toBe(AgentState.working);
    expect(fresh(t.id).unread_result).toBe(0);
  });

  test("new work landing on the task clears it", () => {
    const t = coding();
    workFinished(start(t.id, "owner"), { summary: "done", closes: false });
    finishSuperseded(t.id);
    expect(fresh(t.id).agent_state).toBe(AgentState.none);
    expect(lane(t.id)).not.toBe(Lane.ready);
  });

  test("a chat turn that answers is ready; one that asks is waiting", () => {
    const a = store.createTask({ title: "a", kind: Kind.general, channel: "owner" });
    const b = store.createTask({ title: "b", kind: Kind.general, channel: "owner" });
    turnFinished(start(a.id), { asking: null });
    turnFinished(start(b.id), { asking: "which one?" });
    expect(lane(a.id)).toBe(Lane.ready);
    expect(lane(b.id)).toBe(Lane.waiting);
  });

  test("merged outranks ready: merged work only waits to be closed", () => {
    const t = coding();
    workFinished(start(t.id, "owner"), { summary: "done", closes: false });
    workMerged(t.id, "into main");
    expect(lane(t.id)).toBe(Lane.merged);
  });

  test("ready outranks an open PR and a blocker; a waiting agent and a draft outrank ready", () => {
    const t = coding();
    workFinished(start(t.id, "owner"), { summary: "done", closes: false });
    expect(lane(t.id, { prState: PrState.open })).toBe(Lane.ready);
    expect(lane(t.id, { blockers: 1 })).toBe(Lane.ready);
    expect(lane(t.id, { hasPendingAction: true })).toBe(Lane.approve);
  });

  test("ready and merged share the ready pill, right after asks", () => {
    expect(filterOf(Lane.ready)).toBe(RailFilter.ready);
    expect(filterOf(Lane.merged)).toBe(RailFilter.ready);
    expect(RAIL_FILTERS.map((f) => f.filter).slice(0, 2)).toEqual([
      RailFilter.asks,
      RailFilter.ready,
    ]);
  });
});

test("an old database's agentdone reads as ready", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, repo TEXT, agent_state TEXT)");
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, state TEXT)");
  db.exec("INSERT INTO tasks (agent_state) VALUES ('agentdone')");
  db.exec("INSERT INTO sessions (id, state) VALUES ('s', 'agentdone')");
  migrate(db);
  expect(db.query("SELECT agent_state FROM tasks").get()).toEqual({ agent_state: "ready" });
  expect(db.query("SELECT state FROM sessions").get()).toEqual({ state: "ready" });
});
