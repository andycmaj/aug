import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildDocuments,
  DocKind,
  DocSource,
  documents,
  groupOf,
  inKind,
  inProject,
  kindOf,
  matchesDoc,
  nextKind,
  nextProject,
  projectChoices,
  removable,
  urlsIn,
} from "../src/documents";
import { DocName, docPath, ensureDocs } from "../src/docs";
import { linkTarget } from "../src/links";
import { paths } from "../src/paths";
import * as store from "../src/store";
import { Kind, NoteLabel, TurnRole, Verdict } from "../src/types";
import { freshHome } from "./support/helpers";

beforeEach(() => freshHome());

function sources(
  patch: Partial<store.DocumentSources> = {},
): store.DocumentSources {
  return {
    taskLinks: [],
    projectLinks: [],
    projects: [
      { id: 1, name: "Riker", status: "active" },
      { id: 2, name: "Launch", status: "active" },
    ],
    tasks: [
      {
        id: 10,
        title: "Fix the rail",
        url: null,
        project_id: 1,
        created_at: "2026-11-01T00:00:00Z",
      },
      {
        id: 11,
        title: "Plan launch",
        url: null,
        project_id: 2,
        created_at: "2026-11-02T00:00:00Z",
      },
      {
        id: 12,
        title: "Loose end",
        url: null,
        project_id: null,
        created_at: "2026-11-03T00:00:00Z",
      },
    ],
    threads: [],
    made: [],
    notes: [],
    messages: [],
    ...patch,
  };
}

function link(
  id: number,
  taskId: number,
  url: string,
  title: string | null,
  at: string,
) {
  return { id, task_id: taskId, url, title, added_by: "you", created_at: at };
}

const kind = (url: string) => kindOf(linkTarget(url)!);

describe("kinds", () => {
  test("each link has a kind from its address alone", () => {
    expect(kind("https://github.com/o/r/pull/7")).toBe(DocKind.pr);
    expect(kind("https://github.com/o/r/pull/7/files")).toBe(DocKind.pr);
    expect(kind("https://github.com/o/r/issues/3")).toBe(DocKind.issue);
    expect(kind("https://github.com/o/r/blob/main/README.md")).toBe(
      DocKind.doc,
    );
    expect(kind("https://team.slack.com/archives/C1/p123")).toBe(
      DocKind.thread,
    );
    expect(kind("https://www.notion.so/team/Plan-abc")).toBe(DocKind.doc);
    expect(kind("https://docs.google.com/document/d/x")).toBe(DocKind.doc);
    expect(kind("https://claude.ai/artifact/abc")).toBe(DocKind.doc);
    expect(kind("https://acme.atlassian.net/browse/ENG-1")).toBe(DocKind.issue);
    expect(kind("https://linear.app/acme/issue/ENG-1/x")).toBe(DocKind.issue);
    expect(kind("/tmp/proof.md")).toBe(DocKind.file);
    expect(kind("file:///tmp/proof.md")).toBe(DocKind.file);
    expect(kind("https://example.com/x")).toBe(DocKind.other);
    expect(kind("HTTPS://GitHub.com/o/r/pull/7")).toBe(DocKind.pr);
  });
});

describe("urls in text", () => {
  test("finds http(s) and file links, Slack and Markdown wrapping, trailing punctuation", () => {
    expect(
      urlsIn(
        "see <https://a.test/x|the plan>, and [doc](https://b.test/y). Proof: file:///tmp/p.md! Also https://a.test/x again; javascript:alert(1)",
      ),
    ).toEqual(["https://a.test/x", "https://b.test/y", "file:///tmp/p.md"]);
  });
});

describe("building the list", () => {
  test("the same address on several things is one row with every owner", () => {
    const rows = buildDocuments(
      sources({
        taskLinks: [
          link(
            1,
            10,
            "https://www.notion.so/Spec",
            "the spec",
            "2026-11-05T00:00:00Z",
          ),
          link(
            2,
            11,
            "HTTPS://WWW.NOTION.SO/Spec/",
            null,
            "2026-11-06T00:00:00Z",
          ),
        ],
        projectLinks: [
          {
            id: 1,
            project_id: 2,
            url: "https://www.notion.so/Spec",
            title: null,
            added_by: "you",
            created_at: "2026-11-04T00:00:00Z",
          },
        ],
      }),
    );
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.title).toBe("the spec");
    expect(row.kind).toBe(DocKind.doc);
    expect(row.host).toBe("notion.so");
    expect(row.at).toBe("2026-11-06T00:00:00Z");
    expect(
      row.owners.map((o) => [o.source, o.taskId, o.projectId, o.stored]),
    ).toEqual([
      [DocSource.link, 11, 2, "HTTPS://WWW.NOTION.SO/Spec/"],
      [DocSource.link, 10, 1, "https://www.notion.so/Spec"],
      [DocSource.projectLink, null, 2, "https://www.notion.so/Spec"],
    ]);
    expect(row.owners.every(removable)).toBe(true);
  });

  test("a task's PR from its branch, its thread and a link to the PR's files tab are one row", () => {
    const rows = buildDocuments(
      sources({
        tasks: [
          {
            id: 10,
            title: "Fix the rail",
            url: "https://github.com/o/r/pull/7",
            project_id: 1,
            created_at: "2026-11-01T00:00:00Z",
          },
        ],
        threads: [
          {
            task_id: 10,
            thread_key: "github:o/r#7",
            linked_at: "2026-11-02T00:00:00Z",
          },
        ],
        taskLinks: [
          link(
            1,
            10,
            "https://github.com/o/r/pull/7/files",
            "PR #7",
            "2026-11-03T00:00:00Z",
          ),
        ],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe(DocKind.pr);
    expect(rows[0].title).toBe("PR #7");
    // One owner per task, and it is the link someone attached: that can come off.
    expect(rows[0].owners).toHaveLength(1);
    expect(rows[0].owners[0].source).toBe(DocSource.link);
    expect(rows[0].owners[0].stored).toBe(
      "https://github.com/o/r/pull/7/files",
    );
  });

  test("untitled links get a name from the address", () => {
    const rows = buildDocuments(
      sources({
        threads: [
          {
            task_id: 10,
            thread_key: "github:o/r#7",
            linked_at: "2026-11-02T00:00:00Z",
          },
        ],
        tasks: [
          {
            id: 10,
            title: "Fix",
            url: "https://team.slack.com/archives/C1/p1",
            project_id: 1,
            created_at: "2026-11-01T00:00:00Z",
          },
        ],
        taskLinks: [
          link(1, 10, "https://example.com/a/b/", null, "2026-11-03T00:00:00Z"),
        ],
      }),
    );
    expect(rows.map((r) => [r.title, r.kind, r.owners[0].source])).toEqual([
      ["example.com/a/b", DocKind.other, DocSource.link],
      ["o/r#7", DocKind.pr, DocSource.pr],
      ["Slack thread", DocKind.thread, DocSource.thread],
    ]);
  });

  test("files the agent made, URLs in notes and in messages on a task", () => {
    const rows = buildDocuments(
      sources({
        made: [
          {
            task_id: 12,
            files: JSON.stringify([
              { path: "/w/12/proof.md", name: "proof.md", bytes: 10 },
            ]),
            started_at: "2026-11-07T00:00:00Z",
          },
        ],
        notes: [
          {
            task_id: 10,
            author: "agent RIKER-0010",
            body: "spec at https://a.test/spec.",
            created_at: "2026-11-06T00:00:00Z",
          },
        ],
        messages: [
          {
            task_id: 11,
            author_name: "Sam",
            body: "<https://b.test/t|ticket>",
            received_at: "2026-11-05T00:00:00Z",
          },
        ],
      }),
    );
    expect(
      rows.map((r) => [
        r.title,
        r.owners[0].source,
        r.owners[0].by,
        removable(r.owners[0]),
      ]),
    ).toEqual([
      ["proof.md", DocSource.made, "agent", false],
      ["a.test/spec", DocSource.note, "agent RIKER-0010", false],
      ["b.test/t", DocSource.message, "Sam", false],
    ]);
  });

  test("a stored link that is neither web nor file is left out, never opened", () => {
    const rows = buildDocuments(
      sources({
        taskLinks: [
          link(1, 10, "javascript:alert(1)", "x", "2026-11-03T00:00:00Z"),
        ],
      }),
    );
    expect(rows).toEqual([]);
  });
});

describe("filters", () => {
  const rows = () =>
    buildDocuments(
      sources({
        taskLinks: [
          link(
            1,
            10,
            "https://github.com/o/r/pull/7",
            "rail PR",
            "2026-11-05T00:00:00Z",
          ),
          link(
            2,
            11,
            "https://www.notion.so/Launch-plan",
            "launch plan",
            "2026-11-06T00:00:00Z",
          ),
          link(
            3,
            12,
            "https://example.com/loose",
            null,
            "2026-11-07T00:00:00Z",
          ),
        ],
      }),
    );

  test("by kind, by project (or none), by every search word", () => {
    const all = rows();
    expect(
      all.filter((r) => inKind(r, DocKind.pr)).map((r) => r.title),
    ).toEqual(["rail PR"]);
    expect(all.filter((r) => inProject(r, 2)).map((r) => r.title)).toEqual([
      "launch plan",
    ]);
    expect(all.filter((r) => inProject(r, "none")).map((r) => r.title)).toEqual(
      ["example.com/loose"],
    );
    expect(
      all.filter((r) => matchesDoc(r, "riker pr")).map((r) => r.title),
    ).toEqual(["rail PR"]);
    expect(
      all.filter((r) => matchesDoc(r, "RIKER-0011")).map((r) => r.title),
    ).toEqual(["launch plan"]);
    expect(
      all.filter((r) => matchesDoc(r, "notion")).map((r) => r.title),
    ).toEqual(["launch plan"]);
  });

  test("filters cycle back to all", () => {
    const seen: (string | null)[] = [];
    let k: DocKind | null = null;
    do {
      k = nextKind(k);
      seen.push(k);
    } while (k !== null);
    expect(seen).toEqual([
      "pr",
      "issue",
      "doc",
      "thread",
      "file",
      "other",
      null,
    ]);
    const choices = projectChoices(rows());
    expect(choices).toEqual([null, 1, 2, "none"]);
    expect(nextProject("none", choices)).toBe(null);
    expect(nextProject(1, choices)).toBe(2);
    expect(rows().map(groupOf)).toEqual([null, 2, 1]);
  });
});

describe("from the store", () => {
  test("links, project docs, a task's PR and the brain docs, newest first", () => {
    ensureDocs();
    const project = store.createProject({
      name: "Riker",
      tmuxSession: "riker",
    });
    const task = store.createTask({
      title: "Fix",
      kind: Kind.coding,
      channel: "owner",
      projectId: project.id,
    });
    const home = store.homeTask();
    store.addTaskLink(home.id, "https://home.test/x", null, "you");
    store.linkThread(task.id, "github:o/r#9");
    const proof = join(paths.home(), "work", "proof.md");
    mkdirSync(dirname(proof), { recursive: true });
    writeFileSync(proof, "green");
    store.addTaskLink(
      task.id,
      proof,
      "Proof",
      `agent ${store.taskRef(task.id)}`,
    );
    store.addProjectLink(project.id, `file://${proof}`, null, "riker");
    const turn = store.addTurn({
      taskId: task.id,
      role: TurnRole.agent,
      body: "made it",
    });
    store.updateTurn(turn.id, {
      files: JSON.stringify([{ path: proof, name: "proof.md", bytes: 5 }]),
    });
    store.addNote("you", NoteLabel.note, "see https://note.test/n", task.id);
    const message = store.insertMessage({
      channel: "slack",
      externalId: "m1",
      threadKey: "slack:C1:1",
      author: "u",
      authorName: "Sam",
      title: "t",
      body: "ticket https://msg.test/m",
      receivedAt: new Date().toISOString(),
      meta: { channel: "slack" },
    })!;
    store.fileMessage(message.id, Verdict.task, "test", task.id);

    const rows = documents(store.documentSources());
    const byUrl = new Map(rows.map((r) => [r.url, r]));
    const file = byUrl.get(proof)!;
    expect(file.title).toBe("Proof");
    expect(file.owners.map((o) => o.source).sort()).toEqual(
      [DocSource.link, DocSource.projectLink].sort(),
    );
    expect(byUrl.get("https://github.com/o/r/pull/9")?.kind).toBe(DocKind.pr);
    expect(byUrl.has("https://note.test/n")).toBe(true);
    expect(byUrl.has("https://msg.test/m")).toBe(true);
    // Home's links are the Assistant's scratch, not the owner's documents.
    expect(byUrl.has("https://home.test/x")).toBe(false);
    const brain = byUrl.get(docPath(DocName.persona))!;
    expect(brain.owners[0].source).toBe(DocSource.brain);
    expect(brain.kind).toBe(DocKind.file);
    // Newest first, Riker's own docs after everything else.
    const own = rows.filter((r) => r.owners[0].source === DocSource.brain);
    const rest = rows.filter((r) => r.owners[0].source !== DocSource.brain);
    expect(rows).toEqual([...rest, ...own]);
    expect(rest.map((r) => r.at)).toEqual(
      rest
        .map((r) => r.at)
        .sort()
        .reverse(),
    );
  });
});
