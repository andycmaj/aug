// AUG-0140: a task is made without the owner only when an escalation rule
// names the message (triage.escalate); other work waits in the Inbox, and
// m makes it a task. Joined messages fold into one Inbox row per task.

import { beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, mergeConfig } from "../src/core/config";
import { Engine } from "../src/core/engine";
import { inboxCount, inboxRows, InboxFilter, InboxResult, inFilter, rowMessages } from "../src/core/inbox";
import { setMux } from "../src/core/mux";
import { polledToRaw } from "../src/core/slack/claude-mcp";
import { rawToNewMessage } from "../src/core/slack/shared";
import * as store from "../src/core/store";
import { escalation, triage } from "../src/core/triage";
import { Kind, type MessageRow } from "../src/core/types";
import { FakeMux } from "./fake-mux";
import { config, fakeBrain, freshHome, testConfig } from "./helpers";

let n = 0;
function gh(meta: Record<string, unknown>, body = "please take a look"): MessageRow {
  n++;
  return store.insertMessage({
    channel: "github",
    externalId: `gh:esc:${n}`,
    threadKey: `github:acme/web#${n}`,
    author: "devon",
    authorName: "devon",
    title: `acme/web#${n} PR: Add a toggle`,
    body,
    receivedAt: new Date(Date.UTC(2026, 10, 5, 9, n)).toISOString(),
    meta: { repo: "acme/web", number: n, type: "PullRequest", ...meta },
  })!;
}

function slack(meta: Record<string, unknown>, body = "can someone check the cutoff?"): MessageRow {
  n++;
  return store.insertMessage({
    channel: "slack",
    externalId: `slack:C5:${n}`,
    threadKey: meta.dm ? `slack:D5:dm` : `slack:C5:${n}.0`,
    author: "U3",
    authorName: "Priya",
    title: "#payments",
    body,
    receivedAt: new Date(Date.UTC(2026, 10, 5, 10, n)).toISOString(),
    meta: { channel: "C5", ts: `${n}.0`, ...meta },
  })!;
}

const work = () =>
  fakeBrain(() => ({
    verdict: "coding",
    title: "Review the toggle PR",
    summary: "A PR waits on a review.",
    priority: "important",
    reason: "a review",
  }));

const rules = (extra: Partial<typeof DEFAULT_CONFIG.triage.escalate> = {}) => ({
  ...DEFAULT_CONFIG.triage.escalate,
  ...extra,
});
// github.reviewTeams: none watched unless a test says.
const none: string[] = [];

describe("what escalates", () => {
  beforeEach(() => freshHome());

  test("GitHub: assigned, mentioned or asked to review by name", () => {
    expect(escalation(gh({ reason: "assign" }), rules(), none)).toBe("assigned to you");
    expect(escalation(gh({ reason: "mention" }), rules(), none)).toBe("mentions you");
    expect(escalation(gh({ reason: "review_requested", requested: { me: true, teams: [] } }), rules(), none)).toBe(
      "review requested of you",
    );
    // Who was asked is unknown (the item read was a comment): it escalates.
    expect(escalation(gh({ reason: "review_requested" }), rules(), none)).toBe("review requested of you");
    expect(escalation(gh({ reason: "comment" }), rules(), none)).toBeNull();
    expect(escalation(gh({ reason: "author" }), rules(), none)).toBeNull();
  });

  // On a PR these are the review ask rule's; on an issue they reach here.
  test("GitHub: a team's review request or tag only for a team in github.reviewTeams", () => {
    const teamAsked = gh({ reason: "review_requested", requested: { me: false, teams: ["acme/payroll"] } });
    expect(escalation(teamAsked, rules(), none)).toBeNull();
    expect(escalation(teamAsked, rules(), ["acme/payroll"])).toBe("review requested of acme/payroll");
    const teamMention = gh({ reason: "team_mention", type: "Issue" }, "@acme/payroll can you check this?");
    expect(escalation(teamMention, rules(), none)).toBeNull();
    expect(escalation(teamMention, rules(), ["payroll"])).toBe("mentions acme/payroll");
    expect(escalation(teamMention, rules(), ["acme/infra"])).toBeNull();
  });

  test("Slack: a DM or a mention of you", () => {
    expect(escalation(slack({ dm: true }), rules(), none)).toBe("a DM to you");
    expect(escalation(slack({ mention: true }), rules(), none)).toBe("mentions you");
    expect(escalation(slack({}), rules(), none)).toBeNull();
    expect(escalation(slack({ mention: true }), rules({ slack: ["dm"] }), none)).toBeNull();
  });

  test("a partial escalate in config keeps the other defaults", () => {
    const merged = mergeConfig({ triage: { escalate: { slack: ["dm"] } } } as never);
    expect(merged.triage.escalate).toEqual({ ...DEFAULT_CONFIG.triage.escalate, slack: ["dm"] });
    expect(merged.triage.noise).toEqual(DEFAULT_CONFIG.triage.noise);
  });
});

describe("work no rule names is held for you", () => {
  beforeEach(() => freshHome());

  test("the model calls it work, but no task is made", async () => {
    work();
    const m = gh({ reason: "comment" });
    const out = await triage(m, { config: config() });
    expect(out).toMatchObject({ verdict: "held", taskId: null });
    expect(store.listTasks()).toHaveLength(0);
    const row = inboxRows().find((r) => r.key === `m${m.id}`)!;
    expect(row.result).toBe(InboxResult.held);
    expect(inFilter(row, InboxFilter.attention)).toBe(true);
    expect(inboxCount()).toBe(1);
    const [run] = store.triageRunsFor(m.id);
    expect(run!.rule).toBe("escalation");
  });

  test("an escalated one still becomes a task", async () => {
    work();
    const out = await triage(gh({ reason: "review_requested" }), { config: config() });
    expect(out.verdict).toBe("coding");
    expect(out.taskId).not.toBeNull();
  });

  test("m makes the task its verdict describes, and it leaves needs-you", async () => {
    setMux(new FakeMux());
    const engine = new Engine({ config: testConfig() });
    work();
    const m = gh({ reason: "comment" });
    await triage(m, { config: config() });
    const task = engine.desk.heldToTask(m.id)!;
    expect(task.title).toBe("Review the toggle PR");
    expect(task.kind).toBe(Kind.coding);
    expect(task.priority).toBe("important");
    const row = inboxRows().find((r) => r.key === `m${m.id}`)!;
    expect(row.result).toBe(InboxResult.task);
    expect(row.taskId).toBe(task.id);
    expect(inboxCount()).toBe(0);
  });
});

describe("joined messages fold into one row per task", () => {
  beforeEach(() => freshHome());

  test("the newest carries the rest, and is read only when all are", () => {
    const task = store.createTask({ title: "t", kind: Kind.task, channel: "slack" });
    const joined = [1, 2, 3].map(() => {
      const m = slack({ mention: true });
      store.fileMessage(m.id, null, `joined ${store.taskRef(task.id)}`, task.id);
      return m;
    });
    const other = slack({ dm: true });
    const rows = inboxRows().filter((r) => r.type === "message" && r.result === InboxResult.attached);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row!.key).toBe(`m${joined[2]!.id}`);
    expect(rowMessages(row!).map((m) => m.id)).toEqual(joined.map((m) => m.id).reverse());
    expect(inboxRows().some((r) => r.key === `m${other.id}`)).toBe(true);

    store.markMessageRead(joined[2]!.id);
    expect(inboxRows().find((r) => r.key === row!.key)!.read).toBe(false);
    for (const m of joined) store.markMessageRead(m.id);
    const read = inboxRows().find((r) => r.key === row!.key)!;
    expect(read.read).toBe(true);
    expect(inFilter(read, InboxFilter.actionable)).toBe(false);
  });
});

describe("ingest says who was asked", () => {
  test("a Slack message that mentions you says so, from either transport", () => {
    const raw = polledToRaw({
      channel: "C1",
      is_dm: false,
      ts: "1.0",
      user_name: "Priya",
      text: "@me can you check?",
      from_me: false,
      mentions_me: true,
    });
    expect(rawToNewMessage(raw).meta).toMatchObject({ mention: true });
    expect(rawToNewMessage({ ...raw, mentionsMe: undefined }).meta).toMatchObject({ mention: false });
  });
});
