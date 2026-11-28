// jk or kj typed fast in the chat box or on an attached agent
// goes back to the rail. The box keeps a lone j or k as typed and takes the
// chord's letter back out; the agent never sees a chord, and gets a lone
// letter once it times out. ctrl+] leaves the box for the rail, as it
// detaches from an agent. Pressed through the real App.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { App } from "../src/app";
import { installFixture } from "@riker/fixtures/demo";
import * as store from "@riker/core/store";
import type { KeysConfig } from "@riker/core/config";

let destroy: (() => void) | undefined;
let home: string | undefined;
afterEach(() => {
  destroy?.();
  if (home) {
    rmSync(home, { recursive: true, force: true });
  }
});

const CSV = "CSV import fails on a BOM";

// A stand-in agent: says it is up, then logs each byte it gets.
const agent = (log: string) => [
  "sh",
  "-c",
  `stty -icanon -echo min 1; echo agent-up; while true; do dd bs=1 count=1 2>/dev/null | od -An -c | tr -d ' \\n' >> ${log}; echo >> ${log}; done`,
];

async function boot(keys?: KeysConfig) {
  home = mkdtempSync(join(tmpdir(), "riker-chord-"));
  process.env.RIKER_HOME = home;
  const log = join(home, "agent-bytes");
  const engine = installFixture("demo");
  const csv = store.listTasks().find((t) => t.title === CSV);
  if (!csv) {
    throw new Error("demo has no CSV task");
  }
  const isLive = engine.desk.isLive.bind(engine.desk);
  engine.desk.isLive = (t) => t.id === csv.id || isLive(t);
  engine.desk.viewer = async () => ({ argv: agent(log) });
  if (keys) {
    const config = engine.desk.config.bind(engine.desk);
    engine.desk.config = () => ({ ...config(), keys });
  }

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
  // All at once: well inside the chord's time.
  const type = async (text: string) => {
    for (const c of text) {
      setup.mockInput.pressKey(c);
    }
    await settle();
  };
  const until = async (ok: () => boolean) => {
    const end = Date.now() + 3000;
    while (!ok() && Date.now() < end) {
      await settle(20);
    }
    return ok();
  };
  const bytes = () => {
    try {
      return readFileSync(log, "utf8").split("\n").filter(Boolean);
    } catch {
      return [];
    }
  };
  const onRail = () => /f filter · /.test(frame());
  const goTo = async (words: string) => {
    await press("\\", { ctrl: true });
    await type(words);
    await press("RETURN");
  };
  // Drafts outlive a test (kept per task in the module), so each test
  // types a word of its own.
  const intoBox = async (word: string) => {
    await goTo("Badge printer");
    await press("i");
    await type(word);
    expect(frame()).toContain(word);
    expect(onRail()).toBe(false);
  };
  const attach = async () => {
    await goTo("CSV import");
    expect(await until(() => frame().includes("agent-up"))).toBe(true);
    await press("TAB");
    expect(await until(() => frame().includes("[attached]"))).toBe(true);
  };
  return { press, type, frame, until, bytes, onRail, intoBox, attach };
}

for (const chord of ["jk", "kj"]) {
  test(`${chord} in the chat box goes to the rail and types nothing`, async () => {
    const s = await boot();
    await s.intoBox("plumtree");
    await s.type(chord);
    expect(s.onRail()).toBe(true);
    expect(s.frame()).toContain("plumtree");
    expect(s.frame()).not.toContain(`plumtree${chord[0]}`);
  });
}

test("a lone j in the chat box is typed and you stay in the box", async () => {
  const s = await boot();
  await s.intoBox("peartree");
  await s.type("j");
  expect(s.frame()).toContain("peartreej");
  await Bun.sleep(250);
  await s.type("k");
  expect(s.onRail()).toBe(false);
  expect(s.frame()).toContain("peartreejk");
});

test("ctrl+] in the chat box goes to the rail, draft kept", async () => {
  const s = await boot();
  await s.intoBox("figtree");
  await s.press("]", { ctrl: true });
  expect(s.onRail()).toBe(true);
  expect(s.frame()).toContain("figtree");
  expect(s.frame()).not.toContain("figtree]");
});

test("jk in a dialog over the chat box (go to) is typed there", async () => {
  const s = await boot();
  await s.intoBox("limetree");
  await s.press("\\", { ctrl: true });
  await s.type("jk");
  expect(s.frame()).toContain("jk");
  expect(s.frame()).toContain("Go to");
  await s.press("ESCAPE");
  expect(s.frame()).toContain("limetree");
  expect(s.frame()).not.toContain("limetreej");
});

test("chord off in config: jk is just typed", async () => {
  const s = await boot({ railChord: [] });
  await s.intoBox("datetree");
  await s.type("jk");
  expect(s.onRail()).toBe(false);
  expect(s.frame()).toContain("datetreejk");
});

for (const chord of ["jk", "kj"]) {
  test(`${chord} on an attached agent detaches to the rail; the agent sees nothing`, async () => {
    const s = await boot();
    await s.attach();
    await s.type(chord);
    expect(s.frame()).not.toContain("[attached]");
    expect(s.onRail()).toBe(true);
    await Bun.sleep(300);
    expect(s.bytes()).toEqual([]);
  });
}

test("a lone j on an attached agent reaches it after the chord times out", async () => {
  const s = await boot();
  await s.attach();
  await s.type("j");
  expect(await s.until(() => s.bytes().includes("j"))).toBe(true);
  expect(s.frame()).toContain("[attached]");
});

test("j then another letter reaches the agent in order, at once", async () => {
  const s = await boot();
  await s.attach();
  await s.type("jx");
  expect(await s.until(() => s.bytes().length === 2)).toBe(true);
  expect(s.bytes()).toEqual(["j", "x"]);
  expect(s.frame()).toContain("[attached]");
});
