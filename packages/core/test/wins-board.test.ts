import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, openDb, useDb } from "../src/db";
import { Lane } from "../src/lanes";
import { taskClosed, workFinished } from "../src/lifecycle";
import { localDay } from "../src/rail";
import * as store from "../src/store";
import { Kind, SessionKind, TaskEventKind, TaskStatus, TurnRole, type TaskRow } from "../src/types";
import { dayBounds, Outcome, outcomeOf, shiftDay, winDetail, winsDay } from "../src/wins-board";
import { freshHome } from "./support/helpers";

beforeEach(() => freshHome());

const now = () => new Date();
const today = () => localDay(now());

function task(title: string, extra: Partial<store.NewTask> = {}): TaskRow {
  return store.createTask({ title, kind: Kind.general, channel: "owner", ...extra });
}

const kinds = (id: number) =>
  db()
    .query("SELECT kind FROM task_events WHERE task_id = ? ORDER BY id")
    .all(id)
    .map((r) => (r as { kind: string }).kind);

// Noon on a local day, as stored times are written.
function noon(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d, 12).toISOString();
}

describe("days", () => {
  test("shiftDay crosses months and years", () => {
    expect(shiftDay("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDay("2026-12-31", 1)).toBe("2027-01-01");
  });

  test("a day's bounds are its local midnights", () => {
    const { from, to } = dayBounds("2026-11-18");
    expect(new Date(from).getHours()).toBe(0);
    expect(new Date(from).getDate()).toBe(18);
    expect(new Date(to).getDate()).toBe(19);
  });
});

describe("task events", () => {
  test("every writer is heard: made, closed, reopened, merged, finished", () => {
    const t = task("one");
    store.createSession({ id: "s1", taskId: t.id, kind: SessionKind.tmux, cwd: "/", startedBy: "aug" });
    store.updateTask(t.id, { title: "renamed" });
    workFinished({ taskId: t.id, sessionId: "s1" }, { summary: "shipped it", closes: false });
    store.updateTask(t.id, { merged_at: new Date().toISOString() });
    taskClosed(t.id, "you");
    store.reopen(t.id);
    expect(kinds(t.id)).toEqual(["created", "finished", "merged", "done", "reopened"]);
    const done = store.eventsForTask(t.id, new Date(Date.now() + 1000).toISOString()).find((e) => e.kind === "done");
    expect(done?.detail).toBe("you");
  });

  test("later and back is not a reopen; Home has none", () => {
    const t = task("one");
    store.updateTask(t.id, { status: TaskStatus.later });
    store.updateTask(t.id, { status: TaskStatus.open });
    expect(kinds(t.id)).toEqual(["created", "later"]);
    expect(kinds(store.homeTask().id)).toEqual([]);
  });

  test("a database from before task_events is backfilled once from its columns", () => {
    const file = join(mkdtempSync(join(tmpdir(), "aug-ev-")), "aug.db");
    const first = openDb(file);
    first.exec("DROP TRIGGER ev_task_created; DROP TRIGGER ev_task_status; DROP TRIGGER ev_task_merged");
    first.exec("DELETE FROM kv WHERE key = 'events.backfilled'");
    first
      .query(
        "INSERT INTO tasks (title, kind, status, created_at, updated_at, closed_at, closed_by, merged_at) VALUES ('old', 'coding', 'done', '2026-11-01T10:00:00.000Z', 'x', '2026-11-02T10:00:00.000Z', 'agent', '2026-11-02T09:00:00.000Z')",
      )
      .run();
    first.close();
    const second = openDb(file);
    useDb(second);
    expect(kinds(1)).toEqual(["created", "done", "merged"]);
    second.close();
    const third = openDb(file);
    useDb(third);
    expect(kinds(1)).toHaveLength(3);
    third.close();
  });
});

describe("outcomeOf", () => {
  const ev = (kind: string) => ({ id: 0, task_id: 1, kind, detail: null, at: "" }) as never;
  test("replays to where the task stood", () => {
    expect(outcomeOf([])).toBe(Outcome.open);
    expect(outcomeOf([ev(TaskEventKind.merged)])).toBe(Outcome.merged);
    expect(outcomeOf([ev(TaskEventKind.merged), ev(TaskEventKind.done)])).toBe(Outcome.done);
    expect(outcomeOf([ev(TaskEventKind.done), ev(TaskEventKind.reopened)])).toBe(Outcome.open);
    expect(outcomeOf([ev(TaskEventKind.dropped)])).toBe(Outcome.dropped);
  });
});

describe("winsDay", () => {
  test("yesterday's Wins keep how they came out after today moves them on", () => {
    const yday = shiftDay(today(), -1);
    const closed = task("closed yesterday");
    const open = task("still open");
    store.addWin(yday, closed.id);
    store.addWin(yday, open.id);
    store.updateTask(closed.id, { status: TaskStatus.done, closed_at: noon(yday), closed_by: "you" });
    // Today it came back.
    store.reopen(closed.id);

    const past = winsDay(yday, now());
    expect(past.isToday).toBe(false);
    expect(past.wins.map((w) => [w.task.id, w.outcome])).toEqual([
      [closed.id, Outcome.done],
      [open.id, Outcome.open],
    ]);
    expect(past.wins[0].events.map((e) => e.kind)).toEqual([TaskEventKind.done]);
    expect(past.wins[0].lane).toBeNull();

    const present = winsDay(today(), now());
    expect(present.wins).toEqual([]);
    expect(present.also.map((r) => r.task.id)).toEqual([]);
  });

  test("today's Wins say their lane; what else happened is also done, landed first", () => {
    const win = task("the win");
    const worked = task("talked about");
    const shipped = task("shipped");
    store.addWin(today(), win.id);
    store.addTurn({ taskId: worked.id, role: TurnRole.you, body: "hi" });
    store.addTurn({ taskId: worked.id, role: TurnRole.agent, body: "hello" });
    store.addTurn({ taskId: win.id, role: TurnRole.you, body: "go" });
    taskClosed(shipped.id, "you");
    store.addTurn({ taskId: store.homeTask().id, role: TurnRole.you, body: "home is not work" });
    store.enqueueMove("note", { task: "AUG-0001" }, "assistant");

    const d = winsDay(today(), now());
    expect(d.isToday).toBe(true);
    expect(d.wins.map((w) => [w.task.id, w.outcome, w.you])).toEqual([[win.id, Outcome.open, 1]]);
    expect(d.wins[0].lane).toBe(Lane.yours);
    expect(d.also.map((r) => [r.task.id, r.outcome])).toEqual([
      [shipped.id, Outcome.done],
      [worked.id, Outcome.open],
    ]);
    expect(d.also[1]).toMatchObject({ you: 1, agent: 1 });
    expect(d.made).toBe(3);
    expect(d.moves).toBe(1);
  });

  test("rows and their events read newest first", () => {
    const day = shiftDay(today(), -1);
    const [y, m, dd] = day.split("-").map(Number);
    const yAt = (h: number) => new Date(y, m - 1, dd, h).toISOString();
    const early = task("early win");
    const late = task("late win");
    const quiet = task("quiet win");
    store.addWin(day, early.id);
    store.addWin(day, late.id);
    store.addWin(day, quiet.id);
    store.addTurn({ taskId: early.id, role: TurnRole.you, body: "a", startedAt: yAt(9) });
    store.addTurn({ taskId: late.id, role: TurnRole.you, body: "b", startedAt: yAt(15) });
    const closedEarly = task("closed early");
    const talkedLate = task("talked late");
    store.updateTask(closedEarly.id, { merged_at: yAt(10) });
    store.updateTask(closedEarly.id, { status: TaskStatus.done, closed_at: yAt(11), closed_by: "you" });
    store.addTurn({ taskId: talkedLate.id, role: TurnRole.agent, body: "c", startedAt: yAt(17) });

    const d = winsDay(day, now());
    // No activity sorts after any; among the quiet, the later pinned first.
    expect(d.wins.map((w) => w.task.id)).toEqual([late.id, early.id, quiet.id]);
    expect(d.also.map((r) => r.task.id)).toEqual([talkedLate.id, closedEarly.id]);
    expect(d.also[1].events.map((e) => e.kind)).toEqual([TaskEventKind.done, TaskEventKind.merged]);
    expect(winDetail(closedEarly.id, day)!.events.map((e) => e.kind)).toEqual([TaskEventKind.done, TaskEventKind.merged]);
  });

  test("an empty day is empty", () => {
    const d = winsDay("2020-01-01", now());
    expect(d).toMatchObject({ wins: [], also: [], made: 0, moves: 0 });
  });
});

describe("winDetail", () => {
  test("the day's turns, moves naming it, and agent time clipped to the day", () => {
    const t = task("one");
    const yday = shiftDay(today(), -1);
    for (let i = 0; i < 8; i++) store.addTurn({ taskId: t.id, role: TurnRole.agent, body: `turn ${i}` });
    store.addTurn({ taskId: t.id, role: TurnRole.you, body: "yesterday", startedAt: noon(yday) });
    store.enqueueMove("note", { task: "AUG-0001" }, "assistant");
    store.enqueueMove("note", { task: "AUG-0099" }, "assistant");
    // Ran from yesterday noon to an hour past today's midnight.
    store.createSession({ id: "s1", taskId: t.id, kind: SessionKind.tmux, cwd: "/", startedBy: "aug" });
    const { from } = dayBounds(today());
    db()
      .query("UPDATE sessions SET started_at = ?, ended_at = ? WHERE id = 's1'")
      .run(noon(yday), new Date(Date.parse(from) + 3600_000).toISOString());

    const d = winDetail(t.id, today())!;
    expect(d.turns.map((x) => x.body)).toEqual(["turn 7", "turn 6", "turn 5", "turn 4", "turn 3", "turn 2"]);
    expect(d.moreTurns).toBe(2);
    expect(d.moves).toHaveLength(1);
    expect(d.agentMs).toBe(3600_000);
    expect(d.events.map((e) => e.kind)).toEqual([TaskEventKind.created]);
    expect(winDetail(t.id, yday)!.agentMs).toBe(12 * 3600_000);
  });
});
