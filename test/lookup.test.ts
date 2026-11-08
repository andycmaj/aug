import { beforeEach, describe, expect, test } from "bun:test";
import { mentionedTasks } from "../src/core/assistant";
import { findProject, mentionAt, suggestTasks } from "../src/core/lookup";
import * as store from "../src/core/store";
import { Kind, TaskStatus } from "../src/core/types";
import { freshHome } from "./helpers";

beforeEach(() => freshHome());

function task(title: string) {
  return store.createTask({ title, kind: Kind.general, channel: "owner" });
}

describe("@ mentions", () => {
  test("the query is the @word left of the cursor", () => {
    expect(mentionAt("ask about @fix")).toEqual({ start: 10, query: "fix" });
    expect(mentionAt("@")).toEqual({ start: 0, query: "" });
    expect(mentionAt("mail me@home")).toBeNull();
    expect(mentionAt("@fix the thing")).toBeNull();
  });

  test("a number matches the ref; words match the title", () => {
    const build = task("Fix the build");
    const flaky = task("Flaky deploy fix");
    expect(suggestTasks("fix").map((t) => t.id)).toEqual([build.id, flaky.id]);
    expect(suggestTasks("AUG-2").map((t) => t.id)).toEqual([flaky.id]);
    expect(suggestTasks("fdx").map((t) => t.id)).toEqual([flaky.id]);
    expect(suggestTasks("zzz")).toEqual([]);
  });

  test("only open work is offered, snoozed included", () => {
    const open = task("Fix the build");
    const later = task("Fix the docs");
    const done = task("Fix old thing");
    const dropped = task("Fix nothing");
    store.updateTask(later.id, { status: TaskStatus.later });
    store.markDone(done.id);
    store.updateTask(dropped.id, { status: TaskStatus.dropped });
    expect(suggestTasks("fix").map((t) => t.id)).toEqual([later.id, open.id]);
    expect(suggestTasks(String(done.id))).toEqual([]);
  });

  test("Home is never offered", () => {
    store.homeTask();
    task("Home page copy");
    expect(suggestTasks("").map((t) => t.title)).toEqual(["Home page copy"]);
  });

  test("the Assistant reads back the tasks a message names", () => {
    const a = task("one");
    const b = task("two");
    const refs = `about @${store.taskRef(a.id)} and ${store.taskRef(b.id).toLowerCase()} and AUG-0999`;
    expect(mentionedTasks(refs).map((t) => t.id)).toEqual([a.id, b.id]);
  });
});

test("projects match by name or session, ignoring case and punctuation", () => {
  store.createProject({ name: "aug bootstrap", tmuxSession: "aug-bootstrap" });
  expect(findProject("AUG-Bootstrap")?.name).toBe("aug bootstrap");
  expect(findProject("augbootstrap")?.name).toBe("aug bootstrap");
  expect(findProject("aug")).toBeNull();
});
