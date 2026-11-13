import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorBoundary } from "solid-js";
import { testRender } from "@opentui/solid";
import { App } from "../src/app";
import { installFixture } from "../src/fixtures/demo";
import * as store from "../src/core/store";

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
