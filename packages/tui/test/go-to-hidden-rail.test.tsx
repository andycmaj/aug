// Issue #9: go to (ctrl+\) with the rail hidden sent focus to the rail,
// which was not mounted, so nothing held focus and every key went dead.

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
  if (home) {
    rmSync(home, { recursive: true, force: true });
  }
});

async function boot() {
  home = mkdtempSync(join(tmpdir(), "riker-go-to-"));
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
  const goTo = async (words: string) => {
    await press("\\", { ctrl: true });
    for (const c of words) {
      setup.mockInput.pressKey(c);
    }
    setup.mockInput.pressEnter();
    await settle();
  };
  const frame = () => setup.captureCharFrame();
  return { press, goTo, renderer: setup.renderer, frame };
}

// The rail's pills row ends with the inbox badge.
const railShown = (frame: string) => /\d+\s+✉ \d+/.test(frame);

test("go to from the Canvas with the rail hidden keeps a pane focused", async () => {
  const { press, goTo, renderer, frame } = await boot();
  expect(railShown(frame())).toBe(true);
  await press("e", { ctrl: true });
  expect(railShown(frame())).toBe(false);
  await goTo("ledger fixes");
  expect(frame()).toContain("ledger fixes");
  expect(renderer.currentFocusedRenderable).not.toBeNull();
  // The keys still work: ctrl+e toggles the rail.
  const before = frame();
  await press("e", { ctrl: true });
  expect(frame()).not.toBe(before);
  expect(renderer.currentFocusedRenderable).not.toBeNull();
});

// A project has no chat box, so a jump to one from the box unmounts it.
// opentui-app moves focus to the Canvas and leaves the rail as it was.
for (const hidden of [false, true]) {
  const rail = hidden ? "hidden" : "shown";
  test(`go to a project from the chat box keeps a pane focused (rail ${rail})`, async () => {
    const { press, goTo, renderer, frame } = await boot();
    if (hidden) {
      await press("e", { ctrl: true });
    }
    await press("tab");
    await press("tab");
    await goTo("ledger fixes");
    expect(frame()).toContain("Project · ledger fixes");
    expect(renderer.currentFocusedRenderable).not.toBeNull();
    expect(railShown(frame())).toBe(!hidden);
    // The keys still work: ctrl+e toggles the rail.
    await press("e", { ctrl: true });
    expect(railShown(frame())).toBe(hidden);
    expect(renderer.currentFocusedRenderable).not.toBeNull();
  });
}
