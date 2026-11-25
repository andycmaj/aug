// RIKER-0117: an error toast stays until Esc dismisses it, the newest first,
// and that Esc does nothing else where focus is (the Canvas, the chat box, a
// dialog). An attached agent still gets Esc; the toast says to detach first.
// Info toasts still go on their own.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRoot } from "solid-js";
import { testRender } from "@opentui/solid";
import { App } from "../src/app";
import { createToasts, MAX_ERRORS } from "../src/context/toast";
import { errorHint } from "../src/components/toast";
import { installFixture } from "@riker/fixtures/demo";
import * as store from "@riker/core/store";

let destroy: (() => void) | undefined;
let home: string | undefined;
afterEach(() => {
  destroy?.();
  destroy = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
});

const toasts = () =>
  createRoot((dispose) => {
    const t = createToasts();
    destroy = () => {
      t.dispose();
      dispose();
    };
    return t;
  });

test("an error outlives its duration; an info toast does not", async () => {
  const t = toasts();
  t.showToast("it broke", 10, "error");
  t.showToast("saved", 10);
  await Bun.sleep(60);
  expect(t.info()).toBeNull();
  expect(t.errors().map((e) => e.message)).toEqual(["it broke"]);
});

test("errors stack; dismiss takes the newest, one at a time", () => {
  const t = toasts();
  t.showToast("first", 4000, "error");
  t.showToast("second", 4000, "error");
  t.showToast("second", 4000, "error");
  expect(t.errors().map((e) => [e.message, e.times])).toEqual([
    ["first", 1],
    ["second", 2],
  ]);
  expect(t.dismissError()).toBe(true);
  expect(t.errors().map((e) => e.message)).toEqual(["first"]);
  expect(t.dismissError()).toBe(true);
  expect(t.dismissError()).toBe(false);
});

test("a flood keeps the newest errors only", () => {
  const t = toasts();
  for (let i = 0; i < MAX_ERRORS + 5; i++) t.showToast(`e${i}`, 0, "error");
  expect(t.errors()).toHaveLength(MAX_ERRORS);
  expect(t.errors().at(-1)?.message).toBe(`e${MAX_ERRORS + 4}`);
});

test("the hint names the key, the repeats and what waits under it", () => {
  const e = { id: 1, message: "x", times: 1 };
  expect(errorHint(e, 0, false)).toBe("esc dismiss");
  expect(errorHint({ ...e, times: 3 }, 2, false)).toBe("×3 · esc dismiss · 2 more");
  expect(errorHint(e, 0, true)).toBe("ctrl+] then esc dismiss");
});

// The real app. ctrl+z with nothing to undo raises an error toast.
const CSV = "CSV import fails on a BOM";
const NOTHING = "Nothing to undo";

// A stand-in agent: says it is up, then logs each byte it gets, in octal
// (033 is Esc).
const agent = (log: string) => [
  "sh",
  "-c",
  `stty -icanon -echo min 1; echo agent-up; while true; do dd bs=1 count=1 2>/dev/null | od -An -c | tr -d ' \\n' >> ${log}; echo >> ${log}; done`,
];

async function boot(opts: { undoSays?: string } = {}) {
  home = mkdtempSync(join(tmpdir(), "riker-toast-"));
  process.env.RIKER_HOME = home;
  const log = join(home, "agent-bytes");
  const engine = installFixture("demo");
  const csv = store.listTasks().find((t) => t.title === CSV);
  if (!csv) throw new Error("demo has no CSV task");
  const isLive = engine.desk.isLive.bind(engine.desk);
  engine.desk.isLive = (t) => t.id === csv.id || isLive(t);
  engine.desk.viewer = async () => ({ argv: agent(log) });
  const said = opts.undoSays;
  if (said) engine.desk.undo = async () => ({ ok: false, text: said });

  const setup = await testRender(() => <App engine={engine} />, {
    width: 160,
    height: 45,
    kittyKeyboard: true,
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
    for (const c of text) setup.mockInput.pressKey(c);
    await settle();
  };
  const until = async (ok: () => boolean) => {
    const end = Date.now() + 3000;
    while (!ok() && Date.now() < end) await settle(20);
    return ok();
  };
  const bytes = () => {
    try {
      return readFileSync(log, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const goTo = async (words: string) => {
    await press("\\", { ctrl: true });
    await type(words);
    await press("RETURN");
  };
  const toastUp = () => frame().includes(opts.undoSays ?? NOTHING);
  const onRail = () => /f filter · /.test(frame());
  const raise = async () => {
    await press("z", { ctrl: true });
    expect(toastUp()).toBe(true);
  };
  return { press, type, frame, until, bytes, goTo, toastUp, onRail, raise };
}

test("on the Canvas, Esc dismisses the error and does not go to the rail", async () => {
  const s = await boot();
  await s.press("TAB");
  expect(s.onRail()).toBe(false);
  await s.raise();
  expect(s.frame()).toContain("esc dismiss");
  // The footer names what Esc does now.
  expect(s.frame()).toMatch(/esc dismiss · /);
  await s.press("ESCAPE");
  expect(s.toastUp()).toBe(false);
  expect(s.onRail()).toBe(false);
  await s.press("ESCAPE");
  expect(s.onRail()).toBe(true);
});

test("the same error again counts on the toast, and one Esc dismisses it", async () => {
  const s = await boot();
  await s.raise();
  await s.press("z", { ctrl: true });
  expect(s.frame()).toContain("×2 · esc dismiss");
  await s.press("ESCAPE");
  expect(s.toastUp()).toBe(false);
});

test("in the chat box, Esc dismisses the error and the box keeps focus", async () => {
  const s = await boot();
  await s.goTo("Badge printer");
  await s.raise();
  await s.press("i");
  await s.press("ESCAPE");
  expect(s.toastUp()).toBe(false);
  await s.type("still typing");
  expect(s.frame()).toContain("still typing");
});

test("over a dialog, Esc dismisses the error first, then closes the dialog", async () => {
  const s = await boot();
  await s.raise();
  await s.press(":");
  expect(s.frame()).toContain("Commands");
  await s.press("ESCAPE");
  expect(s.toastUp()).toBe(false);
  expect(s.frame()).toContain("Commands");
  await s.press("ESCAPE");
  expect(s.frame()).not.toContain("Commands ·");
});

test("an attached agent still gets Esc; detached, Esc dismisses", async () => {
  const s = await boot();
  await s.raise();
  await s.goTo("CSV import");
  expect(await s.until(() => s.frame().includes("agent-up"))).toBe(true);
  await s.press("TAB");
  expect(await s.until(() => s.frame().includes("[attached]"))).toBe(true);
  expect(s.frame()).toContain("ctrl+] then esc dismiss");
  await s.press("ESCAPE");
  expect(await s.until(() => s.bytes().includes("033"))).toBe(true);
  expect(s.toastUp()).toBe(true);
  await s.press("]", { ctrl: true });
  expect(s.frame()).not.toContain("[attached]");
  expect(s.frame()).toContain("esc dismiss");
  await s.press("ESCAPE");
  expect(s.toastUp()).toBe(false);
});

test("a long error wraps onto more lines rather than being cut", async () => {
  const words = "the store refused the write because the disk is full ";
  const long = `${words.repeat(5)}END`;
  const s = await boot({ undoSays: long });
  await s.press("z", { ctrl: true });
  const lines = s.frame().split("\n");
  const first = lines.findIndex((l) => l.includes("the store refused"));
  const last = lines.findIndex((l) => l.includes("END"));
  expect(first).toBeGreaterThan(-1);
  expect(last).toBeGreaterThan(first + 2);
  // Every word made it: nothing between the first line and END was dropped.
  const shown = lines
    .slice(first, last + 1)
    .map((l) => l.replace(/[│┃▏▕]/g, " ").trim())
    .join(" ");
  expect(shown.split("refused").length - 1).toBe(5);
  await s.press("ESCAPE");
  expect(s.frame()).not.toContain("END");
});
