// Watching is gone. A database from before keeps its watched tasks as
// ordinary open tasks, and nothing offers watch any more.

import { beforeEach, expect, test } from "bun:test";
import { db, migrate } from "../src/db";
import { MOVES } from "../src/moves";
import { buildRail } from "../src/rail";
import * as store from "../src/store";
import { Kind, TaskStatus, Verdict } from "../src/types";
import { freshHome } from "./support/helpers";

beforeEach(() => freshHome());

test("an old database's watched task stays, open and ordinary", () => {
  const t = store.createTask({
    title: "Rotate staging certs",
    kind: Kind.task,
    channel: "github",
  });
  // As a database from before had it: the column, and the task watched.
  db().exec("ALTER TABLE tasks ADD COLUMN watching INTEGER NOT NULL DEFAULT 0");
  db().query("UPDATE tasks SET watching = 1 WHERE id = ?").run(t.id);

  migrate(db());

  const cols = db().query("PRAGMA table_info(tasks)").all() as {
    name: string;
  }[];
  expect(cols.map((c) => c.name)).not.toContain("watching");
  const after = store.getTask(t.id)!;
  expect(after.status).toBe(TaskStatus.open);
  expect(after.title).toBe("Rotate staging certs");
  const rail = buildRail({
    tasks: store.listTasks(),
    pendingActions: new Set(),
    lastHeard: new Map(),
    now: new Date(),
  });
  expect(rail.map((s) => s.section)).toEqual(["tasks"]);
  expect(rail[0].items.map((i) => i.key)).toEqual([`t${t.id}`]);
  // Run again on a database already without it: nothing to do.
  migrate(db());
});

test("no watch verdict, and no watch or unwatch move", () => {
  expect(Object.values(Verdict)).not.toContain("watch");
  expect(Object.keys(MOVES)).not.toContain("watch");
  expect(Object.keys(MOVES)).not.toContain("unwatch");
});
