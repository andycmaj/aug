import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorBoundary } from "solid-js";
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

// The rail reuses its rows by position. A write that adds a section above a
// row turns that slot from a task row into a heading, and the row must go
// without reading the item it no longer has ("Stale read from <Match>").
test("the rail survives a write that turns a task row into a heading", async () => {
  home = mkdtempSync(join(tmpdir(), "riker-rail-render-"));
  process.env.RIKER_HOME = home;
  const engine = installFixture("demo");
  const errors: unknown[] = [];
  const setup = await testRender(
    () => (
      <ErrorBoundary
        fallback={(err: unknown) => {
          errors.push(err);
          return <text>crashed</text>;
        }}
      >
        <App engine={engine} />
      </ErrorBoundary>
    ),
    { width: 140, height: 45 },
  );
  destroy = () => setup.renderer.destroy();
  await setup.renderOnce();

  // Each write redraws once its burst is over (riker.tsx coalesces bumps).
  const settle = async () => {
    await Bun.sleep(40);
    await setup.renderOnce();
  };
  store.updateTask(6, { status: "later" });
  await settle();
  store.createTask({ title: "new", kind: "general", channel: "github" });
  await settle();

  expect(errors.map(String)).toEqual([]);
});

// One header over the rail: the filter pills. A second row repeating the
// pills' counts said the same thing twice. The inbox badge (✉ and its count)
// is not work on the rail, so it sits at the foot's right end, beside the
// connections.
test("the rail's only header is the filter pills; the inbox badge is at its foot", async () => {
  home = mkdtempSync(join(tmpdir(), "riker-rail-render-"));
  process.env.RIKER_HOME = home;
  const engine = installFixture("demo");
  const setup = await testRender(() => <App engine={engine} />, {
    width: 140,
    height: 45,
  });
  destroy = () => setup.renderer.destroy();
  await setup.renderOnce();
  await Bun.sleep(40);
  await setup.renderOnce();

  const lines = setup.captureCharFrame().split("\n");
  const rail = lines.map((l) => l.slice(0, 46));
  const pills = rail.findIndex((l) => /◆ \d/.test(l));
  expect(pills).toBeGreaterThanOrEqual(0);
  expect(rail[pills]).not.toContain("✉");
  expect(rail.filter((l) => /◆ \d/.test(l))).toHaveLength(1);
  const foot = rail.findIndex((l) => /○ github/.test(l));
  expect(foot).toBeGreaterThan(pills);
  expect(rail[foot].trimEnd()).toMatch(/○ slack\s+✉ \d+$/);
  expect(rail[foot].trimEnd().length).toBeGreaterThan(40);
  const above = rail.slice(0, pills).join("");
  expect(above).not.toMatch(/\d+ open/);
  expect(above).not.toContain("Work");
});

// The rail is narrow and a sub line is cut at its end. What the row's lane
// says is what the owner acts on, so it comes before the ref, and a ref that
// does not fit is left off (the Canvas header shows it once selected).
test("a cut sub line keeps the lane's word and drops the ref whole", async () => {
  home = mkdtempSync(join(tmpdir(), "riker-rail-render-"));
  process.env.RIKER_HOME = home;
  const engine = installFixture("demo");
  const setup = await testRender(() => <App engine={engine} />, {
    width: 140,
    height: 45,
  });
  destroy = () => setup.renderer.destroy();
  await setup.renderOnce();
  await Bun.sleep(40);
  await setup.renderOnce();

  const lines = setup.captureCharFrame().split("\n");
  const sub = (title: string) => {
    const at = lines.findIndex((l) => l.includes(title));
    return lines[at + 1].slice(0, 46);
  };
  // A row with a PR chip, and one without.
  expect(sub("CSV import fails on a BOM")).toContain("ready to send");
  expect(sub("Bump pydantic to 2.9")).toContain("merged, ready to close");
  // A ref shows whole or not at all.
  const rail = lines.map((l) => l.slice(0, 46)).join("\n");
  expect(rail).not.toMatch(/· R[A-Z-]*\d*…/);
  expect(sub("Rotate staging certs")).toContain("watching · RIKER-0008");
});

async function demoRail() {
  home = mkdtempSync(join(tmpdir(), "riker-rail-render-"));
  process.env.RIKER_HOME = home;
  const engine = installFixture("demo");
  const setup = await testRender(() => <App engine={engine} />, {
    width: 140,
    height: 45,
  });
  destroy = () => setup.renderer.destroy();
  const settle = async () => {
    await Bun.sleep(40);
    await setup.renderOnce();
  };
  await setup.renderOnce();
  await settle();
  const rail = () =>
    setup
      .captureCharFrame()
      .split("\n")
      .map((l) => l.slice(0, 46));
  const press = async (key: string) => {
    setup.mockInput.pressKey(key);
    await settle();
  };
  return { rail, press, settle };
}

// A lit pill is a mark and a count; the line under the pills says in words
// what the rail is showing, and how to show everything again.
test("a filter names what it shows, under the pills, until 0 clears it", async () => {
  const { rail, press } = await demoRail();
  expect(rail().join("\n")).not.toContain("0 all");
  await press("1");
  const lines = rail();
  const pills = lines.findIndex((l) => /◆ \d/.test(l));
  const named = lines.findIndex((l) => l.includes("0 all"));
  expect(named).toBeGreaterThan(pills);
  expect(lines[named]).toContain("agent waiting on you");
  expect(lines[named]).not.toContain("f next");
  await press("0");
  expect(rail().join("\n")).not.toContain("0 all");
});

// A mark beside the title says priority without color.
test("an urgent or important row carries a priority mark beside its title", async () => {
  const { rail, settle } = await demoRail();
  store.updateTask(8, { priority: "important" });
  await settle();
  const title = (t: string) => rail().find((l) => l.includes(t)) ?? "";
  expect(title("September overtime by site")).toMatch(/◆ !! September/);
  expect(title("Rotate staging certs")).toMatch(/○ ! Rotate staging certs/);
  expect(title("Bump pydantic to 2.9")).not.toContain("!");
});
