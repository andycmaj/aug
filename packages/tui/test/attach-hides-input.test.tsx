// AUG-0137: while an agent's terminal is attached its keys go to the agent,
// so the chat box under it hides; detach brings it back with its draft.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { App } from "../src/app";
import { installFixture } from "@riker/fixtures/demo";
import * as store from "@riker/core/store";

let destroy: (() => void) | undefined;
let home: string | undefined;
afterEach(() => {
  destroy?.();
  if (home) {
    rmSync(home, { recursive: true, force: true });
  }
});

// A stand-in agent: says it is up, then echoes each byte it gets.
const AGENT = [
  "sh",
  "-c",
  "stty -icanon -echo min 1; echo agent-up; while true; do c=$(dd bs=1 count=1 2>/dev/null); printf 'got[%s]' \"$c\"; done",
];

async function boot() {
  home = mkdtempSync(join(tmpdir(), "riker-attach-"));
  process.env.RIKER_HOME = home;
  const engine = installFixture("demo");
  const csv = store
    .listTasks()
    .find((t) => t.title === "CSV import fails on a BOM");
  if (!csv) {
    throw new Error("demo has no CSV task");
  }
  const isLive = engine.desk.isLive.bind(engine.desk);
  engine.desk.isLive = (t) => t.id === csv.id || isLive(t);
  engine.desk.viewer = async () => ({ argv: AGENT });

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
  const press = async (key: string, mods?: { ctrl?: boolean }) => {
    setup.mockInput.pressKey(key, mods);
    await settle();
  };
  const type = async (text: string) => {
    for (const c of text) {
      setup.mockInput.pressKey(c);
    }
    await settle();
  };
  const frameWith = async (want: string) => {
    const end = Date.now() + 3000;
    while (!frame().includes(want) && Date.now() < end) {
      await settle(20);
    }
    return frame();
  };
  return { press, type, frame, frameWith, settle };
}

test("the chat box hides while attached and comes back with its draft on detach", async () => {
  const { press, type, frame, frameWith } = await boot();
  await press("\\", { ctrl: true });
  await type("CSV import");
  await press("RETURN");
  expect(await frameWith("agent-up")).toContain("agent-up");

  // The box shows on the table, and takes a draft (i from the rail).
  await press("i");
  expect(frame()).toContain("Tell the coding agent");
  await type("half a thought");
  expect(frame()).toContain("half a thought");

  // esc leaves the box for the table: attached, and the box is gone.
  await press("ESCAPE");
  expect(await frameWith("[attached]")).toContain("[attached]");
  expect(frame()).not.toContain("half a thought");
  expect(frame()).not.toContain("Tell the coding agent");

  // Keys go to the agent, none to the hidden box.
  await type("zq");
  expect(await frameWith("got[q]")).toContain("got[z]");

  // Detach: the box is back with the draft as it was.
  await press("]", { ctrl: true });
  const after = await frameWith("half a thought");
  expect(after).not.toContain("[attached]");
  expect(after).toContain("half a thought");
  expect(after).not.toContain("half a thoughtzq");

  // The box still takes focus and keeps typing onto the draft.
  await press("i");
  await type("!");
  expect(frame()).toContain("half a thought!");
});
