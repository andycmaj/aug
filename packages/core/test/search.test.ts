import { beforeEach, describe, expect, test } from "bun:test";
import { buildRail, type RailSection } from "../src/rail";
import { goToList, search, searchIndex } from "../src/search";
import * as store from "../src/store";
import { Kind, TaskStatus, TurnRole } from "../src/types";
import { freshHome } from "./support/helpers";

const NOW = new Date(Date.UTC(2026, 10, 10, 12));
const at = (h: number) => new Date(Date.UTC(2026, 10, 10, h)).toISOString();

function rail(): RailSection[] {
  return buildRail({
    tasks: store.listTasks(),
    pendingActions: new Set(),
    lastHeard: new Map(),
    now: NOW,
  });
}

function find(query: string) {
  const sections = rail();
  const ids = sections
    .flatMap((s) => s.items)
    .flatMap((i) => (i.type === "task" ? [i.task.id] : []));
  return search(
    searchIndex(sections, {
      messages: store.messagesForTasks(ids),
      turns: store.turnsForTasks(ids),
    }),
    query,
  );
}

const titles = (query: string) => find(query).map((h) => h.title);

function slackMessage(taskId: number, who: string, name: string, text: string) {
  const m = store.insertMessage({
    channel: "slack",
    externalId: `slack:C1:${Math.random()}`,
    threadKey: "slack:C1:1",
    author: who,
    authorName: name,
    title: "#eng",
    body: text,
    receivedAt: at(1),
  })!;
  store.fileMessage(m.id, "reply", "asked", taskId);
}

function githubMessage(taskId: number, login: string, repo: string, n: number) {
  const m = store.insertMessage({
    channel: "github",
    externalId: `gh:${Math.random()}`,
    threadKey: `github:${repo}#${n}`,
    author: login,
    authorName: login,
    title: `${repo}#${n} PR: something (review requested)`,
    body: "please look",
    url: `https://github.com/${repo}/pull/${n}`,
    receivedAt: at(1),
  })!;
  store.fileMessage(m.id, "reply", "review", taskId);
}

describe("search", () => {
  beforeEach(() => freshHome());

  test("matches the title, best when it begins it", () => {
    store.createTask({
      title: "Fix the deploy script",
      kind: Kind.task,
      channel: "owner",
      createdAt: at(1),
    });
    store.createTask({
      title: "Deploy the docs",
      kind: Kind.task,
      channel: "owner",
      createdAt: at(2),
    });
    store.createTask({
      title: "Write tests",
      kind: Kind.task,
      channel: "owner",
      createdAt: at(3),
    });
    expect(titles("deploy")).toEqual([
      "Deploy the docs",
      "Fix the deploy script",
    ]);
  });

  test("every word must match", () => {
    store.createTask({
      title: "Fix the deploy script",
      kind: Kind.task,
      channel: "owner",
    });
    store.createTask({
      title: "Deploy the docs",
      kind: Kind.task,
      channel: "owner",
    });
    expect(titles("deploy docs")).toEqual(["Deploy the docs"]);
  });

  test("a task number finds its task in any spelling", () => {
    for (let i = 0; i < 30; i++)
      store.createTask({
        title: `task ${i}`,
        kind: Kind.task,
        channel: "owner",
      });
    const want = store.listTasks().find((t) => t.id === 23)!.title;
    for (const q of ["RIKER-0023", "riker-23", "riker23", "23", "0023"])
      expect(titles(q)[0]).toBe(want);
    // Explicit RIKER-: only refs, never a number in the words.
    expect(titles("riker-23")).toEqual([want]);
  });

  test("tasks off the open list (For later, watching) are found too, once", () => {
    const later = store.createTask({
      title: "Renew the cert",
      kind: Kind.task,
      channel: "owner",
    });
    store.remindAt(later.id, "2026-12-01T00:00:00.000Z");
    const watched = store.createTask({
      title: "Cert rollout",
      kind: Kind.task,
      channel: "owner",
    });
    store.setWatching(watched.id, true);
    const hits = find("cert");
    // Watched, it is listed under Watching too, and found at its own row.
    expect(hits.map((h) => [h.title, h.section]).sort()).toEqual([
      ["Cert rollout", "Tasks"],
      ["Renew the cert", "For later"],
    ]);
    expect(store.getTask(later.id)!.status).toBe(TaskStatus.later);
  });

  test("@someone finds threads a Slack user wrote on, by name or id", () => {
    const a = store.createTask({
      title: "Answer about budget",
      kind: Kind.reply,
      channel: "slack",
    });
    store.createTask({
      title: "Jane's offsite",
      kind: Kind.task,
      channel: "owner",
    });
    slackMessage(a.id, "U123", "Jane Doe", "what's the budget?");
    expect(find("@jane").map((h) => [h.title, h.why])).toEqual([
      ["Answer about budget", "slack Jane Doe"],
    ]);
    expect(titles("@u123")).toEqual(["Answer about budget"]);
    // Without the @ a name in the title counts too, ahead of the person.
    expect(titles("jane")).toEqual(["Jane's offsite", "Answer about budget"]);
  });

  test("@login finds GitHub threads; #N finds the PR", () => {
    const a = store.createTask({
      title: "Review the parser",
      kind: Kind.reply,
      channel: "github",
    });
    const b = store.createTask({
      title: "Review the lexer",
      kind: Kind.reply,
      channel: "github",
    });
    githubMessage(a.id, "octocat", "acme/app", 412);
    githubMessage(b.id, "hubot", "acme/app", 7);
    expect(find("@octo").map((h) => [h.title, h.why])).toEqual([
      ["Review the parser", "github @octocat"],
    ]);
    expect(find("#412").map((h) => [h.title, h.why])).toEqual([
      ["Review the parser", "acme/app#412"],
    ]);
    expect(titles("app#7")).toEqual(["Review the lexer"]);
  });

  test("whom a task waits on is a person", () => {
    const t = store.createTask({
      title: "Contract",
      kind: Kind.task,
      channel: "owner",
    });
    store.updateTask(t.id, { waiting_on: "Sam" });
    expect(find("@sam").map((h) => h.why)).toEqual(["waiting on Sam"]);
  });

  test("content is found below the title, with what matched", () => {
    store.createTask({
      title: "Outage",
      kind: Kind.task,
      channel: "owner",
      summary: "the redis pool runs dry",
    });
    store.createTask({
      title: "Redis upgrade",
      kind: Kind.task,
      channel: "owner",
    });
    expect(find("redis").map((h) => [h.title, h.why])).toEqual([
      ["Redis upgrade", null],
      ["Outage", "summary"],
    ]);
  });

  test("the chat is found last, quoted where it hit", () => {
    const chat = store.createTask({
      title: "Payroll",
      kind: Kind.general,
      channel: "owner",
      createdAt: at(1),
    });
    const turn = store.addTurn({
      taskId: chat.id,
      role: TurnRole.agent,
      body: "raw",
    });
    store.updateTurn(turn.id, {
      did: "Compared Gusto and Rippling; Rippling supports same-day pay in all states",
    });
    store.addTurn({
      taskId: chat.id,
      role: TurnRole.you,
      body: "what about Deel?",
    });
    store.createTask({
      title: "Rippling contract",
      kind: Kind.task,
      channel: "owner",
      createdAt: at(2),
    });
    store.createTask({
      title: "HR",
      kind: Kind.task,
      channel: "owner",
      summary: "move to Rippling",
      createdAt: at(3),
    });
    expect(find("rippling").map((h) => [h.title, h.why])).toEqual([
      ["Rippling contract", null],
      ["HR", "summary"],
      ["Payroll", 'agent: "…Gusto and Rippling; Rippling…"'],
    ]);
    expect(find("deel").map((h) => h.why)).toEqual(['you: "what about Deel?"']);
  });

  test("Riker's own notes in the chat are not searched", () => {
    const t = store.createTask({
      title: "Payroll",
      kind: Kind.general,
      channel: "owner",
    });
    store.addTurn({
      taskId: t.id,
      role: TurnRole.trigger,
      body: "Reminded today",
    });
    expect(find("reminded")).toEqual([]);
  });
});

describe("go-to list", () => {
  beforeEach(() => freshHome());

  function docs() {
    const sections = rail();
    return searchIndex(sections, { messages: new Map(), turns: new Map() });
  }

  test("with nothing typed, recent rows come first, then the rest", () => {
    const [a, b, c] = ["Alpha", "Bravo", "Charlie"].map((title) =>
      store.createTask({ title, kind: Kind.task, channel: "owner" }),
    );
    const list = goToList(docs(), "", [`t${c.id}`, "t9999", `t${a.id}`]);
    expect(list.slice(0, 2).map((h) => [h.recent, h.title])).toEqual([
      [true, "Charlie"],
      [true, "Alpha"],
    ]);
    const rest = list.slice(2).map((h) => h.title);
    expect(rest).toContain("Bravo");
    expect(rest).not.toContain("Alpha");
    expect(rest).not.toContain("Charlie");
    expect(list.slice(2).every((h) => h.recent === undefined)).toBe(true);
    void b;
  });

  test("done and dropped work is found by what is typed, after the rail, never listed bare", () => {
    const open = store.createTask({ title: "Guide review", kind: Kind.task, channel: "owner" });
    const gone = store.createTask({ title: "Guide findings", kind: Kind.task, channel: "owner" });
    store.updateTask(gone.id, { status: TaskStatus.dropped, closed_at: at(9), closed_by: "you" });
    const all = () =>
      searchIndex(rail(), { messages: new Map(), turns: new Map() }, store.closedTasks());
    expect(goToList(all(), "", []).map((h) => h.title)).not.toContain("Guide findings");
    expect(goToList(all(), "guide", []).map((h) => [h.title, h.section])).toEqual([
      ["Guide review", "Tasks"],
      ["Guide findings", "Dropped"],
    ]);
    expect(goToList(all(), store.taskRef(gone.id), []).map((h) => h.item.key)).toEqual([
      `t${gone.id}`,
    ]);
    void open;
  });

  test("typing searches, recent or not", () => {
    const a = store.createTask({ title: "Alpha", kind: Kind.task, channel: "owner" });
    store.createTask({ title: "Bravo", kind: Kind.task, channel: "owner" });
    const list = goToList(docs(), "bravo", [`t${a.id}`]);
    expect(list.map((h) => [h.recent, h.title])).toEqual([[undefined, "Bravo"]]);
  });
});
