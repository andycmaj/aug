import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codingBrief } from "../src/agents";
import type { RikerConfig } from "../src/config";
import {
  digestWanted,
  journalSwitch,
  redact,
  repeated,
  storySwitch,
  SwitchFrom,
} from "../src/digests";
import { readSlice, sliceText } from "../src/digest-watcher";
import { Engine } from "../src/engine";
import { handleDone, handleHook } from "../src/hooks";
import {
  archiveFile,
  journalFile,
  journalTick,
  MARK,
  placeEntry,
} from "../src/journal";
import { sessionEnded, sessionStarted, workMerged, EndReason } from "../src/lifecycle";
import { taskDetail } from "../src/lookup";
import { pin, storyText, undoStory } from "../src/story";
import { localDay } from "../src/rail";
import * as store from "../src/store";
import { DigestBy, Kind, SessionKind, SpendRole } from "../src/types";
import { config, fakeBrain, freshHome, testConfig } from "./support/helpers";

let n = 0;

function on(journal: boolean, story: boolean): RikerConfig {
  return { ...config(), journal: { enabled: journal }, story: { enabled: story } };
}

function setup(cfg: Partial<RikerConfig> = {}) {
  freshHome({ journal: { enabled: true }, story: { enabled: true }, ...cfg });
  const project = store.createProject({ name: `Proj ${++n}`, tmuxSession: `p${n}` });
  const task = store.createTask({
    title: `Make the thing ${n}`,
    kind: Kind.coding,
    channel: "github",
    projectId: project.id,
  });
  return { project, task };
}

function start(taskId: number, transcript?: string) {
  const id = `sess-${++n}`;
  sessionStarted({ id, taskId, kind: SessionKind.tmux, cwd: "/w", startedBy: "owner" });
  if (transcript) store.updateSession(id, { transcript_path: transcript });
  return { taskId, sessionId: id };
}

function jsonl(...entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

const edit = (file: string) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: file, old_string: "a", new_string: "b" } }] },
});
const said = (text: string) => ({ type: "assistant", message: { content: [{ type: "text", text }] } });
const read = (file: string) => ({
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "Read", input: { file_path: file } }] },
});

describe("secrets", () => {
  test("token shapes and key=value secrets are redacted", () => {
    const text = [
      "used ghp_abcdefghijklmnopqrstuvwxyz0123 to push",
      "slack xoxb-1234567890-abcdefghij",
      "anthropic sk-ant-api03-abcdefghijklmnop",
      "aws AKIAABCDEFGHIJKLMNOP",
      "password=hunter2 and token: abc.def",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = redact(text);
    for (const secret of ["ghp_abc", "xoxb-", "sk-ant-", "AKIAABC", "hunter2", "abc.def", "MIIE"])
      expect(out).not.toContain(secret);
    expect(out).toContain("password=[redacted]");
    expect(out).toContain("token: [redacted]");
  });

  test("plain words pass", () => {
    expect(redact("the token bucket refills; see secret-sauce.md")).toBe(
      "the token bucket refills; see secret-sauce.md",
    );
  });
});

describe("switches", () => {
  test("config is the default; a project overrides it; a task overrides both", () => {
    const { project, task } = setup({ journal: { enabled: false }, story: { enabled: false } });
    const cfg = config();
    expect(storySwitch(cfg, task)).toEqual({ on: false, from: SwitchFrom.config });
    expect(digestWanted(cfg, task)).toBe(false);

    store.updateProject(project.id, { story: 1, journal: 1 });
    const t = store.getTask(task.id)!;
    expect(storySwitch(cfg, t)).toEqual({ on: true, from: SwitchFrom.project });
    expect(journalSwitch(cfg, store.getProject(project.id))).toEqual({ on: true, from: SwitchFrom.project });

    store.updateTask(task.id, { story: 0 });
    expect(storySwitch(cfg, store.getTask(task.id)!)).toEqual({ on: false, from: SwitchFrom.task });
    // The journal still wants the digest.
    expect(digestWanted(cfg, store.getTask(task.id)!)).toBe(true);
  });

  test("story and journal moves set the rows; default clears them; ctrl+z puts a task's back", async () => {
    const { project, task } = setup({ journal: { enabled: false }, story: { enabled: false } });
    const engine = new Engine({ config: testConfig() });
    const ref = store.taskRef(task.id);
    expect((await engine.runMove("story", { task: ref, to: "on" })).result).toContain("story: on (task)");
    expect(store.getTask(task.id)!.story).toBe(1);
    await engine.desk.undo();
    expect(store.getTask(task.id)!.story).toBeNull();

    expect((await engine.runMove("journal", { project: project.name, to: "on" })).result).toContain("journal: on (project)");
    expect(store.getProject(project.id)!.journal).toBe(1);
    await engine.runMove("journal", { project: project.name, to: "default" });
    expect(store.getProject(project.id)!.journal).toBeNull();
    await engine.runMove("journal", { project: project.name, to: "on", stories: "yes" });
    expect(store.getProject(project.id)!.story).toBe(1);
    expect((await engine.runMove("story", { task: ref, to: "maybe" })).result).toContain("say on, off or default");
  });
});

describe("done writes the digest", () => {
  test("with the flags, a digest, knowledge and a story version", () => {
    const { task } = setup();
    const ref = start(task.id);
    handleDone(
      ref,
      {
        summary: "built it",
        digest: {
          did: ["journal writer", "story rows"],
          learned: ["citty keeps only the last repeat", "knowledge:citty: repeated flags keep only the last value"],
          next: ["TUI toggle"],
          decision: ["engine is the only file writer"],
          goal: ["ship the journal"],
          outcome: "ready",
        },
      },
      undefined,
      config(),
    );
    const d = store.latestDigest(task.id)!;
    expect(d.by).toBe(DigestBy.agent);
    expect(d.session_id).toBe(ref.sessionId);
    expect(d.did).toBe("journal writer\nstory rows");
    const ids = JSON.parse(d.knowledge) as number[];
    expect(ids).toHaveLength(1);
    const k = store.listKnowledge().find((r) => r.id === ids[0])!;
    expect(k.topic).toBe("citty");
    expect(k.body).toContain("repeated flags keep only the last value");
    expect(d.learned).toBe(`citty keeps only the last repeat\n(Knowledge #${ids[0]}) repeated flags keep only the last value`);

    const v = store.currentStory(task.id)!;
    expect(v.goals).toBe("ship the journal");
    expect(v.now).toBe("journal writer\nstory rows");
    expect(v.next).toBe("TUI toggle");
  });

  test("no flags: the summary is what it did; secrets never stored", () => {
    const { task } = setup();
    handleDone(start(task.id), { summary: "pushed with ghp_abcdefghijklmnopqrstuvwxyz0123" }, undefined, config());
    expect(store.latestDigest(task.id)!.did).toBe("pushed with [redacted]");
  });

  test("both off: no digest, no story", () => {
    const { task } = setup({ journal: { enabled: false }, story: { enabled: false } });
    handleDone(start(task.id), { summary: "x", digest: { next: ["y"] } }, undefined, config());
    expect(store.latestDigest(task.id)).toBeNull();
    expect(store.currentStory(task.id)).toBeNull();
  });

  test("repeated flags are each kept", () => {
    expect(repeated(["--summary", "s", "--next", "a b", "--next=c", "--learned", "x"], "next")).toEqual(["a b", "c"]);
    expect(repeated(["--summary", "s"], "next")).toBeUndefined();
  });

  test("the stop hook keeps the transcript path", () => {
    const { task } = setup();
    const ref = start(task.id);
    handleHook("stop", { transcript_path: "/t/x.jsonl" }, ref);
    expect(store.getSession(ref.sessionId)!.transcript_path).toBe("/t/x.jsonl");
  });
});

describe("the story", () => {
  test("pins ride on every version; undo steps back and keeps them", () => {
    const { task } = setup();
    handleDone(start(task.id), { summary: "a", digest: { next: ["first"] } }, undefined, config());
    pin(task.id, "keep the file plain text");
    handleDone(start(task.id), { summary: "b", digest: { next: ["second"] } }, undefined, config());
    const cur = store.currentStory(task.id)!;
    expect(cur.next).toBe("second");
    expect(cur.pinned).toBe("keep the file plain text");

    const back = undoStory(task.id)!;
    expect(back.by).toBe("undo");
    expect(back.next).toBe("first");
    expect(back.pinned).toBe("keep the file plain text");
    expect(store.storiesFor(task.id)).toHaveLength(4);
    expect(pin(task.id, "keep the file plain text")).toBeNull();
    expect(pin(task.id, "keep the file plain text", true)!.pinned).toBe("");
  });

  test("plain text, owner's pins first, empty parts left out", () => {
    const { task } = setup();
    handleDone(start(task.id), { summary: "did it", digest: { next: ["n1", "n2"] } }, undefined, config());
    pin(task.id, "owner goal");
    const text = storyText(store.currentStory(task.id)!);
    expect(text).toBe("Pinned by the owner:\n- owner goal\n\nNow:\n- did it\n\nNext steps:\n- n1\n- n2");
    expect(text).not.toContain("#");
  });

  test("the coding brief carries the story and asks for the digest flags", () => {
    const { task } = setup();
    expect(codingBrief(config(), task)).toContain("--learned");
    handleDone(start(task.id), { summary: "half done", digest: { next: ["finish"] } }, undefined, config());
    const brief = codingBrief(config(), store.getTask(task.id)!);
    expect(brief).toContain("Story so far");
    expect(brief).toContain("- finish");
    expect(codingBrief(on(false, false), store.getTask(task.id)!)).not.toContain("--learned");
  });

  test("riker-tools task shows the switch and the story", () => {
    const { task } = setup();
    handleDone(start(task.id), { summary: "s", digest: { next: ["go on"] } }, undefined, config());
    const detail = taskDetail(store.getTask(task.id)!, 12, config());
    expect(detail).toContain("story: on (config)");
    expect(detail).toContain("Next steps:\n- go on");
  });
});

describe("placing an entry", () => {
  const opts = (entry: string, month = "2026-11") => ({ title: "P: journal", entry, month, status: ["T1 open"] });

  test("a new file gets a title, a status block and the entry", () => {
    const { text, remarked } = placeEntry("", opts("first"));
    expect(remarked).toBe(false);
    expect(text).toStartWith("P: journal\n\n");
    expect(text).toContain(`${MARK.statusBegin}\nNow:\n- T1 open\n${MARK.statusEnd}`);
    expect(text).toContain(`${MARK.entry("2026-11")}\nfirst`);
  });

  test("newest first; the owner's text and hand edits are kept", () => {
    let { text } = placeEntry("", opts("first"));
    text = `My notes up top.\n\n${text}\nMy notes below.\n`;
    text = text.replace("first", "first, edited by hand");
    const out = placeEntry(text, { ...opts("second"), status: ["T1 done"] }).text;
    expect(out).toStartWith("My notes up top.");
    expect(out).toContain("My notes below.");
    expect(out).toContain("first, edited by hand");
    expect(out.indexOf("second")).toBeLessThan(out.indexOf("first, edited"));
    expect(out).toContain("- T1 done");
    expect(out).not.toContain("- T1 open");
  });

  test("a new month rolls the old entries out", () => {
    let { text } = placeEntry("", opts("october one", "2026-10"));
    text = placeEntry(text, opts("october two", "2026-10")).text;
    const placed = placeEntry(text, opts("november", "2026-11"));
    expect(placed.text).toContain("november");
    expect(placed.text).not.toContain("october");
    expect(placed.rolled.get("2026-10")!.join("\n")).toContain("october two");
  });

  test("markers gone: put back on top, the owner's text kept below", () => {
    const placed = placeEntry("Owner wrote all this.\n", opts("entry"));
    expect(placed.remarked).toBe(true);
    expect(placed.text).toContain("Owner wrote all this.");
    expect(placed.text.indexOf(MARK.begin)).toBeLessThan(placed.text.indexOf("Owner wrote"));
  });
});

describe("the journal", () => {
  test("every task event lands; a done session is one full entry; registered as a project doc", async () => {
    const { project, task } = setup();
    expect(await journalTick(config())).toBe(0); // first look: history writes nothing
    const ref = start(task.id);
    handleDone(
      ref,
      { summary: "built it", digest: { did: ["the writer"], learned: ["markers keep hand edits safe"], next: ["toggle"] } },
      undefined,
      config(),
    );
    sessionEnded(ref, EndReason.exited);
    workMerged(task.id, "merged by hand");
    const calls = fakeBrain(() => ({}));
    await journalTick(config());
    expect(calls).toHaveLength(0);

    const file = journalFile(project);
    expect(file).toBe(join(process.env.RIKER_HOME!, "projects", `proj-${n - 1}`, "journal.md"));
    const text = readFileSync(file, "utf8");
    const ref0 = store.taskRef(task.id);
    expect(text).toContain(`${ref0}  ${task.title}  (agent)\nOutcome: ready for review`);
    expect(text).toContain("Learned:\n- markers keep hand edits safe");
    expect(text).toContain("Next:\n- toggle");
    expect(text).toContain(`${ref0}  merged`);
    expect(text).not.toContain("session ended");
    expect(text.indexOf("merged")).toBeLessThan(text.indexOf("Outcome:"));
    expect(store.linksForProject(project.id).map((l) => l.url)).toEqual([`file://${file}`]);
    await journalTick(config());
    expect(store.linksForProject(project.id)).toHaveLength(1);
  });

  test("off for the project: no file", async () => {
    const { project, task } = setup();
    store.updateProject(project.id, { journal: 0 });
    await journalTick(config());
    workMerged(task.id, "x");
    await journalTick(config());
    expect(existsSync(journalFile(project))).toBe(false);
  });

  test("a month's first write moves last month's entries to their own file", async () => {
    const { project, task } = setup();
    await journalTick(config());
    const file = journalFile(project);
    const old = placeEntry("", { title: "t", entry: "from october", month: "2026-10", status: null }).text;
    store.updateTask(task.id, { merged_at: null });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, old);
    workMerged(task.id, "x");
    await journalTick(config());
    expect(readFileSync(file, "utf8")).not.toContain("from october");
    expect(readFileSync(archiveFile(project, "2026-10"), "utf8")).toContain("from october");
  });
});

describe("the watcher", () => {
  test("a session that changed something and ended without done is written up from its new lines only", async () => {
    const { project, task } = setup();
    await journalTick(config());
    const path = join(process.env.RIKER_HOME!, "t.jsonl");
    writeFileSync(path, jsonl(said("old work"), edit("/w/old.ts")));
    const ref = start(task.id, path);
    // A first run of the session was written up by done.
    handleDone(ref, { summary: "first run" }, undefined, config());
    sessionEnded(ref, EndReason.exited);
    await journalTick(config());
    // Resumed: same id, more work, then it ends with no done.
    start(task.id);
    sessionStarted({ id: ref.sessionId, taskId: task.id, kind: SessionKind.tmux, cwd: "/w", startedBy: "owner" });
    writeFileSync(path, readFileSync(path, "utf8") + jsonl(said("new work"), edit("/w/new.ts")));
    const calls = fakeBrain(() => ({ outcome: "stopped", did: ["new.ts half done"], next: ["finish new.ts"] }));
    sessionEnded(ref, EndReason.window);
    await journalTick(config());

    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe("haiku");
    expect(calls[0].spend).toEqual({ role: SpendRole.digest, taskId: task.id });
    expect(calls[0].tools).toBeUndefined();
    expect(calls[0].prompt).toContain("new work");
    expect(calls[0].prompt).not.toContain("old work");
    const d = store.latestDigest(task.id)!;
    expect(d.by).toBe(DigestBy.watcher);
    expect(store.currentStory(task.id)!.next).toBe("finish new.ts");
    const text = readFileSync(journalFile(project), "utf8");
    expect(text).toContain("(written up by the watcher)\nOutcome: stopped before it finished");
  });

  test("nothing changed: no model call, one line", async () => {
    const { project, task } = setup();
    await journalTick(config());
    const path = join(process.env.RIKER_HOME!, "r.jsonl");
    writeFileSync(path, jsonl(said("looked around"), read("/w/a.ts")));
    const ref = start(task.id, path);
    const calls = fakeBrain(() => ({}));
    sessionEnded(ref, EndReason.exited);
    await journalTick(config());
    expect(calls).toHaveLength(0);
    expect(readFileSync(journalFile(project), "utf8")).toContain("session ended; nothing changed");
  });

  test("Riker's own restart is not a session's end", async () => {
    const { project, task } = setup();
    await journalTick(config());
    const ref = start(task.id);
    sessionEnded(ref, EndReason.restart);
    await journalTick(config());
    expect(existsSync(journalFile(project))).toBe(false);
  });

  test("past the daily cap it asks nothing", async () => {
    const { task } = setup({ spend: { capEnabled: true, dailyUsd: 0.01 } });
    await journalTick(config());
    store.addSpend({
      day: localDay(new Date()),
      taskId: null,
      role: SpendRole.other,
      model: null,
      costUsd: 1,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
    const path = join(process.env.RIKER_HOME!, "c.jsonl");
    writeFileSync(path, jsonl(edit("/w/x.ts")));
    const ref = start(task.id, path);
    const calls = fakeBrain(() => ({ did: ["x"], next: [] }));
    sessionEnded(ref, EndReason.exited);
    await journalTick(config());
    expect(calls).toHaveLength(0);
    expect(readFileSync(journalFile(store.getProject(task.project_id!)!), "utf8")).toContain(
      "session ended; not written up: the daily spend cap is reached",
    );
  });

  test("the slice is words and tool names, never tool output; a commit counts as a change", () => {
    const s = sliceText(
      jsonl(
        { type: "user", message: { content: "do it" } },
        { type: "user", message: { content: [{ type: "tool_result", content: "SECRET FILE BODY" }] } },
        { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "git commit -m x" } }] } },
      ),
    );
    expect(s.changed).toBe(true);
    expect(s.text).toContain("Owner: do it");
    expect(s.text).toContain("[tool Bash: git commit -m x]");
    expect(s.text).not.toContain("SECRET FILE BODY");
    expect(readSlice("/nope/none.jsonl", 0)).toBeNull();
  });
});
