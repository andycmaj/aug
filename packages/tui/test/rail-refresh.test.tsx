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

// The demo's "September overtime" (task 5) is a general task whose agent
// waits on you; nothing selects it at start.
const ID = 5;
const TITLE = "September overtime";

async function boot() {
  home = mkdtempSync(join(tmpdir(), "riker-rail-refresh-"));
  process.env.RIKER_HOME = home;
  const engine = installFixture("demo");
  const setup = await testRender(() => <App engine={engine} />, {
    width: 140,
    height: 45,
  });
  destroy = () => setup.renderer.destroy();
  // Writes redraw once their burst is over (riker.tsx coalesces bumps); a
  // write from another process is seen on the 400ms data_version poll.
  const settle = async (ms = 40) => {
    await Bun.sleep(ms);
    await setup.renderOnce();
  };
  await settle();
  // The row's two lines, rail column only.
  const row = () => {
    const lines = setup
      .captureCharFrame()
      .split("\n")
      .map((l) => l.slice(0, 46));
    const at = lines.findIndex((l) => l.includes(TITLE));
    return lines.slice(at, at + 2);
  };
  return { setup, settle, row };
}

test("a row's lane follows writes from this process and from another", async () => {
  const { settle, row } = await boot();
  expect(row()[0]).toContain("◆");

  store.updateTask(ID, { agent_state: "idle" });
  await settle();
  expect(row()[0]).toContain("◇");
  expect(row()[1]).toContain("agent idle");

  // As an agent's hook through riker-tools would: its own connection.
  const proc = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      `import { Database } from "bun:sqlite";
       new Database(process.env.RIKER_HOME + "/riker.db")
         .query("UPDATE tasks SET agent_state = 'waiting' WHERE id = ${ID}").run();`,
    ],
    { env: { ...process.env } },
  );
  expect(proc.exitCode).toBe(0);
  await settle(600);
  expect(row()[0]).toContain("◆");
  // The ref leaves too little room for the whole word.
  expect(row()[1]).toContain("agent wait");
});

// The ▸ on the selected row sits beside its lane mark, not over it, so a
// lane move shows on the row you are watching.
test("the selected row keeps its lane mark beside the ▸", async () => {
  const { settle, row, setup } = await boot();
  // Home is selected at start; the cursor walks down to this row.
  for (const key of ["j", "j"]) {
    setup.mockInput.pressKey(key);
    await settle();
  }
  setup.mockInput.pressEnter();
  await settle();
  expect(row()[0]).toContain("▸");
  expect(row()[0]).toContain("◆");

  store.updateTask(ID, { agent_state: "idle" });
  await settle();
  expect(row()[0]).toContain("▸");
  expect(row()[0]).toContain("◇");
});

// Working outranks merged; the word still says it landed.
test("a merged task whose agent still works says merged", async () => {
  const { settle, row } = await boot();
  store.updateTask(ID, {
    agent_state: "working",
    merged_at: new Date().toISOString(),
  });
  await settle();
  expect(row()[1]).toContain("merged, ag");
});
