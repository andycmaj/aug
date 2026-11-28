import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { App } from "../src/app";
import { installFixture } from "@riker/fixtures/demo";
import type { StartResult } from "@riker/core/driver";
import * as store from "@riker/core/store";

const ID = 6; // CSV import fails on a BOM: a coding task in the demo

let destroy: (() => void) | undefined;
let home: string | undefined;
afterEach(() => {
  destroy?.();
  if (home) {
    rmSync(home, { recursive: true, force: true });
  }
});

// A start can take a while with nothing to see. From s until
// the start answers, the row and the Canvas say it is starting, and a
// second s is refused instead of launching another agent. A failed start
// clears it, so s can try again.
test("a start in flight shows on the rail and the Canvas, and s again is refused", async () => {
  home = mkdtempSync(join(tmpdir(), "riker-agent-starting-"));
  process.env.RIKER_HOME = home;
  const engine = installFixture("demo");
  const task = store.getTask(ID)!;
  const driver = engine.drivers.for(task);
  let starts = 0;
  let letGo!: () => void;
  driver.start = async (): Promise<StartResult> => {
    starts++;
    await new Promise<void>((r) => (letGo = r));
    return { type: "failed", error: "no claude here" };
  };

  const setup = await testRender(() => <App engine={engine} />, {
    width: 150,
    height: 50,
  });
  destroy = () => setup.renderer.destroy();
  const settle = async () => {
    await Bun.sleep(60);
    await setup.renderOnce();
  };
  await settle();
  // Home is selected at start; walk down to the task and select it.
  for (let k = 0; k < 4; k++) {
    setup.mockInput.pressKey("j");
    await settle();
  }
  setup.mockInput.pressEnter();
  await settle();
  expect(setup.captureCharFrame()).toContain(task.title);

  setup.mockInput.pressKey("s");
  await settle();
  const during = setup.captureCharFrame();
  expect(during).toContain("starting agent…");
  expect(during).toContain("starting the agent…");
  expect(engine.desk.isStarting(ID)).toBe(true);

  setup.mockInput.pressKey("s");
  await settle();
  // The toast wraps at its width: "RIKER-0006 is already" / "starting".
  expect(setup.captureCharFrame()).toContain(`${store.taskRef(ID)} is already`);
  expect(starts).toBe(1);

  letGo();
  await settle();
  const after = setup.captureCharFrame();
  expect(after).not.toContain("starting agent…");
  expect(after).not.toContain("starting the agent…");
  expect(after).toContain("no claude here");
  expect(engine.desk.isStarting(ID)).toBe(false);

  setup.mockInput.pressKey("s");
  await settle();
  expect(starts).toBe(2);
  letGo();
  await settle();
});
