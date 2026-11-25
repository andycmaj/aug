import { describe, expect, test } from "bun:test";
import { Engine } from "../src/engine";
import { docLinks } from "../src/rows";
import { handleDone } from "../src/hooks";
import { journalFile, journalMarkdown, journalTick, JournalSave, saveJournalEdit, writeJournal } from "../src/journal";
import { sessionEnded, sessionStarted, workMerged, EndReason } from "../src/lifecycle";
import { editStory, parseStory, pin, storyMarkdown } from "../src/story";
import * as store from "../src/store";
import { readFileSync } from "node:fs";
import { Kind, SessionKind } from "../src/types";
import { config, freshHome, testConfig } from "./support/helpers";

let n = 0;

function setup() {
  freshHome({ journal: { enabled: true }, story: { enabled: true } });
  const project = store.createProject({ name: `Reader ${++n}`, tmuxSession: `r${n}` });
  const task = store.createTask({
    title: `Read the thing ${n}`,
    kind: Kind.coding,
    channel: "github",
    projectId: project.id,
  });
  return { project, task };
}

function start(taskId: number) {
  const id = `reader-sess-${++n}`;
  sessionStarted({ id, taskId, kind: SessionKind.tmux, cwd: "/w", startedBy: "owner" });
  return { taskId, sessionId: id };
}

describe("the story as markdown", () => {
  test("a heading per part, the owner's pins first, empty parts left out", () => {
    const { task } = setup();
    handleDone(start(task.id), { summary: "did it", digest: { next: ["n1", "n2"] } }, undefined, config());
    pin(task.id, "owner goal");
    const md = storyMarkdown(store.currentStory(task.id));
    expect(md).toBe("## Pinned by the owner\n\n- owner goal\n\n## Now\n\n- did it\n\n## Next steps\n\n- n1\n- n2");
  });

  test("for $EDITOR every part's heading is there, empty or not", () => {
    expect(storyMarkdown(null, true).match(/^## /gm)).toHaveLength(7);
    expect(storyMarkdown(null)).toBe("");
  });

  test("read back: the same parts, with or without dashes, comments ignored", () => {
    const parsed = parseStory("<!-- RIKER-1 story -->\n\n## Goals\n\n- ship it\nplain line\n\n## next steps:\n* one\n\n## Now\n");
    expect(parsed).toEqual({
      fields: { pinned: "", goals: "ship it\nplain line", now: "", decisions: "", blocked: "", next: "one", questions: "" },
    });
  });

  test("a line under no part is refused, not dropped", () => {
    expect(parseStory("stray words\n## Goals\n- g")).toEqual({ error: expect.stringContaining("stray words") });
    expect(parseStory("## Goals\n- g\n## Ideas\n- i")).toEqual({ error: expect.stringContaining("## Ideas") });
  });

  test("a rewrite is a new version by the owner; the same parts make none", () => {
    const { task } = setup();
    handleDone(start(task.id), { summary: "half", digest: { next: ["finish"] } }, undefined, config());
    const before = store.storiesFor(task.id).length;
    const same = editStory(task.id, storyMarkdown(store.currentStory(task.id), true));
    expect(same).toEqual({ version: null });
    expect(store.storiesFor(task.id)).toHaveLength(before);

    const md = storyMarkdown(store.currentStory(task.id), true).replace("- finish", "- finish\n- then test");
    const edited = editStory(task.id, md);
    expect("version" in edited && edited.version?.by).toBe("owner");
    const cur = store.currentStory(task.id)!;
    expect(cur.next).toBe("finish\nthen test");
    expect(cur.now).toBe("half");
    expect(store.storiesFor(task.id)).toHaveLength(before + 1);
  });

  test("the desk's edit says what happened and ctrl+z names it", async () => {
    const { task } = setup();
    const engine = new Engine({ config: testConfig() });
    const ref = store.taskRef(task.id);
    expect(engine.desk.storyDoc(task.id)).toBeNull();
    const saved = engine.desk.editStory(task.id, `${engine.desk.storyTemplate()}\n`.replace("## Goals", "## Goals\n- a goal"));
    expect(saved).toEqual({ ok: true, text: `${ref}: story saved as a new version (story_undo steps back)` });
    expect(engine.desk.storyDoc(task.id)!.text).toBe("## Goals\n\n- a goal");
    expect(engine.desk.editStory(task.id, "## Goals\n- a goal")).toEqual({ ok: true, text: `${ref}: story unchanged` });
    expect(engine.desk.editStory(task.id, "oops").ok).toBe(false);
    expect((await engine.desk.undo()).text).toContain("story edit");
  });
});

describe("the journal as markdown", () => {
  test("its plain lines become headings and list items; markers go; owner text stays", async () => {
    const { project, task } = setup();
    await journalTick(config());
    const ref = start(task.id);
    handleDone(ref, { summary: "built it", digest: { did: ["the writer"], next: ["toggle"] } }, undefined, config());
    sessionEnded(ref, EndReason.exited);
    workMerged(task.id, "merged by hand");
    await journalTick(config());

    const engine = new Engine({ config: testConfig() });
    const found = engine.desk.journal(project.id)!;
    const md = journalMarkdown(`${found.text}\nMy own note.\n`);
    const r = store.taskRef(task.id);
    expect(md).toStartWith(`# ${project.name}: journal\n`);
    expect(md).toContain("## Now");
    expect(md).toMatch(new RegExp(`^- \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}  ${r}  merged`, "m"));
    expect(md).toMatch(new RegExp(`^### \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}  ${r}  ${task.title}  \\(agent\\)$`, "m"));
    expect(md).not.toContain("<!--");
    expect(md).toEndWith("My own note.");
    expect(md).toContain("\nOutcome: ready for review");
  });

  test("no journal yet: nothing to read", () => {
    const { project } = setup();
    const engine = new Engine({ config: testConfig() });
    expect(engine.desk.journal(project.id)).toBeNull();
  });
});

describe("saving an edit of the journal", () => {
  const entry = (n: number) => `2026-11-24 1${n}:00  RIKER-000${n}  made  (task ${n})`;

  function opened() {
    const { project } = setup();
    writeJournal(project, entry(1), "2026-11-24T10:00:00Z");
    const base = readFileSync(journalFile(project), "utf8");
    return { project, base };
  }

  test("as it was: written whole; the same text: nothing", () => {
    const { project, base } = opened();
    expect(saveJournalEdit(project, base, base)).toBe(JournalSave.unchanged);
    expect(saveJournalEdit(project, base, `${base}\nMy note.\n`)).toBe(JournalSave.saved);
    expect(readFileSync(journalFile(project), "utf8")).toBe(`${base}\nMy note.\n`);
  });

  test("an entry written while it was open is kept beside the owner's note", () => {
    const { project, base } = opened();
    writeJournal(project, entry(2), "2026-11-24T11:00:00Z");
    const edited = base.replace(/journal\n/, "journal\n\nMy note under the title.\n");
    expect(saveJournalEdit(project, base, edited)).toBe(JournalSave.merged);
    const now = readFileSync(journalFile(project), "utf8");
    expect(now).toContain("My note under the title.");
    expect(now).toContain(entry(2));
    expect(now).toContain(entry(1));
  });

  test("both on the same lines: nothing written, the engine's entry stays", () => {
    const { project, base } = opened();
    writeJournal(project, entry(2), "2026-11-24T11:00:00Z");
    const engineWrote = readFileSync(journalFile(project), "utf8");
    expect(saveJournalEdit(project, base, base.replace("(task 1)", "(task 1, edited)"))).toBe(JournalSave.conflict);
    expect(readFileSync(journalFile(project), "utf8")).toBe(engineWrote);
  });

  test("the desk says which", () => {
    const { project, base } = opened();
    const engine = new Engine({ config: testConfig() });
    writeJournal(project, entry(2), "2026-11-24T11:00:00Z");
    expect(engine.desk.saveJournal(project.id, base, `${base}\nEnd note.\n`)).toEqual({
      ok: true,
      text: `${project.name} journal: saved, with what Riker wrote while you edited`,
    });
    expect(engine.desk.saveJournal(project.id, base, base.replace("(task 1)", "(x)")).ok).toBe(false);
  });
});

describe("what the reader lists to open", () => {
  test("PR, thread, the task's links, then the project's docs; one row per URL", () => {
    const links = docLinks({
      pr: { repo: "o/r", number: 7, url: "https://github.com/o/r/pull/7" },
      source: "https://github.com/o/r/issues/3",
      task: [
        { url: "https://x.test/spec", title: "Spec" },
        { url: "https://github.com/o/r/pull/7", title: "the PR again" },
      ],
      project: [
        { url: "file:///home/me/notes.md", title: null },
        { url: "https://x.test/spec", title: "Spec, from the project" },
      ],
    });
    expect(links).toEqual([
      { label: "PR o/r#7", url: "https://github.com/o/r/pull/7" },
      { label: "thread", url: "https://github.com/o/r/issues/3" },
      { label: "Spec", url: "https://x.test/spec" },
      { label: "/home/me/notes.md (project)", url: "file:///home/me/notes.md" },
    ]);
    expect(docLinks({})).toEqual([]);
  });
});
