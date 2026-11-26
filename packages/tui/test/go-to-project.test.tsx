// The go-to list names each task's project beside its title, so two tasks
// with like titles in different projects can be told apart.

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

async function openGoTo(words: string) {
  home = mkdtempSync(join(tmpdir(), "riker-go-to-project-"));
  process.env.RIKER_HOME = home;
  const engine = installFixture("demo");
  const setup = await testRender(() => <App engine={engine} />, {
    width: 160,
    height: 45,
  });
  destroy = () => setup.renderer.destroy();
  const settle = async () => {
    await Bun.sleep(40);
    await setup.renderOnce();
  };
  await settle();
  setup.mockInput.pressKey("\\", { ctrl: true });
  await settle();
  for (const c of words) setup.mockInput.pressKey(c);
  await settle();
  // Inside the modal's frame: the rail shows behind it and names projects
  // itself.
  return setup
    .captureCharFrame()
    .split("\n")
    .map((l) => (l.includes("▏") ? l.slice(l.indexOf("▏") + 1) : ""));
}

const rowOf = (lines: string[], text: string) =>
  lines.find((l) => l.includes(text) && /RIKER-\d+/.test(l));

test("a task in a project shows the project on its go-to row", async () => {
  const lines = await openGoTo("inter-company");
  const row = rowOf(lines, "Export drops inter-company transfers");
  expect(row).toBeDefined();
  expect(row).toContain("◫ ledger-fixes");
});

test("a task in no project shows no project tag", async () => {
  const lines = await openGoTo("");
  const rows = lines.filter((l) => /RIKER-\d+/.test(l));
  expect(rows.length).toBeGreaterThan(2);
  // Only the two ledger tasks are in a project.
  expect(rows.filter((l) => l.includes("◫")).length).toBe(2);
});
