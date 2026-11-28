// The mouse through the real App: a click does what moving there and
// pressing the key would. Clicks land where the frame shows the words.

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { App } from "../src/app";
import { boardTab } from "../src/components/board-tab";
import { BoardTab } from "../src/keymap";
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

const CSV = "CSV import fails on a BOM";

// A stand-in agent on the CSV task: asks for clicks (1000, SGR) unless told
// not to, says it is up, then keeps every byte it gets.
async function boot(opts: { agentMouse?: boolean; drags?: boolean } = {}) {
  home = mkdtempSync(join(tmpdir(), "riker-mouse-"));
  process.env.RIKER_HOME = home;
  const log = join(home, "agent-bytes");
  const engine = installFixture("demo");
  const csv = store.listTasks().find((t) => t.title === CSV);
  if (!csv) {
    throw new Error("demo has no CSV task");
  }
  const isLive = engine.desk.isLive.bind(engine.desk);
  engine.desk.isLive = (t) => t.id === csv.id || isLive(t);
  const modes =
    opts.agentMouse === false
      ? ""
      : `\\033[?${opts.drags ? 1002 : 1000}h\\033[?1006h`;
  engine.desk.viewer = async () => ({
    argv: [
      "sh",
      "-c",
      `stty -icanon -echo min 1; printf '${modes}'; echo agent-up; exec cat > ${log}`,
    ],
  });
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
  const lines = () => frame().split("\n");
  // Where the frame shows these words; the first match, left to right
  // within the columns given.
  const at = (words: string, from = 0, to = Infinity) => {
    const rows = lines();
    for (let y = 0; y < rows.length; y++) {
      const x = rows[y].indexOf(words, from);
      if (x >= 0 && x < to) {
        return { x, y };
      }
    }
    throw new Error(`"${words}" is not on screen:\n${frame()}`);
  };
  const click = async (words: string, from = 0, to = Infinity) => {
    const { x, y } = at(words, from, to);
    await setup.mockMouse.click(x + 1, y);
    await settle();
  };
  const press = async (key: string) => {
    setup.mockInput.pressKey(key);
    await settle();
  };
  const line = (words: string, from = 0, to = Infinity) =>
    lines()[at(words, from, to).y];
  const onRail = () => /f filter · /.test(frame());
  const until = async (ok: () => boolean) => {
    const end = Date.now() + 3000;
    while (!ok() && Date.now() < end) {
      await settle(20);
    }
    return ok();
  };
  const bytes = () => {
    try {
      return readFileSync(log, "utf8");
    } catch {
      return "";
    }
  };
  const showAgent = async () => {
    setup.mockInput.pressKey("\\", { ctrl: true });
    await settle();
    for (const c of "CSV import") {
      setup.mockInput.pressKey(c);
    }
    await settle();
    await press("RETURN");
    expect(await until(() => frame().includes("agent-up"))).toBe(true);
  };
  return {
    frame,
    line,
    click,
    press,
    onRail,
    settle,
    setup,
    engine,
    until,
    bytes,
    showAgent,
  };
}

const RAIL = 46;

test("a click on a rail row selects it and focuses the rail", async () => {
  const s = await boot();
  expect(s.line("Bump pydantic", 0, RAIL)).not.toContain("▸");
  await s.click("Bump pydantic", 0, RAIL);
  expect(s.line("Bump pydantic", 0, RAIL)).toContain("▸");
  expect(s.onRail()).toBe(true);
  // The Canvas shows it: its title is in the header too.
  expect(s.frame().split("Bump pydantic").length - 1).toBe(2);
});

test("a click on a row's second line selects it too", async () => {
  const s = await boot();
  await s.click("merged, ready to close", 0, RAIL);
  expect(s.line("Bump pydantic", 0, RAIL)).toContain("▸");
});

test("a click on the Canvas focuses it, then one on the rail comes back", async () => {
  const s = await boot();
  await s.click("Home · the Assistant", RAIL);
  expect(s.onRail()).toBe(false);
  await s.click("Rotate staging certs", 0, RAIL);
  expect(s.onRail()).toBe(true);
  expect(s.line("Rotate staging certs", 0, RAIL)).toContain("▸");
});

test("a click on a filter pill toggles it", async () => {
  const s = await boot();
  const pills = s.line("◈ 2");
  await s.click("◈ 2", 0, RAIL);
  expect(s.frame()).toContain("· 0 all");
  await s.click("◈ 2", 0, RAIL);
  expect(s.frame()).not.toContain("· 0 all");
  expect(s.line("◈ 2")).toBe(pills);
});

test("a click on chat | board switches the view, and back", async () => {
  const s = await boot();
  await s.click("chat | board");
  expect(s.frame()).toContain("Agent board");
  await s.click("chat | board");
  expect(s.frame()).not.toContain("Agent board");
  expect(s.frame()).toContain("Home · the Assistant");
});

test("a click on a Board tab switches to it", async () => {
  const s = await boot();
  await s.press("v");
  expect(s.frame()).toContain("Agent board");
  await s.click("5 Cost");
  expect(boardTab()).toBe(BoardTab.cost);
  await s.click("4 Inbox");
  expect(boardTab()).toBe(BoardTab.inbox);
});

const ctrl = { ctrl: true };

test("Inbox: a click moves the cursor, a second click opens the row", async () => {
  const s = await boot();
  await s.press("v");
  await s.press("4");
  const after = (words: string) => {
    const rows = s.frame().split("\n");
    const i = rows.findIndex((r) => r.includes(words));
    return rows[i + 1];
  };
  expect(after("Gail Moreno")).toContain("Sam Delgado");
  await s.click("Gail Moreno");
  expect(after("Gail Moreno")).toContain("Sam Delgado");
  await s.click("Gail Moreno");
  expect(after("Gail Moreno")).not.toContain("Sam Delgado");
  await s.click("Gail Moreno");
  expect(after("Gail Moreno")).toContain("Sam Delgado");
});

test("Inbox: a click on a filter pill filters by it", async () => {
  const s = await boot();
  await s.press("v");
  await s.press("4");
  expect(s.frame()).toContain("Ruth Okafor");
  await s.click("FYI 3");
  expect(s.frame()).not.toContain("Ruth Okafor");
  expect(s.frame()).toContain("Gail Moreno");
});

test("Columns: a click on a card puts the cursor on it", async () => {
  const s = await boot();
  await s.press("v");
  await s.press("2");
  expect(s.frame()).toContain("agent idle (2)");
  await s.click("Retry webhook");
  expect(s.frame()).toContain("agent idle (2/2)");
});

test("Knowledge: a click on an entry shows it", async () => {
  const s = await boot();
  await s.press("v");
  await s.press("3");
  const title = () => s.frame().split("\n")[3];
  expect(title()).toContain("Bank CSVs carry a UTF-8 BOM");
  await s.click("Inter-company transfers");
  expect(title()).not.toContain("Bank CSVs carry a UTF-8 BOM");
  expect(title()).toContain("Inter-company");
});

test("Go to: a click on a row opens it", async () => {
  const s = await boot();
  s.setup.mockInput.pressKey("\\", ctrl);
  await s.settle();
  expect(s.frame()).toContain("Go to");
  await s.click("RIKER-0008 Rotate staging certs");
  expect(s.frame()).not.toContain("Go to");
  expect(s.line("Rotate staging certs", 0, RAIL)).toContain("▸");
});

test("a click on a detached agent attaches it and goes no further", async () => {
  const s = await boot();
  await s.showAgent();
  expect(s.frame()).not.toContain("[attached]");
  await s.click("agent-up");
  expect(await s.until(() => s.frame().includes("[attached]"))).toBe(true);
  await Bun.sleep(200);
  expect(s.bytes()).toBe("");
});

test("attached, a click goes to the agent as SGR at its cell", async () => {
  const s = await boot();
  await s.showAgent();
  await s.click("agent-up");
  expect(await s.until(() => s.frame().includes("[attached]"))).toBe(true);
  // The second letter of the first line: column 2, row 1.
  await s.click("agent-up");
  expect(await s.until(() => s.bytes().length > 0)).toBe(true);
  await s.until(() => s.bytes().includes("m"));
  expect(s.bytes()).toBe("\x1b[<0;2;1M\x1b[<0;2;1m");
  expect(s.frame()).toContain("[attached]");
});

test("attached, an agent that asked for no clicks gets none", async () => {
  const s = await boot({ agentMouse: false });
  await s.showAgent();
  await s.click("agent-up");
  expect(await s.until(() => s.frame().includes("[attached]"))).toBe(true);
  await s.click("agent-up");
  await Bun.sleep(200);
  expect(s.bytes()).toBe("");
});

test("a click on the rail from an attached agent detaches", async () => {
  const s = await boot();
  await s.showAgent();
  await s.click("agent-up");
  expect(await s.until(() => s.frame().includes("[attached]"))).toBe(true);
  await s.click("Bump pydantic", 0, RAIL);
  expect(s.onRail()).toBe(true);
  expect(s.line("Bump pydantic", 0, RAIL)).toContain("▸");
  expect(s.bytes()).toBe("");
});

test("attached, a drag under 1002 goes in as press, motion, release", async () => {
  const s = await boot({ drags: true });
  await s.showAgent();
  await s.click("agent-up");
  expect(await s.until(() => s.frame().includes("[attached]"))).toBe(true);
  const rows = s.frame().split("\n");
  const y = rows.findIndex((r) => r.includes("agent-up"));
  const x = rows[y].indexOf("agent-up");
  await s.setup.mockMouse.drag(x, y, x + 3, y);
  await s.settle();
  expect(await s.until(() => s.bytes().endsWith("m"))).toBe(true);
  const got = s.bytes();
  expect(got.startsWith("\x1b[<0;1;1M")).toBe(true);
  expect(got).toContain("\x1b[<32;4;1M");
  expect(got.endsWith("\x1b[<0;4;1m")).toBe(true);
});
