import { beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { paneCommand, setMux } from "../src/core/mux";
import { runInPane } from "../src/core/pane";
import { FakeMux } from "./fake-mux";

let fake: FakeMux;

beforeEach(() => {
  fake = new FakeMux();
  setMux(fake);
});

test("without --wait it splits the caller's window and answers the pane", async () => {
  const result = await runInPane({
    paneId: "%3",
    cwd: "/repo",
    argv: ["revdiff", "HEAD"],
    zoom: true,
    wait: false,
  });
  expect(result.exitCode).toBeNull();
  expect(fake.splits).toEqual([
    {
      paneId: "%3",
      cwd: "/repo",
      argv: ["revdiff", "HEAD"],
      zoom: true,
      id: result.paneId,
    },
  ]);
});

test("--wait blocks until the pane closes and passes its exit code on", async () => {
  const running = runInPane({
    paneId: "%3",
    cwd: "/repo",
    argv: ["revdiff"],
    zoom: true,
    wait: true,
    pollMs: 5,
  });
  await Bun.sleep(20);
  const split = fake.splits[0];
  expect(split?.exitFile).toBeString();
  writeFileSync(split?.exitFile ?? "", "10\n");
  fake.livePanes.delete(split?.id ?? "");
  expect((await running).exitCode).toBe(10);
});

test("a pane killed before its command finished counts as a failure", async () => {
  const running = runInPane({
    paneId: "%3",
    cwd: "/repo",
    argv: ["revdiff"],
    zoom: false,
    wait: true,
    pollMs: 5,
  });
  await Bun.sleep(20);
  fake.livePanes.clear();
  expect((await running).exitCode).toBe(1);
});

test("the pane's command line records the exit code before the pane closes", () => {
  expect(paneCommand(["revdiff", "--output=/tmp/a b"])).toBe(
    "revdiff '--output=/tmp/a b'",
  );
  expect(paneCommand(["revdiff"], "/tmp/x/exit")).toBe(
    "revdiff; echo $? > /tmp/x/exit",
  );
});
