import { beforeEach, describe, expect, test } from "bun:test";
import { db } from "../src/db";
import { taskDetail } from "../src/lookup";
import * as store from "../src/store";
import { Kind, NoteLabel, TaskStatus } from "../src/types";
import { freshHome } from "./support/helpers";

function task(title: string): number {
  return store.createTask({ title, kind: Kind.coding, channel: "owner" }).id;
}

// Notes in a row, a minute apart, so the order does not rest on the clock.
let minute = 0;
function note(body: string, taskId: number | null, label: NoteLabel = NoteLabel.note): void {
  const row = store.addNote(`agent ${taskId ?? "home"}`, label, body, taskId);
  const at = new Date(Date.UTC(2026, 10, 21, 9, minute++)).toISOString();
  db().run("UPDATE notes SET created_at = ? WHERE id = ?", [at, row.id]);
}

const board = () => store.listNotes().map((n) => n.body);

describe("the notes board", () => {
  beforeEach(() => {
    freshHome();
    minute = 0;
  });

  test("a task's notes leave the board when it is done or dropped, and stay on the task", () => {
    const merged = task("Merged work");
    const dropped = task("Dropped work");
    const open = task("Open work");
    note("merged: working on", merged, NoteLabel.workingOn);
    note("merged: ready to push", merged, NoteLabel.ready);
    note("dropped: working on", dropped, NoteLabel.workingOn);
    note("open: working on", open, NoteLabel.workingOn);
    note("no task: rebase every branch", null);
    expect(board()).toEqual([
      "no task: rebase every branch",
      "open: working on",
      "dropped: working on",
      "merged: ready to push",
      "merged: working on",
    ]);

    store.updateTask(merged, { status: TaskStatus.done });
    store.updateTask(dropped, { status: TaskStatus.dropped });
    expect(board()).toEqual(["no task: rebase every branch", "open: working on"]);

    expect(store.notesForTask(merged).map((n) => n.body)).toEqual([
      "merged: working on",
      "merged: ready to push",
    ]);
    const detail = taskDetail(store.getTask(merged)!);
    expect(detail).toContain("[ready to push]: merged: ready to push");
    expect(detail).toContain("[working on]: merged: working on");
  });

  test("an open task shows only its latest few notes", () => {
    const busy = task("Busy");
    const quiet = task("Quiet");
    note("quiet: one", quiet);
    for (let i = 1; i <= store.NOTES_PER_TASK + 2; i++) note(`busy: ${i}`, busy);
    note("home: one", null);
    note("home: two", null);
    const n = store.NOTES_PER_TASK;
    expect(board()).toEqual([
      "home: two",
      "home: one",
      ...Array.from({ length: n }, (_, i) => `busy: ${n + 2 - i}`),
      "quiet: one",
    ]);
    expect(store.notesForTask(busy)).toHaveLength(n + 2);
  });

  test("the limit counts what the board shows", () => {
    const t = task("t");
    for (let i = 0; i < 5; i++) note(`n${i}`, null);
    note("t1", t);
    expect(store.listNotes(3).map((n) => n.body)).toEqual(["t1", "n4", "n3"]);
  });
});
