// A brief written as short labeled paragraphs shows on the Canvas as
// written: a blank line between paragraphs, each label on its own line,
// indentation kept, and a long line wrapped at the pane's width.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { App } from "../src/app";
import { installFixture } from "@riker/fixtures/demo";
import { Kind } from "@riker/core/types";

let destroy: (() => void) | undefined;
let home: string | undefined;
afterEach(() => {
  destroy?.();
  if (home) {
    rmSync(home, { recursive: true, force: true });
  }
});

const LONG =
  "Make the brief easy to scan without costing tokens, so this sentence runs well past the width of the Canvas and has to wrap onto the next line before it ends at wrapmarker.";
const BRIEF = [
  "What to change",
  LONG,
  "",
  "Where",
  "packages/tui/src/components/canvas.tsx",
  "    indentmarker kept",
  "",
  "Owner's words",
  "favor whitespace over more symbols",
].join("\n");

test("the Canvas shows a brief's paragraphs, labels and indentation", async () => {
  home = mkdtempSync(join(tmpdir(), "riker-brief-"));
  process.env.RIKER_HOME = home;
  const engine = installFixture("demo");
  engine.desk.newTask("Readable brief render", Kind.coding, BRIEF);

  const setup = await testRender(() => <App engine={engine} />, {
    width: 120,
    height: 50,
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
  await press("\\", { ctrl: true });
  for (const c of "Readable brief render") {
    setup.mockInput.pressKey(c);
  }
  await settle();
  await press("RETURN");
  const end = Date.now() + 3000;
  while (!frame().includes("indentmarker") && Date.now() < end) {
    await settle(20);
  }

  const shown = frame();
  // BRIEF_FRAMES=<file> keeps the frame for a look.
  if (process.env.BRIEF_FRAMES) {
    writeFileSync(process.env.BRIEF_FRAMES, `${shown}\n`);
  }
  const rows = shown.split("\n");
  const at = (marker: string) => {
    const i = rows.findIndex((r) => r.includes(marker));
    if (i < 0) {
      throw new Error(`no ${marker} on the Canvas:\n${shown}`);
    }
    return i;
  };
  // The Canvas starts at the column the brief's label sits at.
  const label = at("What to change");
  const col = rows[label].indexOf("What to change");
  const text = (i: number) => rows[i].slice(col).trimEnd();
  // The brief's long first paragraph wraps inside the pane: it starts on the
  // line under its label and its last word is a line or more below.
  expect(text(label + 1)).toStartWith("Make the brief easy to scan");
  const wrapped = at("wrapmarker");
  expect(wrapped).toBeGreaterThan(label + 1);
  // A blank line, then the next label on a line of its own.
  expect(text(wrapped + 1)).toBe("");
  expect(text(wrapped + 2)).toBe("Where");
  expect(text(wrapped + 3)).toBe("packages/tui/src/components/canvas.tsx");
  expect(text(wrapped + 4)).toBe("    indentmarker kept");
  expect(text(wrapped + 5)).toBe("");
  expect(text(wrapped + 6)).toBe("Owner's words");
  expect(text(wrapped + 7)).toBe("favor whitespace over more symbols");
});
