import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { App } from "../src/app";
import { installFixture } from "@riker/fixtures/demo";
import { setGuideTool } from "@riker/code-review-plannotator/guide";
import { bigAnswer, bigRepo } from "@riker/code-review-plannotator/test/support/repo";
import { setBrain, type BrainResult } from "@riker/core/brain";
import * as store from "@riker/core/store";

const ID = 6; // CSV import fails on a BOM: a coding task in the demo

let destroy: (() => void) | undefined;
let home: string | undefined;
afterEach(() => {
  destroy?.();
  setGuideTool(null);
  if (home) rmSync(home, { recursive: true, force: true });
});

// AUG-0192: a guide on a big change runs a while. Its stage shows on the
// task's rail row and above its steps on the Canvas, batch by batch, and
// the rail says when it is done. GUIDE_FRAMES=<file> keeps the frames.
test("a guide in batches shows its stage on the rail and the Canvas", async () => {
  home = mkdtempSync(join(tmpdir(), "riker-guide-progress-"));
  process.env.RIKER_HOME = home;
  const engine = installFixture("demo");
  store.updateTask(ID, { worktree: bigRepo(5) });

  // Every model call and the save wait for the test to let them go.
  const waiting: (() => void)[] = [];
  const held = () => new Promise<void>((r) => waiting.push(r));
  const letGo = () => waiting.splice(0).forEach((r) => r());
  setBrain(async (call): Promise<BrainResult> => {
    await held();
    const job = /job: (.*)$/m.exec(call.prompt)![1]!;
    const text = job.startsWith("notes")
      ? JSON.stringify({ files: [{ file: `part${/batch (\d+)/.exec(job)![1]}.ts`, summary: "A part." }] })
      : JSON.stringify(bigAnswer(5));
    return { text, structured: null, sessionId: null, durationMs: 1, isError: false };
  });
  setGuideTool({
    async save() {
      await held();
      return { id: "big" };
    },
  });

  const setup = await testRender(() => <App engine={engine} />, { width: 150, height: 50 });
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

  const frames: string[] = [];
  const frame = async (label: string) => {
    await settle();
    const text = setup.captureCharFrame();
    frames.push(`── ${label} ──\n${text}`);
    return text;
  };
  const until = async (n: number) => {
    for (let i = 0; i < 200 && waiting.length < n; i++) await Bun.sleep(10);
    expect(waiting.length).toBe(n);
  };
  // The sub line under the task's title in the rail.
  const railRow = (text: string) => {
    const rail = text.split("\n").map((l) => l.slice(0, 46));
    return rail[rail.findIndex((l) => l.includes("CSV import fails on a BOM")) + 1] ?? "";
  };

  const started = engine.desk.runAction(ID, "guide");
  if ("error" in started) throw new Error(started.error);

  await until(3);
  let shown = await frame("first three batches sent");
  expect(railRow(shown)).toContain("guide: batches 0/5 done, 3 running");
  expect(shown).toContain("▸ batches 0/5 done, 3 running");

  letGo();
  await until(2);
  shown = await frame("three batches back, two sent");
  expect(railRow(shown)).toContain("guide: batches 3/5 done, 2 running");
  expect(shown).toContain("▸ batches 3/5 done, 2 running");

  letGo();
  await until(1);
  shown = await frame("the chapters call");
  expect(shown).toContain("▸ writing the chapters");

  letGo();
  await until(1);
  shown = await frame("saving");
  expect(railRow(shown)).toContain("guide: saving to Plannotator");
  expect(shown).toContain("▸ saving to Plannotator");

  letGo();
  expect((await started.done).ok).toBe(true);
  shown = await frame("done");
  expect(railRow(shown)).toContain("guide done · RIKER-0006");
  expect(railRow(shown)).not.toContain("running");
  expect(shown).not.toContain("▸ saving to Plannotator");
  expect(shown).toContain("Big change");

  if (process.env.GUIDE_FRAMES) writeFileSync(process.env.GUIDE_FRAMES, `${frames.join("\n\n")}\n`);
});
