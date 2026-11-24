// The ? help takes most of the screen, so its descriptions sit on one line.

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

async function helpWidth(width: number): Promise<number> {
  home = mkdtempSync(join(tmpdir(), "riker-help-"));
  process.env.RIKER_HOME = home;
  const engine = installFixture("demo");
  const setup = await testRender(() => <App engine={engine} />, { width, height: 45 });
  destroy = () => setup.renderer.destroy();
  const settle = async () => {
    await Bun.sleep(40);
    await setup.renderOnce();
  };
  await settle();
  setup.mockInput.pressKey("?");
  await settle();
  const line = setup.captureCharFrame().split("\n").find((l) => l.includes("Keys here"));
  expect(line).toBeDefined();
  // The card's frame: from its left edge to its right.
  return [...line!].lastIndexOf("▕") - [...line!].indexOf("▏") + 1;
}

test("the help is at least 80% of the terminal's width", async () => {
  const width = 160;
  expect(await helpWidth(width)).toBeGreaterThanOrEqual(Math.floor(width * 0.8));
});
