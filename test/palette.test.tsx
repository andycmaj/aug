// AUG-0154: the command palette lists what the footer would (the keymap's
// bindings that apply here) plus the moves with no key, and runs a key's
// command as the key would.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import type { HelpBinding } from "@andycmaj/opentui-app";
import { App } from "../src/app";
import { Commands } from "../src/commands";
import { installFixture } from "../src/fixtures/demo";
import type { HelpCtx } from "../src/keymap";
import { PaletteGroup, paletteEntries } from "../src/palette";

const taskCtx: HelpCtx = {
  item: "task",
  kind: "coding",
  hasDraft: false,
  live: false,
  coding: true,
  watching: false,
  started: true,
  pr: false,
};

const isTask = (c: HelpCtx) => c.item === "task";
const binding = (
  b: Partial<HelpBinding<HelpCtx>> & Pick<HelpBinding<HelpCtx>, "cmd" | "keys">,
): HelpBinding<HelpCtx> => ({ desc: b.cmd, scope: "rail", ...b });

test("one entry per command, its keys joined", () => {
  const entries = paletteEntries(
    [
      binding({ cmd: Commands.HISTORY_BACK, keys: "[", scope: "app" }),
      binding({ cmd: Commands.HISTORY_BACK, keys: "ctrl+o", scope: "app" }),
    ],
    taskCtx,
  );
  expect(entries).toHaveLength(1);
  expect(entries[0]?.hint).toBe("[/ctrl+o");
});

test("moving around is left out", () => {
  const entries = paletteEntries(
    [
      binding({ cmd: Commands.NAV_DOWN, keys: "j" }),
      binding({ cmd: Commands.SCROLL_PAGEDOWN, keys: "ctrl+d" }),
      binding({ cmd: Commands.FILTER_1, keys: "1" }),
      binding({ cmd: Commands.BOARD_LEFT, keys: "h", scope: "board" }),
      binding({ cmd: Commands.FOCUS_NEXT, keys: "tab", scope: "app" }),
      binding({ cmd: Commands.PALETTE_OPEN, keys: ":", scope: "app" }),
      binding({ cmd: Commands.DONE, keys: "d", relevant: isTask }),
    ],
    taskCtx,
  );
  expect(entries.map((e) => e.cmd)).toEqual([Commands.DONE]);
});

test("a row's actions, the pane's, then anywhere; only app-wide ones are out of context", () => {
  const entries = paletteEntries(
    [
      binding({ cmd: Commands.VIEW_TOGGLE, keys: "v", scope: "app", desc: "switch Chat / Board" }),
      binding({ cmd: Commands.OPEN_URL, keys: "o", desc: "open the link" }),
      binding({ cmd: Commands.DONE, keys: "d", desc: "mark done", relevant: isTask }),
    ],
    taskCtx,
  );
  expect(entries.map((e) => [e.label, e.group, e.inContext])).toEqual([
    ["Mark done", PaletteGroup.row, true],
    ["Open the link", PaletteGroup.pane, true],
    ["Switch Chat / Board", PaletteGroup.anywhere, false],
  ]);
});

test("a move with no key is listed where it applies, after the keys", () => {
  let ran = 0;
  const entries = paletteEntries(
    [binding({ cmd: Commands.DONE, keys: "d", relevant: isTask })],
    taskCtx,
    [
      { id: "advisor", group: "Connections", label: "Run the Advisor now", run: () => ran++ },
      { id: "never", group: "Docs", label: "Not here", relevant: () => false, run: () => {} },
    ],
  );
  expect(entries.map((e) => e.id)).toEqual([Commands.DONE, "advisor"]);
  expect(entries[1]?.inContext).toBe(false);
  entries[1]?.run?.();
  expect(ran).toBe(1);
});

let destroy: (() => void) | undefined;
let home: string | undefined;
afterEach(() => {
  destroy?.();
  if (home) rmSync(home, { recursive: true, force: true });
});

async function boot() {
  home = mkdtempSync(join(tmpdir(), "aug-palette-"));
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
  const type = async (text: string) => {
    for (const c of text) setup.mockInput.pressKey(c);
    await settle();
  };
  const enter = async () => {
    setup.mockInput.pressEnter();
    await settle();
  };
  return { type, enter, frame: () => setup.captureCharFrame() };
}

test("the palette lists the row's actions from the keymap, not movement", async () => {
  const { type, frame } = await boot();
  await type(":");
  const shown = frame();
  expect(shown).toContain(PaletteGroup.row);
  expect(shown).toContain("Everything aug knows about it");
  expect(shown).not.toContain("Command palette");
  await type("down");
  expect(frame()).toContain("No matching commands");
});

test("running a key's entry does what the key does", async () => {
  const { type, enter, frame } = await boot();
  expect(frame()).not.toContain("Agent board");
  await type(":");
  await type("switch chat");
  await enter();
  // v switched to the Board.
  expect(frame()).toContain("Agent board");
});

test("a row's entry runs on the row the palette was opened over", async () => {
  const { type, enter, frame } = await boot();
  await type(":");
  await type("everything aug knows");
  await enter();
  // I, from the rail, on its first row (Home).
  expect(frame()).toMatch(/AUG-\d+ · Home\s/);
});
