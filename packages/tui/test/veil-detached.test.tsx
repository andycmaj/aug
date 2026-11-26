// RIKER-0265: an agent shown on the Canvas but not attached is greyed out,
// so it is plain that typing does not go to it; attaching clears it. The
// text stays: only its colours fade toward the background.

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

const AGENT = [
  "sh",
  "-c",
  "stty -icanon -echo min 1; echo agent-up; while true; do c=$(dd bs=1 count=1 2>/dev/null); printf 'got[%s]' \"$c\"; done",
];

async function boot() {
  home = mkdtempSync(join(tmpdir(), "riker-veil-"));
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
  // How far the agent's own text stands from the cell behind it: the sum of
  // the channel gaps, 0 when the text would vanish into its background.
  const contrast = (want: string) => {
    for (const line of setup.captureSpans().lines) {
      for (const span of line.spans) {
        if (!span.text.includes(want)) {
          continue;
        }
        const fg = span.fg.toInts();
        const bg = span.bg.toInts();
        return [0, 1, 2].reduce((n, i) => n + Math.abs(fg[i] - bg[i]), 0);
      }
    }
    throw new Error(`no span holds ${want}`);
  };
  return { press, type, frame, frameWith, contrast };
}

test("a shown but detached agent is greyed out, and attaching clears it", async () => {
  const { press, type, frame, frameWith, contrast } = await boot();
  await press("\\", { ctrl: true });
  await type("CSV import");
  await press("RETURN");

  // The go-to list lands on the rail: the agent shows, not attached.
  expect(await frameWith("agent-up")).toContain("detached");
  const veiled = contrast("agent-up");

  // Attached, the same text stands out at full strength.
  await press("RETURN");
  expect(await frameWith("[attached]")).toContain("agent-up");
  const plain = contrast("agent-up");
  expect(veiled).toBeGreaterThan(0);
  expect(veiled).toBeLessThan(plain * 0.75);

  // Detach greys it out again, the text still there to read.
  await press("]", { ctrl: true });
  expect(await frameWith("detached")).toContain("agent-up");
  expect(contrast("agent-up")).toBe(veiled);
  expect(frame()).not.toContain("[attached]");
});
