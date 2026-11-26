// `riker-tools note` as an agent runs it: its own process on the home's
// database. --file carries text a shell would mangle (quotes, $, newlines).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, useDb } from "@riker/core/db";
import { paths } from "@riker/core/paths";
import * as store from "@riker/core/store";

const TOOLS = join(import.meta.dir, "../src/riker-tools.ts");

function run(home: string, args: string[], stdin?: string) {
  const proc = Bun.spawnSync(["bun", TOOLS, "note", ...args], {
    env: {
      ...process.env,
      RIKER_HOME: home,
      RIKER_TASK_ID: "",
      RIKER_ASKED_BY: "",
    },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
  });
  return {
    code: proc.exitCode,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  };
}

function notes(home: string) {
  process.env.RIKER_HOME = home;
  useDb(openDb(paths.db()));
  return store.listNotes(10).map((n) => ({ label: n.label, body: n.body }));
}

describe("riker-tools note", () => {
  const tricky = `ready: "quoted", $HOME and \`ticks\`\nsecond line`;

  test("--file posts the file's text as it is", () => {
    const home = mkdtempSync(join(tmpdir(), "riker-note-"));
    const file = join(home, "note.txt");
    writeFileSync(file, `${tricky}\n`);
    const r = run(home, ["--label", "ready to push", "--file", file]);
    expect(r).toMatchObject({ code: 0, out: "posted\n" });
    expect(notes(home)).toEqual([{ label: "ready to push", body: tricky }]);
  }, 30_000);

  test("--file - reads stdin, and a plain body still works", () => {
    const home = mkdtempSync(join(tmpdir(), "riker-note-"));
    expect(run(home, ["--file", "-"], tricky).code).toBe(0);
    expect(run(home, ["plain words"]).code).toBe(0);
    expect(
      notes(home)
        .map((n) => n.body)
        .sort(),
    ).toEqual([tricky, "plain words"].sort());
  }, 30_000);

  test("no body and no file, or a file that is not there, is refused", () => {
    const home = mkdtempSync(join(tmpdir(), "riker-note-"));
    const none = run(home, []);
    expect(none.code).toBe(1);
    expect(none.err).toContain("--file <path>");
    const missing = run(home, ["--file", join(home, "nope.txt")]);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("cannot read");
  }, 30_000);
});
