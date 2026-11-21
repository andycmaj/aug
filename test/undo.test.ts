import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/core/config";
import { db } from "../src/core/db";
import { Engine } from "../src/core/engine";
import { HELD_FOR_START } from "../src/core/lifecycle";
import { setMux } from "../src/core/mux";
import { localDay } from "../src/core/rail";
import * as store from "../src/core/store";
import { UndoStack } from "../src/core/undo";
import { AgentState, Kind, Priority, SessionKind, TaskStatus, TurnRole } from "../src/core/types";
import { FakeMux } from "./fake-mux";
import { fakeBrain, freshHome, testConfig } from "./helpers";

let engine: Engine;
let fake: FakeMux;

beforeEach(() => {
  freshHome({ github: { ...DEFAULT_CONFIG.github, repos: {} } });
  fakeBrain(() => null);
  fake = new FakeMux();
  setMux(fake);
  engine = new Engine({ config: testConfig() });
});

const ref = store.taskRef;
const undo = () => engine.desk.undo();
const task = (title = "Fix the build", kind: Kind = Kind.general) =>
  engine.desk.newTask(title, kind);

describe("ctrl+z undoes the last move", () => {
  test("done, by the Assistant: the task is open again, as it was", async () => {
    const t = task();
    engine.desk.remind(t.id, 2);
    engine.desk.remind(t.id, 3); // later rather than open: undo restores exactly that
    const before = store.getTask(t.id)!;
    expect((await engine.runMove("done", { task: ref(t.id) }, "assistant")).ok).toBe(true);
    expect(store.getTask(t.id)!.status).toBe(TaskStatus.done);

    expect(await undo()).toEqual({ ok: true, text: `undid: done ${ref(t.id)} (assistant's move)` });
    const after = store.getTask(t.id)!;
    expect(after).toMatchObject({
      status: before.status,
      remind_at: before.remind_at,
      closed_at: null,
      closed_by: null,
    });
    expect(store.turnsForTask(t.id).at(-1)).toMatchObject({
      role: TurnRole.trigger,
      body: "Undone: done",
    });
  });

  test("done frees the tasks blocked on it; undone, they are blocked again", async () => {
    const blocker = task("api");
    const waits = task("ship");
    engine.desk.blockOn(waits.id, blocker.id, "you");
    await engine.desk.close(blocker.id);
    expect(store.blockersOf(waits.id)).toEqual([]);

    expect((await undo()).ok).toBe(true);
    expect(store.blockersOf(waits.id)).toEqual([blocker.id]);
    expect(store.getTask(blocker.id)!.status).toBe(TaskStatus.open);
  });

  test("a coding task's done says Start brings its agent back", async () => {
    const t = task("Add a flag", Kind.coding);
    await engine.desk.close(t.id);
    const out = await undo();
    expect(out.text).toBe(`undid: done ${ref(t.id)}; s starts its agent again`);
    // Still held for Start, as it was before done stopped it.
    expect(store.getTask(t.id)).toMatchObject({
      agent_state: AgentState.queued,
      queue_reason: HELD_FOR_START,
    });
  });

  test("priority goes back, pin and all", async () => {
    const t = task();
    const was = store.getTask(t.id)!;
    expect((await engine.runMove("priority", { task: ref(t.id), level: "urgent" })).ok).toBe(true);
    expect(store.getTask(t.id)).toMatchObject({ priority: Priority.urgent, priority_pinned: 1 });

    expect(await undo()).toEqual({ ok: true, text: `undid: priority ${ref(t.id)}` });
    expect(store.getTask(t.id)).toMatchObject({
      priority: was.priority,
      priority_pinned: was.priority_pinned,
    });
  });

  test("project goes back, and the goal it left behind comes back", async () => {
    const ledger = await engine.desk.createProject("ledger");
    const api = await engine.desk.createProject("api");
    const goal = store.addGoal(ledger.id, "CSV export works");
    const t = engine.desk.newTask("Export", Kind.general, "", {
      projectId: ledger.id,
      goalId: goal.id,
    });
    expect((await engine.runMove("project", { task: ref(t.id), project: "api" })).ok).toBe(true);
    expect(store.getTask(t.id)).toMatchObject({ project_id: api.id, goal_id: null });

    expect(await undo()).toEqual({ ok: true, text: `undid: project ${ref(t.id)}` });
    expect(store.getTask(t.id)).toMatchObject({ project_id: ledger.id, goal_id: goal.id });
  });

  test("a running agent's window goes back to its project's session", async () => {
    const a = await engine.desk.createProject("a");
    const b = await engine.desk.createProject("b");
    const t = engine.desk.newTask("Work", Kind.coding, "", { projectId: a.id });
    const sessionOf = (projectId: number) => fake.sessions.find((s) => s.projectId === projectId)!.id;
    const w = await fake.newWindow({ sessionId: sessionOf(a.id), name: "w", cwd: "/w", env: {}, argv: [] });
    await fake.tagWindow(w.id, t.id);
    store.createSession({ id: "s1", taskId: t.id, kind: SessionKind.tmux, cwd: "/w", startedBy: "owner" });

    await engine.desk.moveTask(t.id, b.id);
    expect(fake.windows[0].sessionId).toBe(sessionOf(b.id));
    expect((await undo()).ok).toBe(true);
    expect(fake.windows[0].sessionId).toBe(sessionOf(a.id));
    expect(store.getTask(t.id)!.project_id).toBe(a.id);
  });

  test("remind, watch, kind, retitle, wait, block, win and link each go back", async () => {
    const other = task("other");
    const t = task("old");
    const id = t.id;
    const was = store.getTask(id)!;
    const day = localDay(new Date());
    const steps: [string, () => unknown, () => void][] = [
      ["remind", () => engine.desk.remind(id, 1), () => expect(store.getTask(id)!.status).toBe(was.status)],
      ["watch", () => engine.desk.watch(id, true), () => expect(store.getTask(id)!.watching).toBe(0)],
      [
        "kind",
        () => engine.desk.setKind(id, Kind.coding),
        () =>
          expect(store.getTask(id)).toMatchObject({
            kind: Kind.general,
            agent_state: AgentState.none,
            queue_reason: null,
          }),
      ],
      ["retitle", () => engine.desk.retitle(id, "new"), () => expect(store.getTask(id)!.title).toBe("old")],
      ["wait_on", () => engine.desk.waitOn(id, "Sam"), () => expect(store.getTask(id)!.waiting_on).toBeNull()],
      ["block_on", () => engine.desk.blockOn(id, other.id, "you"), () => expect(store.blockersOf(id)).toEqual([])],
      ["win", () => engine.desk.setWin(id, true), () => expect(store.winsOn(day)).toEqual([])],
      [
        "link",
        () => engine.desk.link(id, "https://example.com/doc", "doc", "you"),
        () => expect(store.linksForTask(id)).toEqual([]),
      ],
    ];
    for (const [what, act, check] of steps) {
      act();
      expect(await undo()).toEqual({ ok: true, text: `undid: ${what} ${ref(id)}` });
      check();
    }
  });

  test("unblock and unlink put back what they took", async () => {
    const other = task("other");
    const t = task();
    engine.desk.blockOn(t.id, other.id, "you");
    engine.desk.link(t.id, "https://example.com/a", "a", "assistant");
    engine.desk.unblock(t.id);
    engine.desk.unlink(t.id, "https://example.com/a");
    await undo();
    await undo();
    expect(store.blockersOf(t.id)).toEqual([other.id]);
    expect(store.linksForTask(t.id)).toMatchObject([
      { url: "https://example.com/a", title: "a", added_by: "assistant" },
    ]);
  });

  test("a move with outside effects is named, not skipped; the next ctrl+z reaches the one before", async () => {
    const t = task();
    engine.desk.setPriority(t.id, Priority.urgent);
    expect((await engine.runMove("tell", { task: ref(t.id), text: "hello" }, "assistant")).ok).toBe(true);

    expect(await undo()).toEqual({
      ok: false,
      text: `Can't undo tell ${ref(t.id)} (assistant's move): it is not a move ctrl+z takes back`,
    });
    expect(store.getTask(t.id)!.priority).toBe(Priority.urgent);
    expect((await undo()).text).toBe(`undid: priority ${ref(t.id)}`);
    expect(await undo()).toEqual({ ok: false, text: `Can't undo new ${ref(t.id)}: a task made is not unmade: x (ignore) drops it` });
    expect(await undo()).toEqual({ ok: false, text: "Nothing to undo" });
  });

  test("starting an agent cannot be undone", async () => {
    const t = task();
    await engine.desk.startAgent(t.id);
    expect((await undo()).text).toBe(`Can't undo start ${ref(t.id)}: it started an agent`);
  });

  test("a task changed since is left alone", async () => {
    const t = task();
    engine.desk.setPriority(t.id, Priority.urgent);
    store.updateTask(t.id, { priority: Priority.important });
    expect(await undo()).toEqual({
      ok: false,
      text: `Can't undo priority ${ref(t.id)}: ${ref(t.id)}'s priority changed since`,
    });
    expect(store.getTask(t.id)!.priority).toBe(Priority.important);
  });

  test("a change to something the move did not touch does not block it", async () => {
    const t = task();
    await engine.desk.close(t.id);
    engine.desk.retitle(t.id, "renamed while closed");
    await undo(); // the retitle
    store.updateTask(t.id, { waiting_on: "Sam" });
    expect((await undo()).ok).toBe(true);
    expect(store.getTask(t.id)!.status).toBe(TaskStatus.open);
  });

  test("a task deleted since cannot be undone", async () => {
    const t = task();
    engine.desk.setPriority(t.id, Priority.urgent);
    // Nothing in aug deletes a task row; a raw delete stands in, past the
    // rows that point at it.
    db().run("PRAGMA foreign_keys = OFF");
    db().run("DELETE FROM tasks WHERE id = ?", [t.id]);
    db().run("PRAGMA foreign_keys = ON");
    expect(await undo()).toEqual({ ok: false, text: `Can't undo priority ${ref(t.id)}: ${ref(t.id)} is gone` });
  });

  test("a task's own agent's moves are not kept", async () => {
    const t = task();
    engine.desk.setPriority(t.id, Priority.urgent);
    expect((await engine.runMove("retitle", { task: ref(t.id), title: "mine" }, `agent ${ref(t.id)}`)).ok).toBe(true);
    expect((await undo()).text).toBe(`undid: priority ${ref(t.id)}`);
    expect(store.getTask(t.id)!.title).toBe("mine");
  });

  test("a move that changed nothing leaves nothing to undo", async () => {
    const t = task();
    engine.desk.setPriority(t.id, t.priority);
    expect((await undo()).text).toStartWith(`Can't undo new`);
  });

  test("the stack keeps the newest moves only", () => {
    const stack = new UndoStack(2);
    for (const what of ["a", "b", "c"]) stack.cannot(what, "why");
    expect(stack.size).toBe(2);
    expect(stack.pop()).toMatchObject({ what: "c" });
    expect(stack.pop()).toMatchObject({ what: "b" });
    expect(stack.pop()).toBeUndefined();
  });
});
