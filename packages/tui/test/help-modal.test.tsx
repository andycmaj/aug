// The ? help: most of the screen wide, so its descriptions sit on one line,
// with the rail's colors first.

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

async function openHelp(width: number): Promise<string> {
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
  return setup.captureCharFrame();
}

async function helpWidth(width: number): Promise<number> {
  const line = (await openHelp(width)).split("\n").find((l) => l.includes("Keys here"));
  expect(line).toBeDefined();
  // The card's frame: from its left edge to its right.
  return [...line!].lastIndexOf("▕") - [...line!].indexOf("▏") + 1;
}

test("the help is at least 80% of the terminal's width", async () => {
  const width = 160;
  expect(await helpWidth(width)).toBeGreaterThanOrEqual(Math.floor(width * 0.8));
});

test("the rail's colors come before the keys", async () => {
  const lines = (await openHelp(160)).split("\n");
  const legend = lines.findIndex((l) => l.includes("The rail's colors"));
  const keys = lines.findIndex((l) => l.includes("j/down"));
  expect(legend).toBeGreaterThan(-1);
  expect(keys).toBeGreaterThan(legend);
});
