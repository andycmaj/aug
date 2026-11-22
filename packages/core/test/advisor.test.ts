import { beforeEach, describe, expect, test } from "bun:test";
import { pastIdeas, PAST_IDEAS_DAYS, runAdvisor } from "../src/advisor";
import { db } from "../src/db";
import * as store from "../src/store";
import { IdeaStatus, Kind } from "../src/types";
import { config, fakeBrain, freshHome } from "./support/helpers";

const AT = new Date("2026-11-21T12:00:00Z");

function task(title: string): number {
  return store.createTask({ title, kind: Kind.task, channel: "owner" }).id;
}

function ideaAt(
  title: string,
  taskId: number | null,
  status: IdeaStatus,
  daysAgo: number,
): number {
  const idea = store.addIdea(title, "body", taskId);
  store.setIdeaStatus(idea.id, status);
  const when = new Date(AT.getTime() - daysAgo * 86400000).toISOString();
  db().run("UPDATE ideas SET created_at = ? WHERE id = ?", [when, idea.id]);
  return idea.id;
}

describe("the Advisor remembers what it already said", () => {
  beforeEach(() => freshHome());

  test("the prompt lists the last 30 days of ideas with their outcome", async () => {
    const renewal = task("Renewal for Acme");
    const made = task("Chase the invoice");
    ideaAt("Ping Acme on the renewal", renewal, IdeaStatus.dismissed, 3);
    const tasked = ideaAt("Chase the invoice", null, IdeaStatus.tasked, 5);
    store.ideaTasked(tasked, made);
    ideaAt("Old and gone", null, IdeaStatus.dismissed, PAST_IDEAS_DAYS + 1);
    ideaAt("Old but still open", null, IdeaStatus.open, PAST_IDEAS_DAYS + 5);
    const calls = fakeBrain(() => ({ ideas: [] }));
    await runAdvisor(config(), AT, true);
    const prompt = calls[0].prompt;
    expect(prompt).toContain(
      `[dismissed, 2026-11-18] Ping Acme on the renewal (about ${store.taskRef(renewal)})`,
    );
    expect(prompt).toContain(`[approved as ${store.taskRef(made)}, 2026-11-16] Chase the invoice`);
    expect(prompt).toContain("[open in the Inbox, 2026-10-17] Old but still open");
    expect(prompt).not.toContain("Old and gone");
    expect(calls[0].system).toContain("dismissed means the owner does not want it");
  });

  test("an idea about a task whose idea was dismissed is refused, under any title", async () => {
    const renewal = task("Renewal for Acme");
    const other = task("Hiring loop");
    ideaAt("Ping Acme on the renewal", renewal, IdeaStatus.dismissed, 10);
    fakeBrain(() => ({
      ideas: [
        { title: "Acme renewal is slipping", body: "b", task: store.taskRef(renewal) },
        { title: "Hiring loop has no owner", body: "b", task: store.taskRef(other) },
      ],
    }));
    expect((await runAdvisor(config(), AT, true)).added).toBe(1);
    expect(store.openIdeas().map((i) => i.title)).toEqual(["Hiring loop has no owner"]);
  });

  test("a dismissal older than the window no longer holds its task back", async () => {
    const renewal = task("Renewal for Acme");
    ideaAt("Ping Acme on the renewal", renewal, IdeaStatus.dismissed, PAST_IDEAS_DAYS + 2);
    fakeBrain(() => ({
      ideas: [{ title: "Acme renewal is slipping", body: "b", task: store.taskRef(renewal) }],
    }));
    expect((await runAdvisor(config(), AT, true)).added).toBe(1);
  });

  test("a repeated title is refused whatever became of it, and within one answer", async () => {
    ideaAt("Chase the invoice", null, IdeaStatus.tasked, 2);
    ideaAt("Book the offsite", null, IdeaStatus.open, 1);
    fakeBrain(() => ({
      ideas: [
        { title: "chase the invoice", body: "b" },
        { title: "Book the offsite ", body: "b" },
        { title: "Write the recap", body: "b" },
        { title: "Write the recap", body: "b" },
      ],
    }));
    expect((await runAdvisor(config(), AT, true)).added).toBe(1);
    expect(pastIdeas(AT).map((i) => i.title)).toEqual([
      "Chase the invoice",
      "Book the offsite",
      "Write the recap",
    ]);
  });
});
