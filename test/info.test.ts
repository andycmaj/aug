import { beforeEach, describe, expect, test } from "bun:test";
import { itemInfo } from "../src/core/info";
import { Lane } from "../src/core/lanes";
import type { RailItem } from "../src/core/rail";
import * as store from "../src/core/store";
import { Kind, SessionKind } from "../src/core/types";
import { freshHome } from "./helpers";

function taskItem(task: ReturnType<typeof store.createTask>): RailItem {
  return {
    type: "task",
    key: `t${task.id}`,
    task,
    lane: Lane.asked,
    priority: task.priority,
    slipped: false,
    at: task.created_at,
    group: null,
  };
}

const value = (item: RailItem, label: string) =>
  itemInfo(item)
    .flatMap((s) => s.rows)
    .find((r) => r.label === label)?.value;

describe("task info", () => {
  beforeEach(() => freshHome());

  test("a fresh to-do leaves out what it does not have", () => {
    const t = store.createTask({ title: "buy milk", kind: Kind.task, channel: "owner" });
    const sections = itemInfo(taskItem(t));
    expect(sections.map((s) => s.title)).toEqual(["Task", "Source"]);
    expect(value(taskItem(t), "ref")).toBe("AUG-0001");
    expect(value(taskItem(t), "url")).toBeUndefined();
  });

  test("source and the latest agent session show up", () => {
    const t = store.createTask({
      title: "fix login",
      kind: Kind.coding,
      channel: "github",
      repo: "acme/api",
      url: "https://github.com/acme/api/issues/12",
      threadKey: "github:acme/api#12",
    });
    store.createSession({ id: "old", taskId: t.id, kind: SessionKind.tmux, cwd: "/a", startedBy: "owner" });
    store.updateSession("old", { started_at: "2020-01-01T00:00:00.000Z" });
    store.createSession({ id: "s-new", taskId: t.id, kind: SessionKind.tmux, cwd: "/repo", startedBy: "owner" });
    const item = taskItem(store.getTask(t.id)!);
    expect(value(item, "repo")).toBe("acme/api");
    expect(value(item, "thread")).toBe("github:acme/api#12");
    expect(value(item, "sessions")).toBe("2");
    expect(value(item, "session")).toBe("s-new");
    expect(value(item, "cwd")).toBe("/repo");
    expect(value(item, "lane")).toBe("asked you");
  });

  test("the thread and attached links are what enter opens", () => {
    const t = store.createTask({
      title: "fix login",
      kind: Kind.coding,
      channel: "github",
      url: "https://github.com/acme/api/issues/12",
    });
    store.addTaskLink(t.id, "https://claude.ai/code/artifact/abc", "Design", "you");
    const rows = itemInfo(taskItem(store.getTask(t.id)!)).flatMap((s) => s.rows);
    expect(rows.filter((r) => r.open).map((r) => [r.label, r.open])).toEqual([
      ["url", "https://github.com/acme/api/issues/12"],
      ["Design", "https://claude.ai/code/artifact/abc"],
    ]);
  });
});
