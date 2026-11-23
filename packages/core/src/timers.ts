// Timers: what is due on a task, and when. A follow-up (an agent's "check
// this PR again tomorrow") fires once; a schedule ("every weekday 09:00")
// fires on its rule; a reminder is the owner's "put away until".
//
// A timer never wakes anyone itself. The engine's tick turns each due one
// into a message on the inbox (channel `timer`) and marks it done, or moves
// a schedule to its next time, in one write; the inbox's worker routes the
// message to its task (the `timer` rule, routeTimer below) and asks the desk
// to wake the agent. So a timer that comes due while Riker is closed fires
// once at the next start, and a crash between the two loses nothing.

import * as store from "./store";
import {
  Channel,
  TaskStatus,
  TimerKind,
  TimerState,
  TurnRole,
  type MessageRow,
  type TaskRow,
  type TimerRow,
} from "./types";
import type { TriageOutcome } from "./plugins";

export class TimerError extends Error {}

// ── rules: the small subset a schedule takes ─────────────────────────────

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const WEEKDAYS = [1, 2, 3, 4, 5];

const DAY_WORDS: Record<string, number[]> = {
  day: [0, 1, 2, 3, 4, 5, 6],
  days: [0, 1, 2, 3, 4, 5, 6],
  daily: [0, 1, 2, 3, 4, 5, 6],
  weekday: WEEKDAYS,
  weekdays: WEEKDAYS,
  weekend: [0, 6],
  weekends: [0, 6],
};
DAYS.forEach((d, i) => {
  DAY_WORDS[d] = [i];
});
for (const [word, i] of [
  ["sunday", 0], ["monday", 1], ["tues", 2], ["tuesday", 2], ["wednesday", 3],
  ["thur", 4], ["thurs", 4], ["thursday", 4], ["friday", 5], ["saturday", 6],
] as const)
  DAY_WORDS[word] = [i];

// Words a rule may carry that say nothing ("every weekday at 09:00").
const FILLER = new Set(["every", "at", "on", "and", "week", "weekly"]);

export interface Rule {
  // Days of the week it fires on (0 = Sunday), in order.
  days: number[];
  hour: number;
  minute: number;
}

function parseTime(word: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2})(?::(\d{2}))?(am|pm)?$/.exec(word);
  if (!m || (m[2] === undefined && m[3] === undefined)) return null;
  let hour = Number(m[1]);
  const minute = Number(m[2] ?? 0);
  if (m[3]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (m[3] === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

// "every weekday 09:00", "daily at 7am", "weekly on mon,thu 14:30". The
// time is the owner's local time.
export function parseRule(text: string): Rule {
  const words = text.toLowerCase().split(/[\s,]+/).filter(Boolean);
  const days = new Set<number>();
  let time: { hour: number; minute: number } | null = null;
  for (const word of words) {
    if (FILLER.has(word)) continue;
    const named = DAY_WORDS[word];
    if (named) {
      for (const d of named) days.add(d);
      continue;
    }
    const t = parseTime(word);
    if (t && !time) {
      time = t;
      continue;
    }
    throw new TimerError(
      `a schedule is days and a time, like "every weekday 09:00", "daily 7am" or "mon,thu 14:30": "${word}" is neither`,
    );
  }
  if (days.size === 0)
    throw new TimerError(`which days? daily, weekdays, or day names (mon,thu): got "${text}"`);
  if (!time) throw new TimerError(`at what time? 09:00 or 9am: got "${text}"`);
  return { days: [...days].sort((a, b) => a - b), ...time };
}

function hhmm(rule: Rule): string {
  return `${String(rule.hour).padStart(2, "0")}:${String(rule.minute).padStart(2, "0")}`;
}

function daysWord(days: number[]): string {
  if (days.length === 7) return "daily";
  if (days.join() === WEEKDAYS.join()) return "weekdays";
  return days.map((d) => DAYS[d]).join(",");
}

// The rule as stored: "daily 09:00", "weekdays 09:00", "mon,thu 14:30".
export function ruleText(rule: Rule): string {
  return `${daysWord(rule.days)} ${hhmm(rule)}`;
}

export function describeRule(text: string): string {
  const rule = parseRule(text);
  const days = daysWord(rule.days);
  const every =
    days === "daily" ? "every day" : days === "weekdays" ? "every weekday" : `every ${days}`;
  return `${every} at ${hhmm(rule)}`;
}

// The first time on the rule strictly after `after`: a schedule missed
// while Riker was closed comes due once, then goes on from now.
export function nextAfter(text: string, after: Date): Date {
  const rule = parseRule(text);
  for (let i = 0; i <= 7; i++) {
    const at = new Date(after);
    at.setDate(at.getDate() + i);
    at.setHours(rule.hour, rule.minute, 0, 0);
    if (rule.days.includes(at.getDay()) && at > after) return at;
  }
  throw new TimerError(`no next time for "${text}"`);
}

// ── when a follow-up is due ──────────────────────────────────────────────

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

// "30m", "3h", "1d", "2w" from now.
export function parseIn(text: string, from: Date): Date {
  const m = /^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?|w|weeks?)$/.exec(
    text.trim().toLowerCase(),
  );
  if (!m) throw new TimerError(`--in is a number and a unit, like 30m, 3h, 1d or 2w: got "${text}"`);
  const ms = Number(m[1]) * UNIT_MS[m[2]![0]!]!;
  if (ms < 60_000) throw new TimerError(`--in is at least a minute: got "${text}"`);
  return new Date(from.getTime() + ms);
}

export function parseAt(text: string, from: Date): Date {
  const at = new Date(text.trim());
  if (Number.isNaN(at.getTime()))
    throw new TimerError(`--at is a date and time, like 2026-11-24T09:00: got "${text}"`);
  if (at <= from) throw new TimerError(`--at is in the past: ${text}`);
  return at;
}

// ── setting and listing ──────────────────────────────────────────────────

export function addFollowup(taskId: number, dueAt: Date, note: string, by: string): TimerRow {
  return store.addTimer({
    taskId,
    kind: TimerKind.followup,
    dueAt: dueAt.toISOString(),
    note: note.trim(),
    by,
  });
}

export function addSchedule(
  taskId: number,
  rule: string,
  note: string,
  by: string,
  from = new Date(),
): TimerRow {
  const text = ruleText(parseRule(rule));
  return store.addTimer({
    taskId,
    kind: TimerKind.schedule,
    dueAt: nextAfter(text, from).toISOString(),
    rule: text,
    note: note.trim(),
    by,
  });
}

export function timerRef(id: number): string {
  return `T${id}`;
}

export function parseTimerRef(text: string): number | null {
  const m = /^T?(\d+)$/i.exec(text.trim());
  return m ? Number(m[1]) : null;
}

function dueIn(iso: string, now: Date): string {
  const ms = Date.parse(iso) - now.getTime();
  if (ms <= 0) return "due now";
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `in ${Math.max(1, Math.ceil(ms / 60_000))}m`;
  if (min < 60 * 24) return `in ${Math.floor(min / 60)}h`;
  return `in ${Math.floor(min / (60 * 24))}d`;
}

// One line: "follow-up in 1d: check the PR", "every weekday at 09:00 (next
// in 3h): summarize my open PRs", "reminder in 2d".
export function timerLine(timer: TimerRow, now: Date): string {
  const when = dueIn(timer.due_at, now);
  const head =
    timer.kind === TimerKind.schedule && timer.rule
      ? `${describeRule(timer.rule)} (next ${when})`
      : `${timer.kind === TimerKind.followup ? "follow-up" : "reminder"} ${when}`;
  return timer.note ? `${head}: ${timer.note}` : head;
}

// ── firing ───────────────────────────────────────────────────────────────

export interface TimerMeta {
  timer: number;
  task: number;
  kind: TimerKind;
  due: string;
}

function byName(by: string): string {
  return by === "you" ? "You" : by === "assistant" ? "The Assistant" : by.replace(/^agent /, "Agent ");
}

function titleOf(timer: TimerRow): string {
  switch (timer.kind) {
    case TimerKind.followup:
      return "Follow-up";
    case TimerKind.schedule:
      return timer.rule ? describeRule(timer.rule) : "Schedule";
    case TimerKind.remind:
      return "Reminder";
  }
}

// Every due timer becomes one message on the inbox, and is done or moves on
// in the same write. Returns the messages made.
export function fireDue(at = new Date()): MessageRow[] {
  const fired: MessageRow[] = [];
  for (const timer of store.dueTimers(at.toISOString())) {
    store.batch(() => {
      const task = store.getTask(timer.task_id);
      if (!task) {
        store.setTimerState(timer.id, TimerState.cancelled);
        return;
      }
      const meta: TimerMeta = {
        timer: timer.id,
        task: timer.task_id,
        kind: timer.kind,
        due: timer.due_at,
      };
      // A timer is Riker's own word, not someone writing in (from_me): it
      // is never a reply's target nor "last heard" on its task.
      const message = store.insertMessage({
        channel: Channel.timer,
        externalId: `timer:${timer.id}@${timer.due_at}`,
        threadKey: `timer:${timer.id}`,
        author: timer.by,
        authorName: byName(timer.by),
        title: titleOf(timer),
        body: timer.note || titleOf(timer),
        receivedAt: at.toISOString(),
        fromMe: true,
        meta: { ...meta },
      });
      if (message) fired.push(message);
      const next =
        timer.kind === TimerKind.schedule && timer.rule
          ? nextAfter(timer.rule, at).toISOString()
          : null;
      store.firedTimer(timer.id, at.toISOString(), next);
    });
  }
  return fired;
}

export function isTimerMessage(message: MessageRow): boolean {
  return message.channel === Channel.timer;
}

function timerMeta(message: MessageRow): TimerMeta | null {
  try {
    const meta = JSON.parse(message.meta) as Partial<TimerMeta>;
    return typeof meta.timer === "number" && typeof meta.task === "number" && meta.kind
      ? (meta as TimerMeta)
      : null;
  } catch {
    return null;
  }
}

function settled(message: MessageRow, task: TaskRow | null, reason: string): TriageOutcome {
  store.fileMessage(message.id, null, reason, task?.id ?? null);
  store.markMessageRead(message.id);
  return { verdict: "timer", taskId: task?.id ?? null, reason, effects: [] };
}

// A fired timer, onto its task: a line on the thread, the task back on the
// rail, and (a follow-up or a schedule) its agent asked to pick it up.
export function routeTimer(message: MessageRow): TriageOutcome {
  const meta = timerMeta(message);
  const task = meta ? store.getTask(meta.task) : null;
  if (!meta || !task) return settled(message, null, "a timer whose task is gone");
  const ref = store.taskRef(task.id);
  return store.batch(() => {
    if (meta.kind === TimerKind.remind) {
      // Brought back or put away again since: nothing to do.
      if (task.status !== TaskStatus.later || task.remind_at !== meta.due)
        return settled(message, task, `a reminder for ${ref}, already back`);
      store.reopen(task.id);
      store.addTurn({
        taskId: task.id,
        role: TurnRole.trigger,
        body: "You asked to be reminded about this today",
        messageId: message.id,
      });
      return settled(message, task, `reminded you of ${ref}`);
    }
    const what =
      meta.kind === TimerKind.followup
        ? `Follow-up set by ${message.author} came due`
        : `Scheduled ${message.title}`;
    const body = message.body && message.body !== message.title ? `${what}: ${message.body}` : what;
    const turn = store.addTurn({
      taskId: task.id,
      role: TurnRole.trigger,
      body,
      messageId: message.id,
    });
    if (task.status !== TaskStatus.open) store.reopen(task.id);
    const outcome = settled(message, task, `${meta.kind === TimerKind.followup ? "follow-up" : "schedule"} on ${ref}`);
    return { ...outcome, effects: [{ type: "timer", taskId: task.id, turnId: turn.id, reason: body }] };
  });
}
