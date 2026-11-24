// RIKER-0195: ctrl+[ goes back from anywhere (the rail, the Canvas, the chat
// box, a dialog, the Board, an attached agent: detach first), and ctrl+a goes
// to the Assistant from anywhere. ctrl+[ is the Esc byte unless the terminal
// speaks the kitty protocol to Riker; tmux folds it into Esc, so there it
// stays Esc, and an attached agent still gets it.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  if (home) rmSync(home, { recursive: true, force: true });
});

const CSV = "CSV import fails on a BOM";
const BADGE = "Badge printer quote from Marcus";

// A stand-in agent: says it is up, then logs each byte it gets, in octal
// (033 is Esc and ctrl+[, 001 ctrl+a), to a file that outlives its viewer.
const agent = (log: string) => [
  "sh",
  "-c",
  `stty -icanon -echo min 1; echo agent-up; while true; do dd bs=1 count=1 2>/dev/null | od -An -c | tr -d ' \\n' >> ${log}; echo >> ${log}; done`,
];

async function boot(kitty: boolean) {
  home = mkdtempSync(join(tmpdir(), "riker-back-"));
  process.env.RIKER_HOME = home;
  const log = join(home, "agent-bytes");
  const engine = installFixture("demo");
  const csv = store.listTasks().find((t) => t.title === CSV);
  if (!csv) throw new Error("demo has no CSV task");
  const isLive = engine.desk.isLive.bind(engine.desk);
  engine.desk.isLive = (t) => t.id === csv.id || isLive(t);
  engine.desk.viewer = async () => ({ argv: agent(log) });

  const setup = await testRender(() => <App engine={engine} />, {
    width: 160,
    height: 45,
    kittyKeyboard: kitty,
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
  const goTo = async (words: string) => {
    await press("\\", { ctrl: true });
    await type(words);
    await press("RETURN");
  };
  const bytes = () => {
    try {
      return readFileSync(log, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  // What the Canvas shows: its header line names the selected row.
  const canvasHead = () => {
    const line = frame().split("\n")[2] ?? "";
    return line.slice(48);
  };
  const shows = (title: string) => canvasHead().includes(title);
  const onHome = () => canvasHead().includes("Home · the Assistant");
  // The rail's footer leads with its filter key; the Canvas's never does.
  const onRail = () => /f filter · /.test(frame());
  const attach = async () => {
    await goTo("CSV import");
    expect(await until(() => frame().includes("agent-up"))).toBe(true);
    await press("TAB");
    expect(await until(() => frame().includes("[attached]"))).toBe(true);
  };
  return {
    press,
    type,
    frame,
    until,
    goTo,
    bytes,
    shows,
    onHome,
    onRail,
    attach,
  };
}

// The history: Home at start, then the task gone to.
test("kitty: ctrl+[ from the rail goes back", async () => {
  const s = await boot(true);
  await s.goTo("Badge printer");
  expect(s.shows(BADGE)).toBe(true);
  await s.press("[", { ctrl: true });
  expect(s.onHome()).toBe(true);
  expect(s.onRail()).toBe(true);
});

test("kitty: ctrl+[ from the Canvas goes back and lands on the rail", async () => {
  const s = await boot(true);
  await s.goTo("Badge printer");
  await s.press("TAB");
  expect(s.onRail()).toBe(false);
  await s.press("[", { ctrl: true });
  expect(s.onHome()).toBe(true);
  expect(s.onRail()).toBe(true);
});

test("kitty: ctrl+[ from the chat box leaves it (draft kept) and goes back", async () => {
  const s = await boot(true);
  await s.goTo("Badge printer");
  await s.press("i");
  await s.type("half a thought");
  expect(s.frame()).toContain("half a thought");
  await s.press("[", { ctrl: true });
  expect(s.onHome()).toBe(true);
  expect(s.onRail()).toBe(true);
  // The draft stays with its task, not in Home's box.
  expect(s.frame()).not.toContain("half a thought");
  // Forward again: the draft is there, and no "[" was typed into it.
  await s.press("]");
  expect(s.shows(BADGE)).toBe(true);
  expect(s.frame()).toContain("half a thought");
  expect(s.frame()).not.toContain("half a thought[");
});

for (const [name, key, mods, open] of [
  ["help", "?", undefined, "The rail"],
  ["the palette", ":", undefined, "Commands ·"],
  ["go to", "\\", { ctrl: true }, "recent"],
] as const) {
  test(`kitty: ctrl+[ from a dialog (${name}) closes it and goes back`, async () => {
    const s = await boot(true);
    await s.goTo("Badge printer");
    await s.press(key, mods);
    expect(s.frame()).toContain(open);
    await s.press("[", { ctrl: true });
    expect(s.frame()).not.toContain(open);
    expect(s.onHome()).toBe(true);
    expect(s.onRail()).toBe(true);
  });
}

test("kitty: ctrl+[ from the Board goes back to Chat", async () => {
  const s = await boot(true);
  await s.goTo("Badge printer");
  await s.press("v");
  expect(s.frame()).toContain("chat | board");
  expect(s.frame()).not.toContain("Tell the agent");
  await s.press("[", { ctrl: true });
  expect(s.shows(BADGE)).toBe(true);
});

test("kitty: ctrl+[ on an attached agent detaches, then goes back; Esc still reaches the agent", async () => {
  const s = await boot(true);
  await s.attach();
  await s.press("ESCAPE");
  await s.type("z");
  expect(await s.until(() => s.bytes().includes("z"))).toBe(true);
  expect(s.bytes()).toEqual(["033", "z"]);
  await s.press("[", { ctrl: true });
  expect(s.frame()).not.toContain("[attached]");
  expect(s.onHome()).toBe(true);
  expect(s.onRail()).toBe(true);
  await Bun.sleep(100);
  expect(s.bytes()).toEqual(["033", "z"]);
});

test("ctrl+a goes to the Assistant from the chat box, ready to type", async () => {
  const s = await boot(true);
  await s.goTo("Badge printer");
  await s.press("i");
  await s.type("abc");
  await s.press("a", { ctrl: true });
  expect(s.onHome()).toBe(true);
  // The Assistant's box has focus, and the other task's draft is not in it:
  // enter would send it to the Assistant.
  await s.type("hello riker");
  expect(s.frame()).toContain("hello riker");
  expect(s.frame()).not.toContain("abc");
  // Back on the task, its draft is as it was.
  await s.press("[", { ctrl: true });
  expect(s.shows(BADGE)).toBe(true);
  expect(s.frame()).toContain("abc");
  expect(s.frame()).not.toContain("hello riker");
});

test("ctrl+a from a dialog closes it and goes to the Assistant", async () => {
  const s = await boot(true);
  await s.goTo("Badge printer");
  await s.press(":");
  expect(s.frame()).toContain("Commands ·");
  await s.press("a", { ctrl: true });
  expect(s.frame()).not.toContain("Commands ·");
  expect(s.onHome()).toBe(true);
});

for (const kitty of [true, false]) {
  test(`${kitty ? "kitty" : "legacy"}: ctrl+a on an attached agent detaches and goes to the Assistant`, async () => {
    const s = await boot(kitty);
    await s.attach();
    await s.type("z");
    expect(await s.until(() => s.bytes().includes("z"))).toBe(true);
    await s.press("a", { ctrl: true });
    expect(s.frame()).not.toContain("[attached]");
    expect(s.onHome()).toBe(true);
    await Bun.sleep(100);
    expect(s.bytes()).toEqual(["z"]);
  });
}

// Without the kitty protocol (and always inside tmux) ctrl+[ is the Esc byte:
// Riker cannot tell them apart, so it does what Esc does.
test("legacy: ctrl+[ is Esc, so an attached agent gets it and you stay attached", async () => {
  const s = await boot(false);
  await s.attach();
  await s.press("[", { ctrl: true });
  expect(await s.until(() => s.bytes().includes("033"))).toBe(true);
  expect(s.frame()).toContain("[attached]");
  expect(s.shows(CSV)).toBe(true);
});

test("legacy: ctrl+[ is Esc, so the chat box is left but nothing goes back", async () => {
  const s = await boot(false);
  await s.goTo("Badge printer");
  await s.press("i");
  await s.press("[", { ctrl: true });
  expect(s.shows(BADGE)).toBe(true);
});

// RIKER-0223: ctrl+o is back from anywhere as well, and unlike ctrl+[ it
// gets through tmux and a legacy terminal, so it works in both.
for (const kitty of [true, false]) {
  const t = kitty ? "kitty" : "legacy";

  test(`${t}: ctrl+o from the rail goes back`, async () => {
    const s = await boot(kitty);
    await s.goTo("Badge printer");
    expect(s.shows(BADGE)).toBe(true);
    await s.press("o", { ctrl: true });
    expect(s.onHome()).toBe(true);
    expect(s.onRail()).toBe(true);
  });

  test(`${t}: ctrl+o from the chat box leaves it (draft kept) and goes back`, async () => {
    const s = await boot(kitty);
    await s.goTo("Badge printer");
    await s.press("i");
    await s.type("half a thought");
    await s.press("o", { ctrl: true });
    expect(s.onHome()).toBe(true);
    expect(s.onRail()).toBe(true);
    expect(s.frame()).not.toContain("half a thought");
    await s.press("]");
    expect(s.shows(BADGE)).toBe(true);
    expect(s.frame()).toContain("half a thought");
    expect(s.frame()).not.toContain("half a thoughto");
  });

  test(`${t}: ctrl+o from a dialog closes it and goes back`, async () => {
    const s = await boot(kitty);
    await s.goTo("Badge printer");
    await s.press(":");
    expect(s.frame()).toContain("Commands ·");
    await s.press("o", { ctrl: true });
    expect(s.frame()).not.toContain("Commands ·");
    expect(s.onHome()).toBe(true);
  });

  test(`${t}: ctrl+o from the Board goes back to Chat`, async () => {
    const s = await boot(kitty);
    await s.goTo("Badge printer");
    await s.press("v");
    expect(s.frame()).not.toContain("Tell the agent");
    await s.press("o", { ctrl: true });
    expect(s.shows(BADGE)).toBe(true);
  });

  test(`${t}: ctrl+o on an attached agent detaches and goes back; the agent never sees it`, async () => {
    const s = await boot(kitty);
    await s.attach();
    await s.type("z");
    expect(await s.until(() => s.bytes().includes("z"))).toBe(true);
    await s.press("o", { ctrl: true });
    expect(s.frame()).not.toContain("[attached]");
    expect(s.onHome()).toBe(true);
    expect(s.onRail()).toBe(true);
    await Bun.sleep(100);
    expect(s.bytes()).toEqual(["z"]);
  });
}
