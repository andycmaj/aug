// d on a task not merged asks first, No under the cursor, saying what its PR
// or branch says; a merged one closes at once.

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
  if (home) rmSync(home, { recursive: true, force: true });
});

async function boot() {
  home = mkdtempSync(join(tmpdir(), "riker-done-unmerged-"));
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
  // d asks git before it answers, so give it a beat more.
  const press = async (key: string, mods?: { ctrl?: boolean }) => {
    setup.mockInput.pressKey(key, mods);
    await settle(120);
  };
  const enter = async () => {
    setup.mockInput.pressEnter();
    await settle(120);
  };
  const goTo = async (words: string) => {
    await press("\\", { ctrl: true });
    for (const c of words) setup.mockInput.pressKey(c);
    await enter();
  };
  const frame = () => setup.captureCharFrame();
  return { press, enter, goTo, frame };
}

const taskTitled = (prefix: string) => store.listTasks().find((t) => t.title.startsWith(prefix))!;
const ASK = "Mark it done anyway?";

test("d on a task whose PR is open asks; Enter keeps it open", async () => {
  const { press, enter, goTo, frame } = await boot();
  const retry = taskTitled("Retry webhook deliveries");
  await goTo("retry webhook");
  await press("d");
  expect(frame()).toContain(`Mark ${store.taskRef(retry.id)} done?`);
  expect(frame()).toContain(`PR #91 is open, not merged. ${ASK}`);
  expect(frame()).toContain("No, keep it open");
  await enter();
  expect(store.getTask(retry.id)!.status).toBe(TaskStatus.open);
  expect(frame()).not.toContain(ASK);
});

test("picking Yes marks it done", async () => {
  const { press, enter, goTo, frame } = await boot();
  const retry = taskTitled("Retry webhook deliveries");
  await goTo("retry webhook");
  await press("d");
  await press("j");
  await enter();
  expect(store.getTask(retry.id)!.status).toBe(TaskStatus.done);
  expect(frame()).not.toContain(ASK);
});

test("d on a task with no PR or branch asks too", async () => {
  const { press, enter, goTo, frame } = await boot();
  const badge = taskTitled("Badge printer");
  await goTo("badge printer");
  await press("d");
  expect(frame()).toContain(`It is not merged. ${ASK}`);
  await enter();
  expect(store.getTask(badge.id)!.status).toBe(TaskStatus.open);
});

test("d on a merged task closes at once", async () => {
  const { press, goTo, frame } = await boot();
  const bump = taskTitled("Bump pydantic");
  expect(bump.merged_at).not.toBeNull();
  await goTo("bump pydantic");
  await press("d");
  expect(frame()).not.toContain(ASK);
  expect(store.getTask(bump.id)!.status).toBe(TaskStatus.done);
});
