// A brief written as short labeled paragraphs (BRIEF_STYLE) keeps its line
// breaks from the move that makes it, through the store, to every place it
// is read back: the agent's prompt, riker-tools task, a task action.

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codingBrief, codingLaunch, turnPrompt } from "../src/agents";
import { assistantSystem } from "../src/assistant";
import { Engine } from "../src/engine";
import { taskDetail } from "../src/lookup";
import { BRIEF_STYLE } from "../src/moves";
import { setMux } from "../src/mux";
import { docDraftsDir } from "../src/paths";
import { labeled } from "../src/rows";
import * as store from "../src/store";
import { Kind, MoveStatus } from "../src/types";
import { FakeMux } from "./support/fake-mux";
import { config, fakeBrain, freshHome, testConfig } from "./support/helpers";

const BRIEF = [
  "What to change",
  "Show the brief with its paragraph breaks.",
  "",
  "Where",
  "packages/tui/src/components/canvas.tsx",
  "  keep this indent",
  "",
  "Owner's words",
  "favor whitespace over more symbols",
].join("\n");

let engine: Engine;

beforeEach(() => {
  freshHome({ repos: { "acme/api": "/src/api" } });
  fakeBrain(() => null);
  setMux(new FakeMux());
  engine = new Engine({ config: testConfig() });
});

function draft(name: string, text: string): string {
  const file = join(docDraftsDir(), name);
  writeFileSync(file, text);
  return file;
}

async function made(args: Record<string, string>) {
  const out = await engine.runMove("new", {
    title: "Readable briefs",
    kind: "coding",
    repo: "acme/api",
    ...args,
  });
  expect(out.ok).toBe(true);
  const ref = out.result.match(/RIKER-\d+/)![0];
  return store.getTask(store.parseTaskRef(ref)!)!;
}

describe("a brief with blank lines", () => {
  test("survives the moves bus inline, as riker-tools sends it", async () => {
    // riker-tools enqueues the args as given and the engine drains them.
    const move = store.enqueueMove(
      "new",
      {
        title: "Readable briefs",
        kind: "coding",
        repo: "acme/api",
        brief: `${BRIEF}\n`,
      },
      "assistant",
    );
    await engine.drainMoves();
    const row = store.getMove(move.id)!;
    expect(row.status).toBe(MoveStatus.done);
    const task = store.getTask(
      store.parseTaskRef(row.result!.match(/RIKER-\d+/)![0])!,
    )!;
    expect(task.summary).toBe(BRIEF);
  });

  test("comes from a draft file, which goes once the task is made", async () => {
    const file = draft(
      "brief.txt",
      `# 12 starts a line, which Bash denies inline\n\n${BRIEF}\n`,
    );
    const task = await made({ file });
    expect(task.summary).toBe(
      `# 12 starts a line, which Bash denies inline\n\n${BRIEF}`,
    );
    expect(existsSync(file)).toBe(false);
  });

  test("a refused move keeps its draft to call again with", async () => {
    const file = draft("kept.txt", BRIEF);
    const out = await engine.runMove("new", {
      title: "x",
      project: "nope",
      file,
    });
    expect(out.ok).toBe(false);
    expect(existsSync(file)).toBe(true);
  });

  test("takes --brief or --file, not both, and only a file in drafts", async () => {
    const file = draft("both.txt", BRIEF);
    expect(
      (await engine.runMove("new", { title: "x", brief: "y", file })).result,
    ).toBe("give --brief or --file, not both");
    const outside = join(process.env.RIKER_HOME!, "elsewhere.txt");
    writeFileSync(outside, BRIEF);
    expect(
      (await engine.runMove("new", { title: "x", file: outside })).result,
    ).toStartWith("the file must be in");
  });

  test("move brief rewrites it from a file or inline, breaks kept", async () => {
    const task = await made({ brief: "one line" });
    const ref = store.taskRef(task.id);
    const file = draft("again.txt", BRIEF);
    expect((await engine.runMove("brief", { task: ref, file })).ok).toBe(true);
    expect(store.getTask(task.id)!.summary).toBe(BRIEF);
    expect(existsSync(file)).toBe(false);
    expect(
      (
        await engine.runMove("brief", {
          task: ref,
          text: `${BRIEF}\n\nWhy\nmore`,
        })
      ).ok,
    ).toBe(true);
    expect(store.getTask(task.id)!.summary).toBe(`${BRIEF}\n\nWhy\nmore`);
    expect((await engine.runMove("brief", { task: ref })).result).toBe(
      "brief needs --text or --file",
    );
  });

  test("reaches the coding agent's prompt file unchanged", async () => {
    const task = await made({ brief: BRIEF });
    expect(codingBrief(config(), task)).toContain(
      `## The task\n${store.taskRef(task.id)}: Readable briefs\n${BRIEF}\n`,
    );
    const launch = codingLaunch(config(), task);
    const file =
      launch.argv[launch.argv.indexOf("--append-system-prompt-file") + 1];
    expect(readFileSync(file, "utf8")).toContain(`\n${BRIEF}\n`);
  });

  test("sits under its label where a task is read back, never run into it", async () => {
    const task = await made({ brief: BRIEF });
    expect(taskDetail(task)).toContain(`\nSummary:\n${BRIEF}\n`);
    expect(turnPrompt(task, [], "test")).toContain(`\nSummary:\n${BRIEF}\n`);
  });
});

describe("how briefs are asked for", () => {
  test("the Assistant is told the style; a coding agent does not pay for it", async () => {
    expect(assistantSystem(config())).toContain(BRIEF_STYLE);
    const task = await made({ brief: "x" });
    expect(codingBrief(config(), task)).not.toContain(BRIEF_STYLE);
  });

  test("a one-line field stays on its label's line", () => {
    expect(labeled("Summary", "fix the build")).toBe("Summary: fix the build");
    expect(labeled("Summary", "a\n\nb")).toBe("Summary:\na\n\nb");
  });
});
