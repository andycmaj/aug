// The mouse through the real App: a click does what moving there and
// pressing the key would. Clicks land where the frame shows the words.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { App } from "../src/app";
import { boardTab } from "../src/components/board-tab";
import { BoardTab } from "../src/keymap";
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
  home = mkdtempSync(join(tmpdir(), "riker-mouse-"));
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
  const frame = () => setup.captureCharFrame();
  const lines = () => frame().split("\n");
  // Where the frame shows these words; the first match, left to right
  // within the columns given.
  const at = (words: string, from = 0, to = Infinity) => {
    const rows = lines();
    for (let y = 0; y < rows.length; y++) {
      const x = rows[y].indexOf(words, from);
      if (x >= 0 && x < to) {
        return { x, y };
      }
    }
    throw new Error(`"${words}" is not on screen:\n${frame()}`);
  };
  const click = async (words: string, from = 0, to = Infinity) => {
    const { x, y } = at(words, from, to);
    await setup.mockMouse.click(x + 1, y);
    await settle();
  };
  const press = async (key: string) => {
    setup.mockInput.pressKey(key);
    await settle();
  };
  const line = (words: string, from = 0, to = Infinity) =>
    lines()[at(words, from, to).y];
  const onRail = () => /f filter · /.test(frame());
  return { frame, line, click, press, onRail, settle, setup, engine };
}

const RAIL = 46;

test("a click on a rail row selects it and focuses the rail", async () => {
  const s = await boot();
  expect(s.line("Bump pydantic", 0, RAIL)).not.toContain("▸");
  await s.click("Bump pydantic", 0, RAIL);
  expect(s.line("Bump pydantic", 0, RAIL)).toContain("▸");
  expect(s.onRail()).toBe(true);
  // The Canvas shows it: its title is in the header too.
  expect(s.frame().split("Bump pydantic").length - 1).toBe(2);
});

test("a click on a row's second line selects it too", async () => {
  const s = await boot();
  await s.click("merged, ready to close", 0, RAIL);
  expect(s.line("Bump pydantic", 0, RAIL)).toContain("▸");
});

test("a click on the Canvas focuses it, then one on the rail comes back", async () => {
  const s = await boot();
  await s.click("Home · the Assistant", RAIL);
  expect(s.onRail()).toBe(false);
  await s.click("Rotate staging certs", 0, RAIL);
  expect(s.onRail()).toBe(true);
  expect(s.line("Rotate staging certs", 0, RAIL)).toContain("▸");
});

test("a click on a filter pill toggles it", async () => {
  const s = await boot();
  const pills = s.line("◈ 2");
  await s.click("◈ 2", 0, RAIL);
  expect(s.frame()).toContain("· 0 all");
  await s.click("◈ 2", 0, RAIL);
  expect(s.frame()).not.toContain("· 0 all");
  expect(s.line("◈ 2")).toBe(pills);
});

test("a click on chat | board switches the view, and back", async () => {
  const s = await boot();
  await s.click("chat | board");
  expect(s.frame()).toContain("Agent board");
  await s.click("chat | board");
  expect(s.frame()).not.toContain("Agent board");
  expect(s.frame()).toContain("Home · the Assistant");
});

test("a click on a Board tab switches to it", async () => {
  const s = await boot();
  await s.press("v");
  expect(s.frame()).toContain("Agent board");
  await s.click("5 Cost");
  expect(boardTab()).toBe(BoardTab.cost);
  await s.click("4 Inbox");
  expect(boardTab()).toBe(BoardTab.inbox);
});
