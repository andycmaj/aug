import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, openDb, TABLES, Table, tableVersions, useDb } from "../src/db";
import { readModel, readTables, type ReadModel, type ReadName } from "../src/read-model";
import * as store from "../src/store";
import {
  Kind,
  NoteLabel,
  ProposalSource,
  SessionKind,
  SpendRole,
  TurnRole,
  Verdict,
  type TaskRow,
} from "../src/types";
import { DEFAULT_CONFIG } from "../src/config";
import { localDay } from "../src/rail";
import { freshHome } from "./support/helpers";

beforeEach(() => freshHome());

function task(title: string, extra: Partial<store.NewTask> = {}): TaskRow {
  return store.createTask({ title, kind: Kind.general, channel: "owner", ...extra });
}

function changedTables(before: Record<Table, number>): Table[] {
  const after = tableVersions();
  return TABLES.filter((t) => after[t] !== before[t]);
}

describe("table versions", () => {
  test("every table in the schema is tracked", () => {
    const rows = db()
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'table_versions'",
      )
      .all() as { name: string }[];
    expect(rows.map((r) => r.name).sort()).toEqual([...TABLES].sort());
  });

  test("a write bumps only the table it touched", () => {
    const t = task("one");
    let before = tableVersions();
    store.addNote("you", NoteLabel.note, "hi");
    expect(changedTables(before)).toEqual([Table.notes]);

    before = tableVersions();
    store.updateTask(t.id, { title: "renamed" });
    expect(changedTables(before)).toEqual([Table.tasks]);

    before = tableVersions();
    store.addTaskLink(t.id, "https://example.com", null, "you");
    store.removeTaskLink(t.id, "https://example.com");
    expect(changedTables(before)).toEqual([Table.taskLinks]);
  });

  test("a write from another connection shows in this one's versions", () => {
    const file = join(mkdtempSync(join(tmpdir(), "riker-tv-")), "riker.db");
    const mine = openDb(file);
    const theirs = openDb(file);
    useDb(mine);
    const before = tableVersions();
    theirs
      .query("INSERT INTO hub (topic, title, body, author, created_at) VALUES ('t', 't', 'b', 'agent', 'now')")
      .run();
    expect(changedTables(before)).toEqual([Table.knowledge]);
    mine.close();
    theirs.close();
  });
});

describe("read model", () => {
  test("a read tracks its tables before it queries", () => {
    const tracked: Table[][] = [];
    const reads = readModel((tables) => tracked.push([...tables]), { isLive: () => false });
    const t = task("one");
    reads.turns(t.id);
    reads.task(t.id);
    expect(tracked).toEqual([[Table.turns], [Table.tasks]]);
  });

  // Each read's declared tables must cover every table its SQL reads, or a
  // write there would leave the view stale.
  test("every read declares the tables its queries touch", () => {
    const project = store.createProject({ name: "p", tmuxSession: "p" });
    const goal = store.addGoal(project.id, "ship");
    const plain = task("plain", { projectId: project.id, threadKey: "slack:C1:1", goalId: goal.id });
    const withPr = task("pr", {
      projectId: project.id,
      threadKey: "github:o/r#7",
      url: "https://github.com/o/r/pull/7",
    });
    const bare = task("bare");
    store.linkThread(plain.id, "github:o/r#8");
    const message = store.insertMessage({
      channel: "github",
      externalId: "m1",
      threadKey: "github:o/r#7",
      author: "a",
      authorName: "A",
      title: "t",
      body: "b",
      receivedAt: new Date().toISOString(),
      meta: { channel: "github", type: "PullRequest" },
    })!;
    store.fileMessage(message.id, Verdict.task, "test", withPr.id);
    store.addTurn({ taskId: plain.id, role: TurnRole.agent, body: "hi" });
    store.createSession({ id: "s1", taskId: plain.id, kind: SessionKind.tmux, cwd: "/", startedBy: "riker" });
    store.addTaskLink(plain.id, "https://example.com", null, "you");
    store.addProjectLink(project.id, "https://example.com/doc", null, "you");
    store.addProposal({ taskId: plain.id, doc: "PERSONA.md", source: ProposalSource.evolve, base: "", proposed: "x" });
    store.addIdea("idea", "body", plain.id);
    store.addNote("you", NoteLabel.note, "hi");
    store.addKnowledge("t", "t", "b", "you");
    store.addWin(localDay(new Date()), plain.id);
    store.addSpend({ day: localDay(new Date()), taskId: plain.id, role: SpendRole.general, model: "sonnet", costUsd: 0.1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0 });

    const queried: string[] = [];
    const d = db();
    const query = d.query.bind(d);
    d.query = ((sql: string) => {
      queried.push(sql);
      return query(sql);
    }) as typeof d.query;
    const reads = readModel(() => {}, { isLive: () => false });
    const pending = reads.tasksWithPendingAction();
    const calls: Record<ReadName, (r: ReadModel) => unknown> = {
      home: (r) => r.home(),
      task: (r) => r.task(plain.id),
      tasksForProject: (r) => r.tasksForProject(project.id),
      tasksWithPendingAction: (r) => r.tasksWithPendingAction(),
      turns: (r) => r.turns(plain.id),
      pendingAction: (r) => r.pendingAction(plain.id),
      latestActionTurns: (r) => r.latestActionTurns(),
      messages: (r) => r.messages(withPr.id),
      message: (r) => r.message(message.id),
      taskLinks: (r) => r.taskLinks(plain.id),
      story: (r) => r.story(plain.id),
      latestSession: (r) => r.latestSession(plain.id),
      isLive: (r) => r.isLive(plain),
      prStatus: (r) => r.prStatus(withPr.id),
      taskPr: (r) => [r.taskPr(plain), r.taskPr(withPr), r.taskPr(bare)],
      taskPrStatus: (r) => [r.taskPrStatus(plain), r.taskPrStatus(bare)],
      unmergedPr: (r) => [r.unmergedPr(plain), r.unmergedPr(bare)],
      briefEditable: (r) => r.briefEditable(plain.id),
      proposals: (r) => r.proposals(plain.id),
      project: (r) => r.project(project.id),
      projects: (r) => r.projects(),
      projectLinks: (r) => r.projectLinks(project.id),
      projectSummary: (r) => r.projectSummary(project),
      projectProgress: (r) => r.projectProgress(project),
      knowledge: (r) => r.knowledge(),
      notes: (r) => r.notes(),
      searchSources: (r) => r.searchSources([plain.id, withPr.id]),
      closedTasks: (r) => r.closedTasks(),
      rail: (r) => r.rail(new Date(), pending),
      board: (r) => r.board(pending),
      blockers: (r) => r.blockers(plain.id),
      wins: (r) => r.wins("2026-11-15"),
      inbox: (r) => r.inbox(),
      inboxCount: (r) => r.inboxCount(),
      inboxRuns: (r) => r.inboxRuns(message.id),
      spendOn: (r) => r.spendOn("2026-11-15"),
      taskSpend: (r) => r.taskSpend(plain.id),
      spendReport: (r) => r.spendReport(DEFAULT_CONFIG, new Date()),
      winsDay: (r) => [r.winsDay(localDay(new Date()), new Date()), r.winsDay("2026-11-15", new Date())],
      winDetail: (r) => [r.winDetail(plain.id, localDay(new Date())), r.winDetail(withPr.id, localDay(new Date()))],
    };
    const known = new Set<string>(TABLES);
    for (const [name, call] of Object.entries(calls) as [ReadName, (r: ReadModel) => unknown][]) {
      queried.length = 0;
      call(reads);
      const touched = new Set(
        queried.flatMap((sql) =>
          [...sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+(\w+)/gi)]
            .map((m) => m[1]!)
            .filter((t) => known.has(t)),
        ),
      );
      // Reads that create a missing row (home) write; the write is not a read.
      // The fake desk's isLive asks nothing of the database.
      if (name !== "isLive") expect({ read: name, queried: queried.length > 0 }).toEqual({ read: name, queried: true });
      const writes = queried.some((q) => /^\s*(INSERT|UPDATE|DELETE)/i.test(q));
      if (name !== "home") expect({ read: name, writes }).toEqual({ read: name, writes: false });
      for (const table of touched)
        expect({ read: name, table, declared: readTables(name).includes(table as Table) }).toEqual({
          read: name,
          table,
          declared: true,
        });
    }
    d.query = query;
  });
});
