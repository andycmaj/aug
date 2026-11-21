import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "../src/config";
import { Engine } from "../src/engine";
import { Lane } from "../src/lanes";
import { handleDone } from "../src/hooks";
import { setMux } from "../src/mux";
import { buildRail, flattenRail } from "../src/rail";
import * as store from "../src/store";
import { Kind, SessionKind, TurnRole } from "../src/types";
import { FakeMux } from "./support/fake-mux";
import { fakeBrain, freshHome, testConfig } from "./support/helpers";

let engine: Engine;

beforeEach(() => {
  freshHome({ github: { ...DEFAULT_CONFIG.github, repos: {} } });
  fakeBrain(() => null);
  setMux(new FakeMux());
  engine = new Engine({ config: testConfig() });
});

const move = async (verb: string, args: Record<string, string>, by = "you") => {
  const m = store.enqueueMove(verb, args, by);
  await engine.drainMoves();
  return store.getMove(m.id)!;
};

const triggers = (id: number) =>
  store.turnsForTask(id).filter((t) => t.role === TurnRole.trigger).map((t) => t.body);

function laneOfTask(id: number) {
  const item = flattenRail(
    buildRail({
      tasks: store.listTasks(),
      pendingActions: new Set(),
      lastHeard: new Map(),
      now: new Date(),
      blockers: store.allBlockers(),
    }),
  ).find((i) => i.key === `t${id}`);
  return item?.type === "task" ? item.lane : null;
}

describe("blocked on another task", () => {
  test("a task blocked on two hears as each closes, and leaves the lane when none is left", async () => {
    const waits = engine.desk.newTask("ship", Kind.task);
    const a = engine.desk.newTask("api", Kind.task);
    const b = engine.desk.newTask("docs", Kind.task);
    const ref = store.taskRef;
    expect((await move("block_on", { task: ref(waits.id), on: ref(a.id) })).status).toBe("done");
    await move("block_on", { task: ref(waits.id), on: ref(b.id) });
    expect(laneOfTask(waits.id)).toBe(Lane.blocked);
    await move("done", { task: ref(a.id) });
    expect(triggers(waits.id).at(-1)).toBe(`${ref(a.id)} done: api; still blocked by ${ref(b.id)}`);
    expect(laneOfTask(waits.id)).toBe(Lane.blocked);
    engine.desk.ignore(b.id);
    expect(triggers(waits.id).at(-1)).toBe(`${ref(b.id)} dropped: docs; nothing blocks this now`);
    expect(store.blockersOf(waits.id)).toEqual([]);
    expect(laneOfTask(waits.id)).toBe(Lane.yours);
  });

  test("no self, no cycles, no closed blockers", async () => {
    const a = engine.desk.newTask("a", Kind.task);
    const b = engine.desk.newTask("b", Kind.task);
    const c = engine.desk.newTask("c", Kind.task);
    const ref = store.taskRef;
    await move("block_on", { task: ref(a.id), on: ref(b.id) });
    await move("block_on", { task: ref(b.id), on: ref(c.id) });
    expect((await move("block_on", { task: ref(a.id), on: ref(a.id) })).result).toContain("itself");
    expect((await move("block_on", { task: ref(c.id), on: ref(a.id) })).result).toContain("already waits on");
    await move("done", { task: ref(c.id) });
    expect((await move("block_on", { task: ref(a.id), on: ref(c.id) })).result).toContain("is done already");
    expect((await move("unblock", { task: ref(a.id) })).result).toContain(`no longer blocked by ${ref(b.id)}`);
    expect(store.blockersOf(a.id)).toEqual([]);
  });

  test("an agent may block its own task; an agent that closes its task frees what waits on it", async () => {
    const waits = engine.desk.newTask("ship", Kind.coding);
    const blocker = engine.desk.newTask("api", Kind.coding);
    const ref = store.taskRef;
    const by = `agent ${ref(waits.id)}`;
    expect((await move("block_on", { task: ref(waits.id), on: ref(blocker.id) }, by)).status).toBe("done");
    store.createSession({ id: "s", taskId: blocker.id, kind: SessionKind.tmux, cwd: "/", startedBy: "riker" });
    handleDone({ taskId: blocker.id, sessionId: "s" }, { summary: "api shipped" });
    expect(store.blockersOf(waits.id)).toEqual([]);
    expect(triggers(waits.id).at(-1)).toContain("nothing blocks this now");
  });
});

describe("Wins", () => {
  test("five a day, by the owner's day; the sixth is refused; a new day starts empty", async () => {
    const day = new Date(2026, 10, 15, 9);
    const ids = Array.from({ length: 6 }, (_, i) => engine.desk.newTask(`t${i}`, Kind.task).id);
    for (const id of ids.slice(0, 5)) expect(engine.desk.setWin(id, true, day).ok).toBe(true);
    const sixth = engine.desk.setWin(ids[5], true, day);
    expect(sixth.ok).toBe(false);
    expect(sixth.text).toContain("unpin one first");
    expect(engine.desk.toggleWin(ids[0], day).text).toContain("no longer a Win");
    expect(engine.desk.setWin(ids[5], true, day).ok).toBe(true);
    expect(store.winsOn("2026-11-15")).toEqual([...ids.slice(1, 5), ids[5]]);
    expect(store.winsOn("2026-11-16")).toEqual([]);
  });

  test("the win move pins and unpins; an agent may not", async () => {
    const t = engine.desk.newTask("t", Kind.task);
    const ref = store.taskRef(t.id);
    expect((await move("win", { task: ref })).result).toContain("is a Win today (1/5)");
    expect((await move("win", { task: ref, off: "yes" })).result).toContain("no longer");
    expect((await move("win", { task: ref }, `agent ${ref}`)).result).toContain("the owner's move");
  });
});
