// Timers end to end: the engine's tick puts a due timer on the inbox, the
// worker's `timer` rule routes it to its task, and the desk wakes the agent.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { triagePlugin } from "../src/index";
import { Engine } from "@riker/core/engine";
import { inboxRows, InboxResult } from "@riker/core/inbox";
import { setMux } from "@riker/core/mux";
import * as store from "@riker/core/store";
import { addFollowup, addSchedule } from "@riker/core/timers";
import { Kind, TaskStatus, TimerState, TurnRole } from "@riker/core/types";
import { FakeMux } from "@riker/core/test/support/fake-mux";
import { fakeBrain, freshHome, testConfig } from "@riker/core/test/support/helpers";

const local = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m);

let engine: Engine;
let woke: { taskId: number; reason: string }[];

beforeEach(() => {
  freshHome();
  setMux(new FakeMux());
  // No model call: the timer rule claims before any rule asks one.
  fakeBrain(() => {
    throw new Error("a timer never asks the model");
  });
  engine = new Engine({ config: testConfig(), plugins: [triagePlugin()], offline: true });
  woke = [];
  engine.pool.request = (taskId: number, reason: string) => {
    woke.push({ taskId, reason });
    return null;
  };
});
afterEach(() => engine.stop());

async function tick(at: Date): Promise<number> {
  const fired = engine.fireTimers(at);
  await engine.triageInbox();
  return fired;
}

describe("a follow-up", () => {
  test("fires once and wakes the agent with its note", async () => {
    const task = engine.desk.newTask("Watch the deploy PR", Kind.general);
    const timer = addFollowup(task.id, local(21, 9), "check the PR again and report", "agent RIKER-0001");
    expect(await tick(local(21, 8))).toBe(0);
    expect(woke).toEqual([]);

    expect(await tick(local(21, 9, 1))).toBe(1);
    expect(store.getTimer(timer.id)!.state).toBe(TimerState.done);
    const line = store.turnsForTask(task.id).at(-1)!;
    expect(line.role).toBe(TurnRole.trigger);
    expect(line.body).toBe("Follow-up set by agent RIKER-0001 came due: check the PR again and report");
    expect(woke).toEqual([{ taskId: task.id, reason: line.body }]);

    // Once: the next ticks find nothing.
    expect(await tick(local(22, 9))).toBe(0);
    expect(woke).toHaveLength(1);

    // On the Inbox, under its task, with the chain that routed it.
    const row = inboxRows().find((r) => r.type === "message" && r.message.channel === "timer")!;
    expect(row.result).toBe(InboxResult.timer);
    expect(row.taskId).toBe(task.id);
    const [run] = store.triageRunsFor(row.type === "message" ? row.message.id : 0);
    expect(run!.rule).toBe("timer");
  });

  test("brings a task put away back to the rail", async () => {
    const task = engine.desk.newTask("Nudge Sam", Kind.general);
    engine.desk.remind(task.id, 5);
    addFollowup(task.id, local(21, 9), "did Sam answer?", "you");
    await tick(local(21, 9));
    expect(store.getTask(task.id)!.status).toBe(TaskStatus.open);
    // The put-away is over: its reminder goes with it.
    expect(store.timersForTask(task.id)).toEqual([]);
  });

  test("on a coding task: a live agent hears it in its window", async () => {
    const task = engine.desk.newTask("Fix the flaky test", Kind.coding);
    const driver = engine.drivers.for(task);
    let delivered = 0;
    driver.isLive = () => true;
    driver.deliver = async () => {
      delivered++;
      return true;
    };
    addFollowup(task.id, local(21, 9), "re-run CI", "agent RIKER-0001");
    await tick(local(21, 9));
    expect(delivered).toBe(1);
    expect(store.pendingTurns(task.id).map((t) => t.body)).toEqual([
      "Follow-up set by agent RIKER-0001 came due: re-run CI",
    ]);
  });

  test("on a coding task: a stopped agent resumes with it; one never started keeps it for Start", async () => {
    const stopped = engine.desk.newTask("Stopped one", Kind.coding);
    const never = engine.desk.newTask("Never started", Kind.coding);
    const driver = engine.drivers.for(stopped);
    const starts: number[] = [];
    driver.isLive = () => false;
    driver.resumes = (t) => (t.id === stopped.id ? "session-1" : undefined);
    driver.start = async (t) => {
      starts.push(t.id);
      return { type: "started", project: null };
    };
    addFollowup(stopped.id, local(21, 9), "check the review", "you");
    addFollowup(never.id, local(21, 9), "check the review", "you");
    await tick(local(21, 9));
    expect(starts).toEqual([stopped.id]);
    expect(store.pendingTurns(never.id)).toHaveLength(1);
  });
});

describe("a schedule", () => {
  test("opens its task again each time and wakes it, moving to the next time", async () => {
    const task = engine.desk.newTask("PR summary", Kind.general, "Summarize my open PRs");
    const timer = addSchedule(task.id, "weekdays 09:00", "Summarize my open PRs", "you", local(20, 10));
    await tick(local(23, 9));
    expect(woke).toHaveLength(1);
    expect(store.turnsForTask(task.id).at(-1)!.body).toBe(
      "Scheduled every weekday at 09:00: Summarize my open PRs",
    );
    await engine.desk.close(task.id);
    expect(store.getTimer(timer.id)!.due_at).toBe(local(24, 9).toISOString());
    await tick(local(24, 9));
    expect(store.getTask(task.id)!.status).toBe(TaskStatus.open);
    expect(woke).toHaveLength(2);
  });

  test("missed while Riker was closed, it fires once at start", async () => {
    const task = engine.desk.newTask("Standup notes", Kind.general);
    addSchedule(task.id, "daily 09:00", "", "you", local(16, 10));
    await tick(local(20, 10));
    expect(woke).toHaveLength(1);
    expect(store.messagesForTask(task.id)).toHaveLength(1);
  });
});

describe("a reminder", () => {
  test("brings the task back with a line, and wakes no one", async () => {
    const task = engine.desk.newTask("Renew the cert", Kind.general);
    store.remindAt(task.id, local(21, 7).toISOString());
    await tick(local(21, 7));
    expect(store.getTask(task.id)!.status).toBe(TaskStatus.open);
    expect(store.turnsForTask(task.id).at(-1)!.body).toBe("You asked to be reminded about this today");
    expect(woke).toEqual([]);
  });

  test("for a task already back, it does nothing", async () => {
    const task = engine.desk.newTask("Renew the cert", Kind.general);
    store.remindAt(task.id, local(21, 7).toISOString());
    // Brought back by hand, around the reminder's timer.
    store.updateTask(task.id, { status: TaskStatus.open, remind_at: null });
    const turns = store.turnsForTask(task.id).length;
    await tick(local(21, 7));
    expect(store.turnsForTask(task.id)).toHaveLength(turns);
  });
});

describe("Riker died between firing and routing", () => {
  test("the timer's message is routed at the next start", async () => {
    const task = engine.desk.newTask("Watch the deploy", Kind.general);
    addFollowup(task.id, local(21, 9), "look again", "you");
    // Fired (the message is on the inbox), never triaged.
    expect(engine.fireTimers(local(21, 9))).toBe(1);
    const restarted = new Engine({ config: testConfig(), plugins: [triagePlugin()], offline: true });
    restarted.pool.request = (taskId: number, reason: string) => {
      woke.push({ taskId, reason });
      return null;
    };
    await restarted.resumeTriage();
    restarted.stop();
    expect(woke).toEqual([{ taskId: task.id, reason: "Follow-up set by you came due: look again" }]);
  });
});
