import { beforeEach, describe, expect, test } from "bun:test";
import {
  BODY_CHARS,
  inboxCount,
  inboxRows,
  InboxFilter,
  InboxResult,
  inFilter,
  matchesQuery,
  nextFilter,
  shownBody,
  SUBJECT_CHARS,
  type InboxRow,
} from "../src/inbox";
import * as store from "../src/store";
import { IdeaStatus, Kind, MessageState, Verdict, type MessageRow } from "../src/types";
import { freshHome } from "./support/helpers";

beforeEach(() => freshHome());

let n = 0;
function message(extra: Partial<store.NewMessage> = {}): MessageRow {
  n++;
  return store.insertMessage({
    channel: "slack",
    externalId: `m${n}`,
    threadKey: `slack:C1:${n}`,
    author: "U2",
    authorName: "Sam",
    title: "DM with Sam",
    body: `message ${n}`,
    receivedAt: new Date(Date.UTC(2026, 10, 5, 10, n)).toISOString(),
    ...extra,
  })!;
}

function filed(verdict: Verdict | null, reason: string | null, task = false, extra: Partial<store.NewMessage> = {}) {
  const m = message(extra);
  const taskId = task
    ? store.createTask({ title: "t", kind: Kind.task, channel: "slack" }).id
    : null;
  store.fileMessage(m.id, verdict, reason, taskId);
  return store.getMessage(m.id)!;
}

// The model failed on it: given up (no retry left) unless retryAt says when.
function failedTriage(retryAt: string | null = null) {
  const m = filed(Verdict.fyi, "awaiting AI triage (timeout)");
  store.settleMessage(m.id, MessageState.failed, retryAt);
  return store.getMessage(m.id)!;
}

const byKey = (rows: InboxRow[]) => new Map(rows.map((r) => [r.key, r]));

describe("each row says where it went", () => {
  test("from what the message says now", () => {
    const made = filed(Verdict.task, "a direct ask", true);
    const joined = filed(null, "joined RIKER-0001", true);
    const fyi = filed(Verdict.fyi, "a bot");
    const failed = failedTriage();
    const retrying = failedTriage("2026-11-05T11:00:00.000Z");
    const greeting = filed(null, "a greeting; waits for the ask");
    const untriaged = message();
    const own = filed(null, "your own message", false, { fromMe: true });
    const rows = byKey(inboxRows());
    expect(rows.get(`m${made.id}`)!.result).toBe(InboxResult.task);
    expect(rows.get(`m${joined.id}`)!.result).toBe(InboxResult.attached);
    expect(rows.get(`m${fyi.id}`)!.result).toBe(InboxResult.fyi);
    expect(rows.get(`m${failed.id}`)!.result).toBe(InboxResult.failed);
    expect(rows.get(`m${retrying.id}`)!.result).toBe(InboxResult.failed);
    expect(rows.get(`m${greeting.id}`)!.result).toBe(InboxResult.greeting);
    expect(rows.get(`m${untriaged.id}`)!.result).toBe(InboxResult.untriaged);
    expect(rows.get(`m${own.id}`)!.result).toBe(InboxResult.own);
  });

  test("ideas, open or handled", () => {
    const open = store.addIdea("Follow up with Sam", "body", null);
    const done = store.addIdea("Old idea", "body", null);
    store.setIdeaStatus(done.id, IdeaStatus.dismissed);
    const rows = byKey(inboxRows());
    expect(rows.get(`i${open.id}`)).toMatchObject({ source: "advisor", result: InboxResult.idea });
    expect(rows.get(`i${done.id}`)!.result).toBe(InboxResult.dismissed);
  });

  test("newest first", () => {
    message();
    message();
    const rows = inboxRows();
    expect(rows[0]!.at > rows[1]!.at).toBe(true);
  });
});

describe("the badge counts what is on you", () => {
  test("open ideas and messages triage gave up on, and nothing else", () => {
    filed(Verdict.task, "a direct ask", true);
    filed(Verdict.fyi, "a bot");
    filed(null, "a greeting; waits for the ask");
    filed(null, "your own message", false, { fromMe: true });
    failedTriage();
    // The worker's still: one it has not reached, one it will retry.
    message();
    failedTriage("2026-11-05T11:00:00.000Z");
    store.addIdea("idea", "body", null);
    store.setIdeaStatus(store.addIdea("gone", "body", null).id, IdeaStatus.dismissed);
    expect(inboxCount()).toBe(2);
    expect(inboxRows().filter((r) => inFilter(r, InboxFilter.attention))).toHaveLength(2);
  });
});

describe("filters", () => {
  test("actionable leaves out your own messages, greetings, read FYIs and handled ideas", () => {
    filed(Verdict.task, "a direct ask", true);
    const readFyi = filed(Verdict.fyi, "a bot");
    store.markMessageRead(readFyi.id);
    filed(Verdict.fyi, "a newsletter");
    filed(null, "a greeting; waits for the ask");
    filed(null, "your own message", false, { fromMe: true });
    store.setIdeaStatus(store.addIdea("gone", "body", null).id, IdeaStatus.dismissed);
    const rows = inboxRows();
    const shown = rows.filter((r) => inFilter(r, InboxFilter.actionable)).map((r) => r.result);
    expect(shown.sort()).toEqual([InboxResult.fyi, InboxResult.task].sort());
    expect(rows.filter((r) => inFilter(r, InboxFilter.all))).toHaveLength(rows.length);
  });

  // AUG-0140: x reads any message, and a read one asks nothing more of you,
  // whatever triage did with it. Its task is untouched.
  test("a dismissed message leaves actionable, needs-you and the badge", () => {
    const made = filed(Verdict.task, "a direct ask", true);
    const joined = filed(null, "joined RIKER-0001", true);
    const failed = failedTriage();
    const untriaged = message();
    expect(inboxCount()).toBe(1);
    for (const m of [made, joined, failed, untriaged]) store.markMessageRead(m.id);
    const rows = inboxRows();
    expect(rows.filter((r) => inFilter(r, InboxFilter.actionable))).toHaveLength(0);
    expect(rows.filter((r) => inFilter(r, InboxFilter.attention))).toHaveLength(0);
    expect(inboxCount()).toBe(0);
    // Still under all, and what it made is still made.
    expect(rows.filter((r) => inFilter(r, InboxFilter.all))).toHaveLength(4);
    expect(rows.filter((r) => inFilter(r, InboxFilter.task))).toHaveLength(1);
    expect(store.getTask(made.task_id!)!.status).toBe("open");
    expect(store.getTask(joined.task_id!)!.status).toBe("open");
  });

  test("f cycles every filter and comes back", () => {
    let f: InboxFilter = InboxFilter.actionable;
    const seen = new Set<InboxFilter>();
    for (let i = 0; i < 5; i++) {
      seen.add(f);
      f = nextFilter(f);
    }
    expect(f).toBe(InboxFilter.actionable);
    expect(seen.size).toBe(5);
  });

  test("search reads subject, sender and source", () => {
    message({ body: "the payroll export drops transfers", authorName: "Erin" });
    const [row] = inboxRows();
    expect(matchesQuery(row!, "payroll")).toBe(true);
    expect(matchesQuery(row!, "erin")).toBe(true);
    expect(matchesQuery(row!, "slack")).toBe(true);
    expect(matchesQuery(row!, "github")).toBe(false);
  });
});

describe("private bodies stay short", () => {
  test("a subject is one line, capped", () => {
    message({ body: `${"x".repeat(200)}\nsecond line` });
    const [row] = inboxRows();
    expect(row!.subject.length).toBeLessThanOrEqual(SUBJECT_CHARS);
    expect(row!.subject).not.toContain("second line");
  });

  test("a GitHub row's subject is its title", () => {
    message({ channel: "github", title: "acme/api#12 issue: export drops transfers", body: "long body" });
    expect(inboxRows()[0]!.subject).toBe("acme/api#12 issue: export drops transfers");
  });

  test("the body is capped until revealed", () => {
    const body = "y".repeat(BODY_CHARS * 2);
    expect(shownBody(body, false).length).toBeLessThanOrEqual(BODY_CHARS);
    expect(shownBody(body, true)).toBe(body);
  });
});
