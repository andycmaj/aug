// AUG-0140: the Inbox's t and x, pressed through the real keymap on the
// demo day.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { App } from "../src/app";
import { installFixture } from "../src/fixtures/demo";
import * as store from "../src/core/store";
import { TaskStatus } from "../src/core/types";

let destroy: (() => void) | undefined;
let home: string | undefined;
afterEach(() => {
  destroy?.();
  if (home) rmSync(home, { recursive: true, force: true });
});

async function boot() {
  home = mkdtempSync(join(tmpdir(), "aug-inbox-keys-"));
  process.env.AUG_HOME = home;
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
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      setup.mockInput.pressKey(k);
      await settle();
    }
  };
  // The Inbox's / search, so the row under test is the first one.
  // The Inbox keeps its search across tab switches (and so across tests):
  // / with one shown clears it.
  const find = async (words: string) => {
    if (setup.captureCharFrame().includes('/ "')) await press("/");
    await press("/");
    for (const c of words) setup.mockInput.pressKey(c);
    setup.mockInput.pressEnter();
    await settle();
  };
  const frame = () => setup.captureCharFrame();
  await press("v", "5");
  return { press, find, frame, settle };
}

// The demo's Ruth Okafor message made AUG-0002, "Copier renewal".
const RUTH = "Ruth Okafor";
const RUTH_TASK = 2;

test("t opens the task even when it is done and off the rail", async () => {
  const { press, find, frame } = await boot();
  store.updateTask(RUTH_TASK, { status: TaskStatus.done });
  await find(RUTH);
  expect(frame()).toContain("AUG-0002");
  await press("t");
  // The table shows the task, not the overview's greeting.
  expect(frame()).toContain("Copier renewal - how many seats?");
  expect(frame()).not.toContain("Good ");
});

test("x dismisses a message that joined a task, and the task stays", async () => {
  const { press, find, frame } = await boot();
  const joined = store.insertMessage({
    channel: "slack",
    externalId: "aug-0140-joined",
    threadKey: "slack:C9:aug-0140",
    author: "U9",
    authorName: "Ruth Okafor",
    title: "#renewals",
    body: "Zebra followup on the copier",
    receivedAt: new Date().toISOString(),
  })!;
  store.fileMessage(joined.id, null, "joined AUG-0002", RUTH_TASK);
  await find("Zebra");
  expect(frame()).toContain("joined a task");
  await press("x");
  expect(store.getMessage(joined.id)!.read_at).not.toBeNull();
  expect(store.getTask(RUTH_TASK)!.status).toBe(TaskStatus.open);
  expect(frame()).toContain("Nothing matches");
});

// The demo's first idea is about AUG-0002; it made nothing.
test("an idea's task column says it is only about that task", async () => {
  const { find, frame } = await boot();
  await find("seat count");
  expect(frame()).toContain("about AUG-0002");
});

test("x dismisses a message triage could not place", async () => {
  const { press, find, frame } = await boot();
  await find("payroll export is short");
  expect(frame()).toContain("triage failed");
  await press("x");
  expect(frame()).not.toContain("triage failed");
  expect(frame()).toContain("Nothing matches");
});
