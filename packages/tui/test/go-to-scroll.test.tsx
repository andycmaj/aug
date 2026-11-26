// The go-to list scrolls only when the cursor passes its last shown row:
// a scrollbox's padding scrolls with its content, so every row of its
// height holds an item, and its page size must count them all. A short
// terminal shrinks the list, and a resize while it is open moves the page
// with it.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { App } from "../src/app";
import { installFixture } from "@riker/fixtures/demo";

let destroy: (() => void) | undefined;
let home: string | undefined;
afterEach(() => {
  destroy?.();
  if (home) rmSync(home, { recursive: true, force: true });
});

async function openGoTo(height: number) {
  home = mkdtempSync(join(tmpdir(), "riker-go-to-scroll-"));
  process.env.RIKER_HOME = home;
  const engine = installFixture("demo");
  const setup = await testRender(() => <App engine={engine} />, {
    width: 120,
    height,
  });
  destroy = () => setup.renderer.destroy();
  const settle = async () => {
    await Bun.sleep(40);
    await setup.renderOnce();
  };
  await settle();
  setup.mockInput.pressKey("\\", { ctrl: true });
  await settle();
  const down = async (times: number) => {
    for (let i = 0; i < times; i++) {
      setup.mockInput.pressArrow("down");
      await settle();
    }
  };
  const resize = async (h: number) => {
    setup.resize(120, h);
    await settle();
  };
  return { frame: () => setup.captureCharFrame(), down, resize };
}

// The list's rows: the card's lines between the filter and the Open | All
// toggle that hold a tag (board, home, project or a task ref), without the
// scrollbar's column at the card's right edge.
const ROW = /▏\s{3}(board|home|project|RIKER-\d+)\s/;
function listRows(frame: string): string[] {
  return frame
    .split("\n")
    .filter((l) => ROW.test(l))
    .map((l) => l.slice(l.indexOf("▏") + 1, l.lastIndexOf("▕") - 2).trim());
}

// The card's bottom edge.
const frameWhole = (frame: string) => frame.includes("🭼");

test("at 20 rows the cursor reaches the last shown row before the list scrolls", async () => {
  const { frame, down } = await openGoTo(20);
  const first = listRows(frame());
  const shown = first.length;
  expect(shown).toBeGreaterThanOrEqual(4);
  expect(frameWhole(frame())).toBe(true);
  // To the last shown row: nothing scrolls.
  await down(shown - 1);
  expect(listRows(frame())).toEqual(first);
  // One past it: the list moves by exactly one row.
  await down(1);
  const after = listRows(frame());
  expect(after).toHaveLength(shown);
  expect(after.slice(0, -1)).toEqual(first.slice(1));
});

test("a resize while the go-to list is open moves its page with it", async () => {
  const { frame, down, resize } = await openGoTo(20);
  const short = listRows(frame()).length;
  await resize(26);
  const first = listRows(frame());
  const shown = first.length;
  expect(shown).toBeGreaterThan(short);
  expect(frameWhole(frame())).toBe(true);
  await down(shown - 1);
  expect(listRows(frame())).toEqual(first);
  await down(1);
  expect(listRows(frame()).slice(0, -1)).toEqual(first.slice(1));
});
