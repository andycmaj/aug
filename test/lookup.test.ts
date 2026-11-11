import { beforeEach, describe, expect, test } from "bun:test";
import { mentionedProjects, mentionedTasks } from "../src/core/mentions";
import { findProject } from "../src/core/lookup";
import {
  type Mention,
  mentionAt,
  mentionRef,
  suggestMentions,
} from "../src/core/mentions";
import { taskClosed } from "../src/core/lifecycle";
import * as store from "../src/core/store";
import { Kind, ProjectStatus, TaskStatus } from "../src/core/types";
import { freshHome } from "./helpers";

beforeEach(() => freshHome());

function task(title: string) {
  return store.createTask({ title, kind: Kind.general, channel: "owner" });
}

function project(name: string) {
  return store.createProject({ name, tmuxSession: name.replace(/ /g, "-") });
}

const suggestTasks = (query: string) =>
  suggestMentions(query).flatMap((m) => (m.type === "task" ? [m.task] : []));
const refs = (query: string) => suggestMentions(query).map(mentionRef);

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
    taskClosed(done.id);
    store.updateTask(dropped.id, { status: TaskStatus.dropped });
    expect(suggestTasks("fix").map((t) => t.id)).toEqual([later.id, open.id]);
    expect(suggestTasks(String(done.id))).toEqual([]);
  });

  test("Home is never offered", () => {
    store.homeTask();
    task("Home page copy");
    expect(suggestTasks("").map((t) => t.title)).toEqual(["Home page copy"]);
  });

  test("projects are offered by name, tasks first when they match as well", () => {
    const fix = task("Fix the build");
    project("fixtures");
    project("aug bootstrap");
    const old = project("augury");
    store.updateProject(old.id, { status: ProjectStatus.archived });
    expect(refs("fix")).toEqual([store.taskRef(fix.id), "fixtures"]);
    expect(refs("boot")).toEqual(["aug-bootstrap"]);
    // A whole name beats a name it begins.
    expect(refs("fixtures")).toEqual(["fixtures"]);
    // A number is a task ref, never a project.
    expect(refs(String(fix.id))).toEqual([store.taskRef(fix.id)]);
    // "aug" may be a ref on its way; a project it begins comes first.
    expect(refs("aug")).toEqual(["aug-bootstrap", store.taskRef(fix.id)]);
  });

  test("a project's ref finds it again, whatever its name holds", () => {
    const p = project("Q4: ledger & export");
    const m: Mention = { type: "project", project: p };
    expect(mentionRef(m)).toBe("Q4-ledger-export");
    expect(mentionAt(`about @${mentionRef(m)}`)?.query).toBe(mentionRef(m));
    expect(findProject(mentionRef(m))?.id).toBe(p.id);
  });

  test("a ref copied with its @ still names what it named", () => {
    const t = task("Fix the build");
    const p = project("aug bootstrap");
    expect(store.parseTaskRef(`@${store.taskRef(t.id)}`)).toBe(t.id);
    expect(findProject("@aug-bootstrap")?.id).toBe(p.id);
  });

  test("the Assistant reads back the projects a message names", () => {
    const a = project("aug bootstrap");
    project("ledger");
    expect(
      mentionedProjects("move it to @aug-bootstrap, not @nothing or ledger").map(
        (p) => p.id,
      ),
    ).toEqual([a.id]);
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
