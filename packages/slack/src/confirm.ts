// A move that ends or starts work, asked for by the Assistant while it
// answers a Slack line, waits for the owner's yes in that Slack thread. The
// model cannot say yes for them: only a line the remote hears from the owner
// runs it (remote.ts), within CONFIRM_MINUTES.

import * as store from "@riker/core/store";
import { CONFIRM_MINUTES, SLACK_ASKER } from "@riker/core/types";

export { CONFIRM_MINUTES, SLACK_ASKER };

// The moves that wait for a yes: they spend money or end work.
export const CONFIRM_MOVES: ReadonlySet<string> = new Set([
  "start",
  "stop",
  "done",
  "ignore",
  "project_archive",
  "action",
]);

const KEY = "slack.remote.confirm";

const VERB_WORDS: Record<string, string> = {
  start: "start the agent on",
  stop: "stop the agent on",
  done: "mark done",
  ignore: "ignore",
  project_archive: "archive project",
  action: "run an action on",
};

// The move in the owner's words: "stop the agent on RIKER-0012 (fix the
// flaky test)".
export function describeMove(verb: string, args: Record<string, string>): string {
  const words = VERB_WORDS[verb] ?? verb;
  if (args.task) {
    const id = store.parseTaskRef(args.task);
    const task = id ? store.getTask(id) : null;
    const ref = task ? store.taskRef(task.id) : args.task;
    return `${words} ${ref}${task ? ` (${task.title})` : ""}`;
  }
  if (args.project)
    return `${words} ${args.project}${args.force === "yes" ? " with its open tasks" : ""}`;
  return words;
}

export interface Pending {
  id: number;
  verb: string;
  args: Record<string, string>;
  // What the owner reads: "stop RIKER-0012 (fix the flaky test)".
  says: string;
  // Home's turn that asked for it, until its answer is posted.
  turnId: number | null;
  // The Slack thread whose next owner line answers it.
  threadTs: string | null;
  at: string;
}

function live(list: Pending[], at = Date.now()): Pending[] {
  return list.filter(
    (p) => at - Date.parse(p.at) < CONFIRM_MINUTES * 60_000,
  );
}

// Every read drops what has expired, so a stale yes finds nothing.
export function pendingConfirms(at = Date.now()): Pending[] {
  try {
    const raw = store.kvGet(KEY);
    return raw ? live(JSON.parse(raw) as Pending[], at) : [];
  } catch {
    return [];
  }
}

function save(list: Pending[]): void {
  store.kvSet(KEY, JSON.stringify(list));
}

// Held instead of run: the line the Assistant reads back as the move's
// result. Asking again for the same move replaces the hold.
export function holdForYes(
  verb: string,
  args: Record<string, string>,
): string {
  const home = store.homeTask();
  const running = store
    .turnsForTask(home.id)
    .findLast((t) => t.role === "agent" && t.status === "running");
  const says = describeMove(verb, args);
  const list = pendingConfirms().filter((p) => p.says !== says);
  const id = Math.max(0, ...list.map((p) => p.id)) + 1;
  list.push({
    id,
    verb,
    args,
    says,
    turnId: running?.id ?? null,
    threadTs: null,
    at: new Date().toISOString(),
  });
  save(list);
  return `held for the owner's yes in Slack: ${says}. Your answer goes to them with "Reply yes" under it; say what it will do and do not call it again.`;
}

// The holds the answer to `turnId` asked for, now tied to the thread it is
// posted in. A hold whose turn is unknown goes with the first answer.
export function bindToThread(turnId: number, threadTs: string): Pending[] {
  const list = pendingConfirms();
  const bound: Pending[] = [];
  for (const p of list) {
    if (p.threadTs) continue;
    if (p.turnId !== null && p.turnId !== turnId) continue;
    p.threadTs = threadTs;
    bound.push(p);
  }
  if (bound.length) save(list);
  return bound;
}

// The holds an owner line in this thread answers, taken off the list.
export function takeForThread(threadTs: string): Pending[] {
  const list = pendingConfirms();
  const taken = list.filter((p) => p.threadTs === threadTs);
  if (taken.length) save(list.filter((p) => p.threadTs !== threadTs));
  return taken;
}

const YES =
  /^(y|yes|yep|yeah|yup|ok|okay|sure|confirm|confirmed|do it|go|go ahead)[.!\s]*$/i;
const NO = /^(n|no|nope|nah|cancel|don'?t|never ?mind)[.!\s]*$/i;

export function answerKind(text: string): "yes" | "no" | "other" {
  const t = text.trim();
  return YES.test(t) ? "yes" : NO.test(t) ? "no" : "other";
}
