// A task action's answer is a turn in the task's chat, but a live coding
// agent's terminal hides that chat on the Canvas. There the answer opens
// over the Canvas, and the . picker reads it again.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { App } from "../src/app";
import { installFixture } from "@riker/fixtures/demo";
import { setBrain, type BrainResult } from "@riker/core/brain";
import * as store from "@riker/core/store";

let destroy: (() => void) | undefined;
let home: string | undefined;
afterEach(() => {
  destroy?.();
  if (home) {
    rmSync(home, { recursive: true, force: true });
  }
});

const AGENT = ["sh", "-c", "echo agent-up; sleep 60"];
const ANSWER = "- **Goal**: summary-marker-0240 made it to the owner";

async function boot() {
  home = mkdtempSync(join(tmpdir(), "riker-answer-"));
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
  setBrain(async (): Promise<BrainResult> => ({
    text: ANSWER,
    structured: null,
    sessionId: null,
    durationMs: 1,
    isError: false,
  }));

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
  const frameWith = async (want: string, ms = 3000) => {
    const end = Date.now() + ms;
    while (!frame().includes(want) && Date.now() < end) {
      await settle(20);
    }
    return frame();
  };
  // The . picker's row for a label, picked with j and return.
  const pick = async (label: string) => {
    await press(".");
    const rows = frame().split("\n");
    const top = rows.findIndex((l) => l.includes("Actions · "));
    const at = rows.slice(top).findIndex((l) => l.includes(label));
    const first = rows
      .slice(top)
      .findIndex((l) => /Summar|Guide|Quiz|Read/.test(l));
    if (at < 0) {
      throw new Error(`no ${label} in the picker:\n${frame()}`);
    }
    for (let k = 0; k < at - first; k++) {
      await press("j");
    }
    await press("RETURN");
  };
  return { csv, press, type, frame, frameWith, pick };
}

test("a summary on a coding task with a live agent shows its answer", async () => {
  const { csv, press, type, frame, frameWith, pick } = await boot();
  await press("\\", { ctrl: true });
  await type("CSV import");
  await press("RETURN");
  expect(await frameWith("agent-up")).toContain("agent-up");

  await pick("Summar");
  const shown = await frameWith("summary-marker-0240");
  expect(shown).toContain("summary-marker-0240");
  // ANSWER_FRAMES=<file> keeps the frame with the answer open.
  if (process.env.ANSWER_FRAMES) {
    writeFileSync(process.env.ANSWER_FRAMES, `${shown}\n`);
  }
  expect(
    store
      .turnsForTask(csv.id)
      .some((t) => t.role === "action" && t.body === ANSWER),
  ).toBe(true);

  // esc closes it: the agent is back on the Canvas.
  await press("ESCAPE");
  expect(frame()).not.toContain("summary-marker-0240");
  expect(frame()).toContain("agent-up");

  // . reads the last answer again, with no run.
  const turns = store.turnsForTask(csv.id).length;
  await pick("Read");
  expect(await frameWith("summary-marker-0240")).toContain(
    "summary-marker-0240",
  );
  expect(store.turnsForTask(csv.id).length).toBe(turns);
});
