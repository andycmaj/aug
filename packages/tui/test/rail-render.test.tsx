import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorBoundary } from "solid-js";
import { testRender } from "@opentui/solid";
import { App } from "../src/app";
import { installFixture } from "@aug/fixtures/demo";
import * as store from "@aug/core/store";

let destroy: (() => void) | undefined;
let home: string | undefined;
afterEach(() => {
  destroy?.();
  if (home) rmSync(home, { recursive: true, force: true });
});

// The rail reuses its rows by position. A write that adds a section above a
// row turns that slot from a task row into a heading, and the row must go
// without reading the item it no longer has ("Stale read from <Match>").
test("the rail survives a write that turns a task row into a heading", async () => {
  home = mkdtempSync(join(tmpdir(), "aug-rail-render-"));
  process.env.AUG_HOME = home;
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

  // Each write redraws once its burst is over (aug.tsx coalesces bumps).
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

// One header over the rail: the filter pills, with the inbox badge at the
// end. A second row repeating the pills' counts said the same thing twice.
test("the rail's only header is the filter pills and the inbox badge", async () => {
  home = mkdtempSync(join(tmpdir(), "aug-rail-render-"));
  process.env.AUG_HOME = home;
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
  expect(rail[pills]).toMatch(/inbox \d+/);
  expect(rail.filter((l) => /◆ \d/.test(l))).toHaveLength(1);
  const above = rail.slice(0, pills).join("");
  expect(above).not.toMatch(/\d+ open/);
  expect(above).not.toContain("Work");
});
