import { beforeEach, describe, expect, test } from "bun:test";
import { buildRail, type RailSection } from "../src/core/rail";
import { search, searchIndex } from "../src/core/search";
import * as store from "../src/core/store";
import { Kind, TaskStatus } from "../src/core/types";
import { freshHome } from "./helpers";

const NOW = new Date(Date.UTC(2026, 10, 10, 12));
const at = (h: number) => new Date(Date.UTC(2026, 10, 10, h)).toISOString();

function rail(): RailSection[] {
  return buildRail({
    tasks: store.listTasks(),
    pendingActions: new Set(),
    ideas: store.openIdeas(),
    fyi: store.fyiMessages(at(0)),
    lastHeard: new Map(),
    now: NOW,
  });
}

function find(query: string) {
  const sections = rail();
  const ids = sections
    .flatMap((s) => s.items)
    .flatMap((i) => (i.type === "task" ? [i.task.id] : []));
  return search(searchIndex(sections, store.messagesForTasks(ids)), query);
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
    for (const q of ["AUG-0023", "aug-23", "aug23", "23", "0023"])
      expect(titles(q)[0]).toBe(want);
    // Explicit AUG-: only refs, never a number in the words.
    expect(titles("aug-23")).toEqual([want]);
  });

  test("tasks off the open list (For later, watching) are found too", () => {
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
    expect(hits.map((h) => [h.title, h.section]).sort()).toEqual([
      ["Cert rollout", "Watching"],
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

  test("ideas and FYI are on the rail and found", () => {
    store.addIdea("Batch the Slack polls", "they arrive in bursts", null);
    const m = store.insertMessage({
      channel: "slack",
      externalId: "slack:C2:9",
      threadKey: "slack:C2:9",
      author: "U9",
      authorName: "Lee",
      title: "#general",
      body: "lunch is here",
      receivedAt: at(2),
    })!;
    store.fileMessage(m.id, "fyi", "chatter", null);
    expect(find("bursts").map((h) => [h.section, h.why])).toEqual([
      ["Advisor", "idea"],
    ]);
    expect(find("@lee").map((h) => h.section)).toEqual(["FYI"]);
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
});
