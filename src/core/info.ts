// What I shows: everything aug knows about a rail item, as labeled rows
// under headings. Empty facts are left out, so a fresh to-do reads short.

import { existsSync } from "node:fs";
import { parseFiles } from "./files";
import { LANE_META, type Lane } from "./lanes";
import { paths } from "./paths";
import { ageLabel, type RailItem } from "./rail";
import * as store from "./store";
import type { MessageRow, TaskRow } from "./types";

export interface InfoRow {
  label: string;
  value: string;
}

export interface InfoSection {
  title: string;
  rows: InfoRow[];
}

function when(iso: string | null, now: Date): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const stamp = d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const age = ageLabel(iso, now);
  return `${stamp} (${age.startsWith("in ") ? age : `${age} ago`})`;
}

function section(
  title: string,
  pairs: [string, string | number | null | undefined][],
): InfoSection {
  return {
    title,
    rows: pairs
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([label, v]) => ({ label, value: String(v) })),
  };
}

function messageRows(m: MessageRow, now: Date): InfoSection {
  return section("Message", [
    ["from", m.from_me ? `${m.author_name} (you)` : m.author_name],
    ["channel", m.channel],
    ["title", m.title],
    ["received", when(m.received_at, now)],
    ["verdict", m.verdict],
    ["why", m.reason],
    ["read", when(m.read_at, now)],
    ["url", m.url],
    ["thread", m.thread_key],
    ["external id", m.external_id],
    ["meta", m.meta === "{}" ? null : m.meta],
  ]);
}

function taskSections(
  task: TaskRow,
  lane: Lane,
  now: Date,
): InfoSection[] {
  const messages = store.messagesForTask(task.id);
  const turns = store.turnsForTask(task.id);
  const sessions = store.sessionsForTask(task.id);
  const files = new Set(turns.flatMap((t) => parseFiles(t.files).map((f) => f.path)));
  const work = paths.work(task.id);
  const last = messages.at(-1);
  const latest = sessions[0];

  return [
    section("Task", [
      ["ref", store.taskRef(task.id)],
      ["title", task.title],
      ["kind", task.kind],
      ["status", task.status],
      ["lane", LANE_META[lane].word],
      ["priority", task.priority_pinned ? `${task.priority} (set by you)` : task.priority],
      ["watching", task.watching ? "yes" : null],
      ["waiting on", task.waiting_on],
      ["remind", when(task.remind_at, now)],
      ["created", when(task.created_at, now)],
      ["updated", when(task.updated_at, now)],
      ["closed", task.closed_at ? `${when(task.closed_at, now)} by ${task.closed_by ?? "?"}` : null],
    ]),
    section("Source", [
      ["channel", task.channel],
      ["repo", task.repo],
      ["url", task.url],
      ["thread", task.thread_key],
      ["triage", task.triage_reason],
      ["messages", messages.length || null],
      ["last heard", last ? `${last.author_name}, ${when(last.received_at, now)}` : null],
    ]),
    section("Agent", [
      ["state", task.agent_state === "none" ? null : task.agent_state],
      ["says", task.agent_says],
      ["queued", task.queue_reason],
      ["turns", turns.length || null],
      ["sessions", sessions.length || null],
      ["session", latest?.id],
      ["session kind", latest?.kind],
      ["cwd", latest?.cwd],
      ["last tool", latest?.last_tool],
      ["started", when(latest?.started_at ?? null, now)],
      ["ended", when(latest?.ended_at ?? null, now)],
      ["work dir", existsSync(work) ? work : null],
      ["files made", files.size || null],
    ]),
  ].filter((s) => s.rows.length > 0);
}

export function itemInfo(item: RailItem, now = new Date()): InfoSection[] {
  switch (item.type) {
    case "task": {
      const fresh = store.getTask(item.task.id) ?? item.task;
      return taskSections(fresh, item.lane, now);
    }
    case "fyi":
      return [messageRows(item.message, now)];
    case "idea":
      return [
        section("Advisor idea", [
          ["title", item.idea.title],
          ["status", item.idea.status],
          ["about", item.idea.task_id ? store.taskRef(item.idea.task_id) : null],
          ["created", when(item.idea.created_at, now)],
          ["body", item.idea.body],
        ]),
      ];
  }
}

export function infoTitle(item: RailItem): string {
  if (item.type === "task") return `${store.taskRef(item.task.id)} · ${item.task.title}`;
  if (item.type === "fyi") return `FYI from ${item.message.author_name}`;
  return item.idea.title;
}
