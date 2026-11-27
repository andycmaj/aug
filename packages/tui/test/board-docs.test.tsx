// The Board's Docs tab (6) and the Wins tab beside it, both drawn by the
// shared list (components/expand-list.tsx), pressed through the real keymap
// on the demo day.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { App } from "../src/app";
import { installFixture } from "@riker/fixtures/demo";
import * as store from "@riker/core/store";
import { setBoardTab } from "../src/components/board-tab";
import { BoardTab } from "../src/keymap";

let destroy: (() => void) | undefined;
let home: string | undefined;
// Test files share one process: leave the Board on its first tab.
afterEach(() => {
  setBoardTab(BoardTab.wins);
  destroy?.();
  if (home) {
    rmSync(home, { recursive: true, force: true });
  }
});

async function boot() {
  home = mkdtempSync(join(tmpdir(), "riker-board-docs-"));
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
  // "return" is Enter and "shift+x" is X: pressKey takes a key, not a name.
  const press = async (...keys: string[]) => {
    for (const k of keys) {
      if (k === "return") {
        setup.mockInput.pressEnter();
      } else if (k.startsWith("shift+")) {
        setup.mockInput.pressKey(k.slice(6).toUpperCase(), { shift: true });
      } else {
        setup.mockInput.pressKey(k);
      }
      await settle();
    }
  };
  const type = async (text: string) => {
    for (const c of text) {
      setup.mockInput.pressKey(c);
    }
    setup.mockInput.pressEnter();
    await settle();
  };
  // The tab keeps its search across tab switches (and so across tests).
  const find = async (words: string) => {
    if (setup.captureCharFrame().includes('/ "')) {
      await press("/");
    }
    await press("/");
    await type(words);
  };
  const frame = () => setup.captureCharFrame();
  // The view is kept across tests: v only when on Chat.
  const board = async (tab: string) => {
    if (!frame().includes("Agent board")) {
      await press("v");
    }
    await press(tab);
  };
  return { press, type, find, frame, settle, board };
}

test("Wins still lists today's Wins and what else got done", async () => {
  const { board, frame } = await boot();
  await board("1");
  expect(frame()).toContain("Today ·");
  expect(frame()).toContain("Wins");
  expect(frame()).toContain("Also done today");
});

test("Docs lists the demo's PRs, issues and project doc, one row per address", async () => {
  const { board, find, frame } = await boot();
  await board("6");
  expect(frame()).toContain("6 Docs");
  expect(frame()).toContain("month-end close runbook");
  expect(frame()).toContain("northwind/ledger#219");
  // The demo's PR #88 is both a task's URL and its thread: one row.
  await find("northwind/web#88");
  const rows = frame()
    .split("\n")
    .filter((l) => l.includes("northwind/web#88") && !l.includes('/ "'));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain("PR");
  expect(rows[0]).toContain("github.com");
});

test("Enter shows the address and owners; L attaches it elsewhere; x takes it off", async () => {
  const { press, type, find, frame, board } = await boot();
  const task = store.createTask({
    title: "Read the spec",
    kind: "general",
    channel: "owner",
  });
  const other = store.createTask({
    title: "Also needs it",
    kind: "general",
    channel: "owner",
  });
  store.addTaskLink(
    task.id,
    "https://docs.example.test/zebra-spec",
    "zebra spec",
    "you",
  );
  await board("6");
  await find("zebra");
  expect(frame()).toContain("zebra spec");
  await press("return");
  expect(frame()).toContain("https://docs.example.test/zebra-spec");
  expect(frame()).toContain(
    `${store.taskRef(task.id)} Read the spec · link · by you`,
  );

  await press("shift+l");
  await type(store.taskRef(other.id));
  expect(store.linksForTask(other.id).map((l) => [l.url, l.title])).toEqual([
    ["https://docs.example.test/zebra-spec", "zebra spec"],
  ]);
  // One row, two owners.
  expect(frame()).toContain(`${store.taskRef(other.id)} +1`);

  await press("x");
  // Two owners can lose it: pick one, then say yes.
  expect(frame()).toContain("Take it off");
  await press("return");
  expect(frame()).toContain("Yes, take it off");
  await press("return");
  const left = [task.id, other.id].map((id) => store.linksForTask(id).length);
  expect(left.sort((a, b) => a - b)).toEqual([0, 1]);
});

test("f cycles kinds; a PR its branch opened has nothing to take off", async () => {
  const { press, board, find, frame } = await boot();
  await board("6");
  await find("ledger#219");
  await press("f");
  expect(frame()).toMatch(/ PR \d+ /);
  expect(frame()).toContain("northwind/ledger#219");
  // x is not offered on it (nothing attached it by hand).
  expect(frame()).not.toContain("x remove");
  await press("f");
  expect(frame()).toContain(" issue 0 ");
  expect(frame()).toContain("Nothing matches");
  for (let i = 0; i < 5; i++) {
    await press("f");
  }
  expect(frame()).toContain("northwind/ledger#219");
});
