import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentPool } from "../src/core/agents";
import { migrate } from "../src/core/db";
import {
  changedFiles,
  openerArgv,
  parseCsv,
  parseFiles,
  previewOf,
  snapshotDir,
  tableLines,
} from "../src/core/files";
import { paths } from "../src/core/paths";
import { neighborKey } from "../src/core/rail";
import * as store from "../src/core/store";
import { Kind, TurnRole } from "../src/core/types";
import { fakeBrain, freshHome } from "./helpers";

describe("csv", () => {
  test("quotes, doubled quotes, delimiters and newlines inside quotes", () => {
    expect(
      parseCsv('site,cost\nFairhaven,"$18,540"\n"Dock ""B""","a\nb"\n'),
    ).toEqual([
      ["site", "cost"],
      ["Fairhaven", "$18,540"],
      ['Dock "B"', "a\nb"],
    ]);
    expect(parseCsv("a\tb\r\n1\t2", "\t")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  test("a table fits its width and says how many rows it left out", () => {
    const rows = [
      ["site", "a very long column of notes"],
      ...Array.from({ length: 25 }, (_, i) => [`s${i}`, "x".repeat(40)]),
    ];
    const lines = tableLines(rows, 30, 20);
    expect(lines.slice(0, -1).every((l) => l.length <= 30)).toBe(true);
    expect(lines.at(-1)).toBe("… 6 more rows");
  });

  test("previews by extension", () => {
    expect(previewOf("plan.md")).toBe("markdown");
    expect(previewOf("ot.CSV")).toBe("table");
    expect(previewOf("chart.png")).toBe("none");
  });
});

describe("what a turn made", () => {
  test("only new or rewritten files count", () => {
    const dir = mkdtempSync(join(tmpdir(), "aug-files-"));
    writeFileSync(join(dir, "old.md"), "x");
    const before = snapshotDir(dir);
    writeFileSync(join(dir, "new.csv"), "a,b");
    mkdirSync(join(dir, "out"));
    writeFileSync(join(dir, "out", "deep.md"), "y");
    expect(
      changedFiles(dir, before, snapshotDir(dir)).map((f) => f.name),
    ).toEqual(["new.csv", "out/deep.md"]);
  });

  beforeEach(() => freshHome());

  test("a general agent turn records the files it wrote", async () => {
    const t = store.createTask({
      title: "x",
      kind: Kind.general,
      channel: "owner",
    });
    store.addTurn({ taskId: t.id, role: TurnRole.you, body: "make a table" });
    fakeBrain((call) => {
      writeFileSync(join(call.cwd!, "overtime.csv"), "site,hours\nA,1\n");
      return { about: "a", did: "b", next: "c", state: "done" };
    });
    await new AgentPool({ limit: () => 1 }).request(t.id, "x", "owner");
    const turn = store.turnsForTask(t.id).at(-1)!;
    expect(parseFiles(turn.files)).toEqual([
      {
        path: join(paths.work(t.id), "overtime.csv"),
        name: "overtime.csv",
        bytes: 15,
      },
    ]);
  });

  test("an old database gains the files column", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE turns (id INTEGER PRIMARY KEY, body TEXT)");
    db.exec("INSERT INTO turns (body) VALUES ('hi')");
    migrate(db);
    expect(db.query("SELECT files FROM turns").get()).toEqual({ files: "[]" });
    migrate(db);
  });
});

describe("opener", () => {
  test("config wins, else the platform's", () => {
    expect(openerArgv("f.csv", "code --wait", "darwin", false)).toEqual([
      "code",
      "--wait",
      "f.csv",
    ]);
    expect(openerArgv("f.csv", ["wslview"], "linux", false)).toEqual([
      "wslview",
      "f.csv",
    ]);
    expect(openerArgv("f.csv", undefined, "linux", true)).toEqual([
      "wslview",
      "f.csv",
    ]);
    expect(openerArgv("f.csv", undefined, "darwin", false)).toEqual([
      "open",
      "f.csv",
    ]);
    expect(openerArgv("f.csv", undefined, "linux", false)).toEqual([
      "xdg-open",
      "f.csv",
    ]);
  });
});

describe("rail cursor", () => {
  test("a departing row hands the cursor to the row below, else above", () => {
    expect(neighborKey(["a", "b", "c"], "b")).toBe("c");
    expect(neighborKey(["a", "b", "c"], "c")).toBe("b");
    expect(neighborKey(["a"], "a")).toBeNull();
    expect(neighborKey(["a", "b"], "zz")).toBe("a");
  });
});
