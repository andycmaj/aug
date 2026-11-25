// RIKER-0241: a task's story and a project's journal read as markdown over
// the Canvas (V), and e there opens $EDITOR in the app: a story rewrite
// saves as the owner's new version.

import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { App } from "../src/app";
import { installFixture } from "@riker/fixtures/demo";
import { writeJournal } from "@riker/core/journal";
import * as store from "@riker/core/store";

let destroy: (() => void) | undefined;
let home: string | undefined;
const editorBefore = process.env.EDITOR;
const visualBefore = process.env.VISUAL;
afterEach(() => {
  destroy?.();
  if (home) rmSync(home, { recursive: true, force: true });
  process.env.EDITOR = editorBefore;
  if (visualBefore === undefined) delete process.env.VISUAL;
  else process.env.VISUAL = visualBefore;
});

async function boot() {
  home = mkdtempSync(join(tmpdir(), "riker-reader-"));
  process.env.RIKER_HOME = home;
  const engine = installFixture("demo");
  const setup = await testRender(() => <App engine={engine} />, { width: 140, height: 50 });
  destroy = () => setup.renderer.destroy();
  const settle = async (ms = 40) => {
    await Bun.sleep(ms);
    await setup.renderOnce();
  };
  await settle();
  const frame = () => setup.captureCharFrame();
  const press = async (key: string, mods?: { ctrl?: boolean; shift?: boolean }) => {
    setup.mockInput.pressKey(key, mods);
    await settle();
  };
  const goTo = async (words: string) => {
    await press("\\", { ctrl: true });
    for (const c of words) setup.mockInput.pressKey(c);
    setup.mockInput.pressEnter();
    await settle();
    // Off the chat box: V is a key, not a letter typed.
    await press("ESCAPE");
  };
  const frameWith = async (want: string, ms = 3000) => {
    const end = Date.now() + ms;
    while (!frame().includes(want) && Date.now() < end) await settle(20);
    return frame();
  };
  return { engine, frame, press, goTo, frameWith };
}

test("V reads a task's story as markdown, and e rewrites it in $EDITOR", async () => {
  const { engine, frame, press, goTo, frameWith } = await boot();
  const task = store.listTasks().find((t) => t.title === "CSV import fails on a BOM")!;
  engine.desk.editStory(task.id, "## Pinned by the owner\n- story-pin-0241\n## Next steps\n- story-next-0241\n- second step");
  await goTo("CSV import");
  await press("V");
  const shown = await frameWith("story-next-0241");
  if (process.env.READER_FRAMES) writeFileSync(process.env.READER_FRAMES, `${shown}\n`);
  expect(shown).toContain(`${store.taskRef(task.id)} story`);
  // Rendered, not raw: the headings lose their hashes.
  expect(shown).toContain("Pinned by the owner");
  expect(shown).not.toContain("## Pinned");
  expect(shown).toContain("story-pin-0241");
  expect(shown).toContain("c copy · e edit · esc");

  // An editor that adds a line under Next steps and saves.
  const script = join(home!, "fake-editor.sh");
  writeFileSync(script, `#!/bin/sh\nperl -0pi -e 's/- second step/- second step\\n- edited-in-editor-0241/' "$1"\n`);
  chmodSync(script, 0o755);
  delete process.env.VISUAL;
  process.env.EDITOR = script;
  await press("e");
  const end = Date.now() + 5000;
  while (!store.currentStory(task.id)?.next.includes("edited-in-editor-0241") && Date.now() < end) await Bun.sleep(30);
  const cur = store.currentStory(task.id)!;
  expect(cur.by).toBe("owner");
  expect(cur.next).toBe("story-next-0241\nsecond step\nedited-in-editor-0241");
  expect(cur.pinned).toBe("story-pin-0241");
  expect(frame()).not.toContain("c copy · e edit · esc");
});

test("V on a project reads its journal as markdown, markers left out", async () => {
  const { frame, press, goTo, frameWith } = await boot();
  const project = store.listProjects().find((p) => p.name === "ledger fixes")!;
  writeJournal(project, "2026-11-24 10:00  RIKER-0001  journal-entry-0241  (agent)\nOutcome: ready for review\n\nDid:\n- wrote the reader", new Date().toISOString());
  await goTo("ledger fixes");
  expect(frame()).toContain("Project · ledger fixes");
  await press("V");
  const shown = await frameWith("journal-entry-0241");
  if (process.env.READER_FRAMES) writeFileSync(`${process.env.READER_FRAMES}.journal`, `${shown}\n`);
  expect(shown).toContain("ledger fixes journal");
  expect(shown).toContain("wrote the reader");
  expect(shown).not.toContain("riker:journal");
  expect(shown).not.toContain("### ");
  await press("ESCAPE");
  expect(frame()).not.toContain("journal-entry-0241");
});

test("e on the journal edits a copy; an entry Riker wrote meanwhile is kept", async () => {
  const { frame, press, goTo, frameWith } = await boot();
  const project = store.listProjects().find((p) => p.name === "ledger fixes")!;
  const file = writeJournal(project, "2026-11-24 10:00  RIKER-0001  made  (first)", new Date().toISOString());
  // The editor adds a note at the end of its copy, and while it is open an
  // entry lands in the file (what the engine does).
  const script = join(home!, "fake-editor.sh");
  writeFileSync(
    script,
    `#!/bin/sh\nprintf '\\nowner-note-0241\\n' >> "$1"\nperl -0pi -e 's/(<!-- riker:journal -->\\n)/$1<!-- riker:entry 2026-11 -->\\nengine-entry-0241\\n\\n/' "${file}"\n`,
  );
  chmodSync(script, 0o755);
  delete process.env.VISUAL;
  process.env.EDITOR = script;
  await goTo("ledger fixes");
  await press("V");
  await frameWith("ledger fixes journal");
  await press("e");
  const end = Date.now() + 5000;
  while (!readFileSync(file, "utf8").includes("owner-note-0241") && Date.now() < end) await Bun.sleep(30);
  const now = readFileSync(file, "utf8");
  expect(now).toContain("owner-note-0241");
  expect(now).toContain("engine-entry-0241");
  expect(now).toContain("(first)");
  const toast = (await frameWith("Riker wrote")).replace(/\s+/g, " ");
  if (process.env.READER_FRAMES) writeFileSync(`${process.env.READER_FRAMES}.merge`, `${frame()}\n`);
  expect(toast).toContain("Riker wrote");
});

test("V with no story yet says when one comes", async () => {
  const { press, goTo, frameWith } = await boot();
  await goTo("CSV import");
  await press("V");
  expect(await frameWith("No story")).toContain("e starts one in $EDITOR");
});
