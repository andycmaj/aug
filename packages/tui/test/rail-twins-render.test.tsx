// AUG-0175: a Win shows in its project and under Wins, on the real rail,
// and both rows are the one task. w pins a row as a Win and unpins it.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { App } from "../src/app";
import { installFixture } from "@riker/fixtures/demo";
import { localDay } from "@riker/core/rail";
import * as store from "@riker/core/store";
import { Kind } from "@riker/core/types";

let destroy: (() => void) | undefined;
let home: string | undefined;
afterEach(() => {
  destroy?.();
  if (home) {
    rmSync(home, { recursive: true, force: true });
  }
});

const RAIL = 46;

async function boot() {
  home = mkdtempSync(join(tmpdir(), "riker-rail-twins-"));
  process.env.RIKER_HOME = home;
  const engine = installFixture("demo");
  const project = store.createProject({
    name: "twins",
    tmuxSession: "twinproj",
  });
  const make = (title: string) =>
    store.createTask({
      title,
      kind: Kind.task,
      channel: "owner",
      projectId: project.id,
    }).id;
  const ids = {
    neither: make("Zq neither"),
    win: make("Zq win"),
    other: make("Zq other"),
    both: make("Zq both"),
  };
  const day = localDay(new Date());
  // Wins list in the order they were pinned (pinned_at, then task id on a
  // tie). Pin in the order the tests walk, a tick apart, so the order does
  // not hang on both pins landing in the same millisecond.
  store.addWin(day, ids.win);
  await Bun.sleep(2);
  store.addWin(day, ids.both);

  const setup = await testRender(() => <App engine={engine} />, {
    width: 160,
    height: 220,
  });
  destroy = () => setup.renderer.destroy();
  const settle = async () => {
    await Bun.sleep(40);
    await setup.renderOnce();
  };
  await settle();
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      if (k === "enter") {
        setup.mockInput.pressEnter();
      } else {
        setup.mockInput.pressKey(k);
      }
      await settle();
    }
  };
  const rail = () =>
    setup
      .captureCharFrame()
      .split("\n")
      // Past the pane's border: " ┃ ▸  ◆ title".
      .map((l) => l.slice(2, RAIL));
  // Each row of a title: the section it sits under and its gutter mark.
  const rowsOf = (title: string) => {
    const lines = rail();
    const out: {
      section: string;
      gutter: string;
      line: string;
      sub: string;
    }[] = [];
    let section = "";
    lines.forEach((l, i) => {
      const head = l.match(
        /^\s{1,2}(Home|Wins|System|Tasks|Code Reviews|For later) \(/,
      );
      if (head) {
        section = head[1];
      }
      if (l.includes(title)) {
        out.push({
          section,
          // A row nested under its project has its gutter further in.
          gutter: l.match(/^\s*([▸▹])/)?.[1] ?? " ",
          line: l,
          sub: lines[i + 1] ?? "",
        });
      }
    });
    return out;
  };
  return {
    press,
    settle,
    rail,
    rowsOf,
    ids,
    day,
    frame: () => setup.captureCharFrame(),
  };
}

test("a task that is a Win or not: rows in its project and under Wins", async () => {
  const { rowsOf } = await boot();
  const where = (title: string) => rowsOf(title).map((r) => r.section);
  expect(where("Zq neither")).toEqual(["Tasks"]);
  expect(where("Zq other")).toEqual(["Tasks"]);
  expect(where("Zq win")).toEqual(["Wins", "Tasks"]);
  expect(where("Zq both")).toEqual(["Wins", "Tasks"]);

  // In the project: a small ★ for a Win.
  const [winCopy, winOwn] = rowsOf("Zq win");
  expect(winOwn.line).toContain("★ Zq win");
  expect(winCopy.line).not.toContain("★");
  // Under a header: out of its project, so the sub line names it.
  expect(winCopy.sub).toContain("◫ twinproj");
  expect(winOwn.sub).not.toContain("◫ twinproj");
  const [, bothOwn] = rowsOf("Zq both");
  expect(bothOwn.line).toContain("★ Zq both");
  // One line each, title and tags.
  for (const r of rowsOf("Zq both")) {
    expect(r.line.length).toBeLessThanOrEqual(RAIL);
  }
});

test("both rows are one task: selecting either marks the other; Next takes each task once", async () => {
  const { press, rail, rowsOf, frame } = await boot();
  // g: top (Home). Wins holds the demo's two, then "Zq win", "Zq both".
  await press("g", "j", "j", "j", "j", "enter");
  expect(rowsOf("Zq both").map((r) => r.gutter)).toEqual(["▸", "▹"]);
  // The Canvas shows it.
  expect(
    frame()
      .split("\n")
      .some((l) => l.slice(RAIL).includes("Zq both")),
  ).toBe(true);

  // b and n walk between Wins; the same task's other rows only show ▹.
  await press("b");
  expect(rowsOf("Zq win").map((r) => r.gutter)).toEqual(["▸", "▹"]);
  expect(rowsOf("Zq both").map((r) => r.gutter)).toEqual([" ", " "]);
  await press("n");
  expect(rowsOf("Zq both").map((r) => r.gutter)).toEqual(["▸", "▹"]);

  // n on through the rail: each task once, never stuck on a task's other row.
  const seen: string[] = [];
  for (let i = 0; i < 20; i++) {
    await press("n");
    const at = rail().find((l) => /^\s*▸/.test(l));
    if (at) {
      seen.push(at.replace(/^\s*▸\s*\S\s*/, "").trim());
    }
  }
  const zq = seen.filter((t) => t.startsWith("Zq") || t.includes(" Zq"));
  expect(zq.map((t) => t.replace(/^[★ ]+/, ""))).toEqual([
    "Zq neither",
    "Zq other",
  ]);
});

test("the selection stays on the task as its row under Wins goes", async () => {
  const { press, settle, rowsOf, ids, day } = await boot();
  await press("g", "j", "j", "j", "j", "enter");
  expect(rowsOf("Zq both").map((r) => [r.section, r.gutter])).toEqual([
    ["Wins", "▸"],
    ["Tasks", "▹"],
  ]);
  // Unpinned: the Wins row goes too, and the selection is its project's row.
  store.removeWin(day, ids.both);
  await settle();
  await settle();
  expect(rowsOf("Zq both").map((r) => [r.section, r.gutter])).toEqual([
    ["Tasks", "▸"],
  ]);
});

test("w pins the row as today's Win, w again unpins it, and a full day says so", async () => {
  const { press, rail, rowsOf, ids, day, frame } = await boot();
  // n walks the rail a task at a time; stop on the row to pin.
  const walkTo = async (title: string) => {
    for (let i = 0; i < 30; i++) {
      await press("n");
      if (rail().some((l) => /^\s*▸/.test(l) && l.includes(title))) {
        return;
      }
    }
    throw new Error(`never reached ${title}`);
  };
  await press("g");
  await walkTo("Zq neither");

  await press("w");
  expect(store.winsOn(day)).toContain(ids.neither);
  expect(rowsOf("Zq neither").map((r) => r.section)).toEqual(["Wins", "Tasks"]);
  // The toast says it (wrapped, so only its first words).
  expect(frame()).toContain("is a Win today");

  await press("w");
  expect(store.winsOn(day)).not.toContain(ids.neither);
  expect(rowsOf("Zq neither").map((r) => r.section)).toEqual(["Tasks"]);

  // Fill the day to five, then w on another row is refused and says why.
  while (store.winsOn(day).length < 5) {
    const spare = store.createTask({
      title: `Zq spare ${store.winsOn(day).length}`,
      kind: Kind.task,
      channel: "owner",
    }).id;
    store.addWin(day, spare);
  }
  await press("g");
  await walkTo("Zq other");
  await press("w");
  expect(store.winsOn(day)).not.toContain(ids.other);
  expect(store.winsOn(day)).toHaveLength(5);
  expect(frame()).toContain("Today has 5 Wins");
});
