// A project folded on the rail stays folded across a restart.

import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { testRender } from "@opentui/solid";
import { App } from "../src/app";
import { installFixture } from "@riker/fixtures/demo";
import { openDb, useDb } from "@riker/core/db";
import { Engine } from "@riker/core/engine";
import { DEFAULT_CONFIG, fixedConfig } from "@riker/core/config";
import * as store from "@riker/core/store";

let destroy: (() => void) | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
  const home = process.env.RIKER_HOME;
  if (home) {
    rmSync(home, { recursive: true, force: true });
  }
});

// A restart: the database opened again from disk, and a new engine over it.
function restarted(): Engine {
  useDb(openDb());
  return new Engine({
    config: fixedConfig({ ...DEFAULT_CONFIG, autostart: false }),
    offline: true,
    noWorktrees: true,
  });
}

async function mount(engine: Engine) {
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
  const projectRow = () =>
    setup
      .captureCharFrame()
      .split("\n")
      .find((l) => /[⊞⊟] ledger fixes/.test(l)) ?? "";
  return { press, goTo, projectRow };
}

test("a folded project is still folded after a restart", async () => {
  const engine = installFixture("demo");
  let ui = await mount(engine);
  await ui.goTo("ledger fixes");
  expect(ui.projectRow()).toContain("⊟ ledger fixes");
  // Space on a project folds it, from the Canvas as from the rail.
  await ui.press(" ");
  expect(ui.projectRow()).toContain("⊞ ledger fixes");

  // Restart: the UI goes, the database is opened again from disk, and a
  // new engine and UI come up on the same home.
  destroy!();
  ui = await mount(restarted());
  expect(ui.projectRow()).toContain("⊞ ledger fixes");

  // Unfolding is kept the same way.
  await ui.goTo("ledger fixes");
  await ui.press(" ");
  expect(ui.projectRow()).toContain("⊟ ledger fixes");
  destroy!();
  ui = await mount(restarted());
  expect(ui.projectRow()).toContain("⊟ ledger fixes");
  expect(store.kvGet("rail.folded")).toBe("[]");
});
