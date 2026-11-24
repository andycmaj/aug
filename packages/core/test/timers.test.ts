import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { migrate } from "../src/db";
import * as store from "../src/store";
import { taskClosed, taskDropped } from "../src/lifecycle";
import {
  addFollowup,
  addSchedule,
  describeRule,
  fireDue,
  nextAfter,
  parseIn,
  parseRule,
  ruleText,
  timerLine,
} from "../src/timers";
import { Channel, Kind, TimerKind, TimerState } from "../src/types";
import { freshHome } from "./support/helpers";

// Local times: a rule is the owner's clock. 2026-11-20 is a Friday.
const local = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m);

describe("schedule rules", () => {
  test("read the forms the owner and the Assistant say", () => {
    expect(ruleText(parseRule("every weekday 09:00"))).toBe("weekdays 09:00");
    expect(ruleText(parseRule("Every weekday at 9am"))).toBe("weekdays 09:00");
    expect(ruleText(parseRule("daily 7:30pm"))).toBe("daily 19:30");
    expect(ruleText(parseRule("every day at 07:00"))).toBe("daily 07:00");
    expect(ruleText(parseRule("weekly on mon,thu 14:30"))).toBe("mon,thu 14:30");
    expect(ruleText(parseRule("Monday and Friday 08:15"))).toBe("mon,fri 08:15");
    expect(ruleText(parseRule("mon tue wed thu fri 9:00"))).toBe("weekdays 09:00");
    expect(describeRule("mon,thu 14:30")).toBe("every mon,thu at 14:30");
    expect(describeRule("weekdays 09:00")).toBe("every weekday at 09:00");
  });

  test("refuse what they cannot read, saying why", () => {
    expect(() => parseRule("weekdays")).toThrow("at what time?");
    expect(() => parseRule("9am")).toThrow("which days?");
    expect(() => parseRule("fortnightly 9am")).toThrow('"fortnightly" is neither');
    expect(() => parseRule("daily 25:00")).toThrow();
    expect(() => parseRule("daily 9")).toThrow();
    expect(() => parseRule("daily 13pm")).toThrow();
  });

  test("the next time is the first slot after now, skipping days off", () => {
    // Friday 10:00: today's 09:00 is gone, the weekend is skipped.
    expect(nextAfter("weekdays 09:00", local(20, 10))).toEqual(local(23, 9));
    // Friday 08:00: today's is still ahead.
    expect(nextAfter("weekdays 09:00", local(20, 8))).toEqual(local(20, 9));
    // Exactly on the slot: the next one, so a fired slot never fires twice.
    expect(nextAfter("daily 09:00", local(20, 9))).toEqual(local(21, 9));
    expect(nextAfter("mon,thu 14:30", local(20, 10))).toEqual(local(23, 14, 30));
    expect(nextAfter("sun 09:00", local(22, 9, 1))).toEqual(local(29, 9));
  });
});

describe("follow-up times", () => {
  test("--in takes minutes, hours, days and weeks", () => {
    const from = local(20, 10);
    expect(parseIn("30m", from)).toEqual(local(20, 10, 30));
    expect(parseIn("3h", from)).toEqual(local(20, 13));
    expect(parseIn("1d", from).getTime() - from.getTime()).toBe(86_400_000);
    expect(parseIn("2 weeks", from).getTime() - from.getTime()).toBe(14 * 86_400_000);
    expect(() => parseIn("tomorrow", from)).toThrow("30m, 3h, 1d or 2w");
    expect(() => parseIn("0m", from)).toThrow("at least a minute");
  });
});

describe("firing", () => {
  beforeEach(() => freshHome());

  test("a due follow-up becomes one message on the inbox and is done", () => {
    const task = store.createTask({ title: "check the PR", kind: Kind.general, channel: "owner" });
    const timer = addFollowup(task.id, local(21, 9), "look at the review", "agent RIKER-0001");
    expect(fireDue(local(21, 8, 59))).toEqual([]);
    const fired = fireDue(local(21, 9, 0));
    expect(fired).toHaveLength(1);
    const m = fired[0]!;
    expect(m.channel).toBe(Channel.timer);
    expect(m.body).toBe("look at the review");
    expect(m.state).toBe("new");
    // Riker's own word: never a reply target nor "last heard".
    expect(m.from_me).toBe(1);
    expect(JSON.parse(m.meta)).toMatchObject({ timer: timer.id, task: task.id, kind: "followup" });
    expect(store.getTimer(timer.id)!.state).toBe(TimerState.done);
    expect(fireDue(local(25, 9))).toEqual([]);
  });

  test("a schedule moves to its next time when it fires", () => {
    const task = store.createTask({ title: "PR summary", kind: Kind.general, channel: "owner" });
    const timer = addSchedule(task.id, "weekdays 09:00", "summarize my open PRs", "you", local(20, 10));
    expect(timer.due_at).toBe(local(23, 9).toISOString());
    expect(fireDue(local(23, 9, 1))).toHaveLength(1);
    const after = store.getTimer(timer.id)!;
    expect(after.state).toBe(TimerState.pending);
    expect(after.due_at).toBe(local(24, 9).toISOString());
    expect(after.fired_at).toBe(local(23, 9, 1).toISOString());
  });

  test("a schedule missed while Riker was closed fires once, not once per slot", () => {
    const task = store.createTask({ title: "standup notes", kind: Kind.general, channel: "owner" });
    const timer = addSchedule(task.id, "daily 09:00", "", "you", local(16, 10));
    expect(timer.due_at).toBe(local(17, 9).toISOString());
    // Closed from the 16th to the 20th at 10:00: four slots went by.
    expect(fireDue(local(20, 10))).toHaveLength(1);
    expect(store.getTimer(timer.id)!.due_at).toBe(local(21, 9).toISOString());
    expect(fireDue(local(20, 11))).toEqual([]);
  });

  test("a timer whose task is gone is cancelled, not fired", () => {
    const task = store.createTask({ title: "x", kind: Kind.general, channel: "owner" });
    const timer = addFollowup(task.id, local(21, 9), "", "you");
    db().query("PRAGMA foreign_keys = OFF").run();
    db().query("DELETE FROM tasks WHERE id = ?").run(task.id);
    expect(fireDue(local(22, 9))).toEqual([]);
    expect(store.getTimer(timer.id)!.state).toBe(TimerState.cancelled);
  });

  test("closing a task cancels its follow-ups and reminder, keeps its schedule; dropping cancels all", () => {
    const a = store.createTask({ title: "a", kind: Kind.general, channel: "owner" });
    addFollowup(a.id, local(21, 9), "", "you");
    addSchedule(a.id, "daily 09:00", "", "you", local(20, 10));
    store.remindAt(a.id, local(22, 7).toISOString());
    taskClosed(a.id);
    expect(store.timersForTask(a.id).map((t) => t.kind)).toEqual([TimerKind.schedule]);
    const b = store.createTask({ title: "b", kind: Kind.general, channel: "owner" });
    addSchedule(b.id, "daily 09:00", "", "you", local(20, 10));
    taskDropped(b.id);
    expect(store.timersForTask(b.id)).toEqual([]);
  });

  test("a line for the header says what and when", () => {
    const task = store.createTask({ title: "x", kind: Kind.general, channel: "owner" });
    const f = addFollowup(task.id, local(21, 9), "check CI", "you");
    expect(timerLine(f, local(20, 9))).toBe("follow-up in 1d: check CI");
    expect(timerLine(f, local(21, 8, 30))).toBe("follow-up in 30m: check CI");
    const s = addSchedule(task.id, "weekdays 09:00", "", "you", local(20, 10));
    expect(timerLine(s, local(23, 6))).toBe("every weekday at 09:00 (next in 3h)");
  });
});

describe("reminders from before timers", () => {
  beforeEach(() => freshHome());

  test("a task put away keeps its day as one remind timer, once", () => {
    const task = store.createTask({ title: "x", kind: Kind.general, channel: "owner" });
    const day = local(25, 7).toISOString();
    store.updateTask(task.id, { status: "later", remind_at: day });
    migrate(db());
    migrate(db());
    const timers = store.timersForTask(task.id);
    expect(timers).toHaveLength(1);
    expect(timers[0]).toMatchObject({ kind: TimerKind.remind, due_at: day });
  });
});
