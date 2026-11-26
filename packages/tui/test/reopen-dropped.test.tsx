// A dropped task is off the rail; go to finds it by name once tab shows done
// work, and d on it reopens it without starting its agent.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { App } from "../src/app";
import * as store from "@riker/core/store";
import { TaskStatus } from "@riker/core/types";
import { installFixture } from "@riker/fixtures/demo";

let destroy: (() => void) | undefined;
let home: string | undefined;
afterEach(() => {
  destroy?.();
  if (home) {
    rmSync(home, { recursive: true, force: true });
  }
});

async function boot() {
  home = mkdtempSync(join(tmpdir(), "riker-reopen-"));
  process.env.RIKER_HOME = home;
  const engine = installFixture("demo");
  const setup = await testRender(() => <App engine={engine} />, {
    width: 160,
    height: 45,
  });
  destroy = () => setup.renderer.destroy();
  const settle = async (ms = 40) => {
    await Bun.sleep(ms);
    await setup.renderOnce();
  };
  await settle();
  const press = async (key: string, mods?: { ctrl?: boolean }) => {
    setup.mockInput.pressKey(key, mods);
    await settle();
  };
  const open = async (words: string, toggles = 0) => {
    await press("\\", { ctrl: true });
    for (let i = 0; i < toggles; i++) {
      setup.mockInput.pressTab();
      await settle();
    }
    for (const c of words) {
      setup.mockInput.pressKey(c);
    }
    await settle();
  };
  const goTo = async (words: string, toggles = 0) => {
    await open(words, toggles);
    setup.mockInput.pressEnter();
    await settle();
  };
  const frame = () => setup.captureCharFrame();
  const tab = async () => {
    setup.mockInput.pressTab();
    await settle();
  };
  const escape = async () => {
    setup.mockInput.pressEscape();
    await settle();
  };
  return { press, tab, escape, open, goTo, frame, engine };
}

const footer = (frame: string) =>
  frame
    .split("\n")
    .filter((l) => l.includes("? help"))
    .join("\n");

test("x drops a task; go to finds it; d reopens it", async () => {
  const { press, goTo, frame } = await boot();
  const badge = store
    .listTasks()
    .find((t) => t.title.startsWith("Badge printer"))!;
  await goTo("badge printer");
  await press("x");
  expect(store.getTask(badge.id)!.status).toBe(TaskStatus.dropped);
  expect(frame()).toContain(`Ignored ${store.taskRef(badge.id)}`);

  await goTo("badge printer", 1);
  expect(frame()).toContain("dropped by you");
  expect(footer(frame())).toContain("d reopen");
  await press("d");
  expect(store.getTask(badge.id)!.status).toBe(TaskStatus.open);
  expect(frame()).toContain("open again");
});

test("go to hides done work until tab shows it, and keeps the choice", async () => {
  const { tab, escape, open, frame } = await boot();
  const badge = store
    .listTasks()
    .find((t) => t.title.startsWith("Badge printer"))!;
  store.updateTask(badge.id, {
    status: TaskStatus.dropped,
    closed_at: new Date().toISOString(),
    closed_by: "you",
  });

  // Hidden by default, even typed; the Open | All toggle says so. A typed
  // "d" goes to the query, not the toggle.
  await open("badge printer d");
  expect(frame()).toContain("▌ Open ▐  All   ");
  expect(frame()).toContain("tab  switch");
  expect(frame()).toContain("Nothing matches");
  await escape();

  await open("badge printer", 1);
  expect(frame()).toContain(" Open  ▌ All ▐");
  expect(frame()).toMatch(/Badge printer.*Dropped/);
  await escape();

  // Still shown on the next open, this session; tab again hides it.
  await open("badge printer");
  expect(frame()).toMatch(/Badge printer.*Dropped/);
  await tab();
  expect(frame()).toContain("Nothing matches");
});
