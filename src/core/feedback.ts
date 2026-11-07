// What came back on a coding task's threads (reviews, comments, CI) since its
// agent last looked. The agent pulls it with `aug-tools feedback`; aug only
// ever nudges it, one press at a time, never pastes it in.

import { toolsCommand } from "./self";
import * as store from "./store";
import type { MessageRow } from "./types";

export function parsePrUrl(url: string): { repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

export function linkPr(taskId: number, url: string): string | null {
  const pr = parsePrUrl(url);
  const task = store.getTask(taskId);
  if (!pr || !task) return null;
  const key = `github:${pr.repo}#${pr.number}`;
  if (task.thread_key !== key) store.linkThread(taskId, key);
  if (!task.url) store.updateTask(taskId, { url });
  return key;
}

const cursorKey = (taskId: number) => `feedback.${taskId}`;

// Linked threads count from their start; the task's own thread only from
// when its first agent started, since the agent's brief already holds the ask.
export function unreadFeedback(taskId: number): MessageRow[] {
  const task = store.getTask(taskId);
  if (!task) return [];
  const after = Number(store.kvGet(cursorKey(taskId)) ?? 0);
  const started = store.sessionsForTask(taskId).at(-1)?.started_at ?? task.created_at;
  const out: MessageRow[] = [];
  for (const key of store.threadsForTask(taskId)) {
    const own = key === task.thread_key;
    for (const m of store.messagesForThread(key)) {
      if (m.from_me || m.id <= after) continue;
      if (own && m.received_at < started) continue;
      out.push(m);
    }
  }
  return out.sort((a, b) => a.received_at.localeCompare(b.received_at));
}

export function markFeedbackRead(taskId: number, messages: MessageRow[]): void {
  const last = Math.max(0, ...messages.map((m) => m.id));
  if (last) store.kvSet(cursorKey(taskId), String(last));
}

export function formatFeedback(messages: MessageRow[]): string {
  if (messages.length === 0) return "No new feedback.";
  return messages
    .map(
      (m) =>
        `[${m.received_at.slice(0, 16).replace("T", " ")}] ${m.author_name} on ${m.title}\n${m.body}${m.url ? `\n${m.url}` : ""}`,
    )
    .join("\n\n");
}

export function nudgeText(taskId: number): string {
  const n = unreadFeedback(taskId).length;
  const what = n === 1 ? "1 new comment" : n > 1 ? `${n} new comments` : "New feedback";
  return `${what} on ${store.taskRef(taskId)} (reviews/CI). Read it with: ${toolsCommand("feedback")}`;
}
