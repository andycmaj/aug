// The work rail: what still wants something from you, never a history. Rows
// sit oldest first inside each heading and never move; urgency shades a row
// in its place rather than lifting it.

import { Lane, laneOf } from "./lanes";
import {
  AgentState,
  TaskStatus,
  type IdeaRow,
  type MessageRow,
  type Priority,
  type TaskRow,
} from "./types";

export const Section = {
  tasks: "tasks",
  watching: "watching",
  later: "later",
  advisor: "advisor",
  fyi: "fyi",
} as const;
export type Section = (typeof Section)[keyof typeof Section];

export const SECTION_TITLES: Record<Section, string> = {
  tasks: "Tasks",
  watching: "Watching",
  later: "For later",
  advisor: "Advisor",
  fyi: "FYI",
};

// The walk visits these in order; For later is never offered by Next.
export const WALKED: Section[] = ["tasks", "watching", "advisor", "fyi"];

export type RailItem =
  | {
      type: "task";
      key: string;
      task: TaskRow;
      lane: Lane;
      priority: Priority;
      slipped: boolean;
      at: string;
    }
  | { type: "idea"; key: string; idea: IdeaRow; at: string }
  | { type: "fyi"; key: string; message: MessageRow; at: string };

export interface RailSection {
  section: Section;
  items: RailItem[];
}

export interface RailInput {
  tasks: TaskRow[];
  pendingActions: Set<number>;
  ideas: IdeaRow[];
  fyi: MessageRow[];
  // Task id -> when the last message from somebody else arrived, for slipped.
  lastHeard: Map<number, string>;
  now: Date;
}

// A thread waiting on somebody else goes quiet past this, and it is slipped.
const SLIPPED_AFTER_MS = 3 * 24 * 3600 * 1000;

export function isSlipped(
  task: TaskRow,
  lastHeard: string | undefined,
  now: Date,
): boolean {
  if (!task.waiting_on || task.status !== TaskStatus.open) return false;
  const since = lastHeard ?? task.updated_at;
  return now.getTime() - Date.parse(since) > SLIPPED_AFTER_MS;
}

export function buildRail(input: RailInput): RailSection[] {
  const sections: Record<Section, RailItem[]> = {
    tasks: [],
    watching: [],
    later: [],
    advisor: [],
    fyi: [],
  };

  for (const task of input.tasks) {
    const lane = laneOf(task, {
      hasPendingAction: input.pendingActions.has(task.id),
    });
    const item: RailItem = {
      type: "task",
      key: `t${task.id}`,
      task,
      lane,
      priority: task.priority,
      slipped: isSlipped(task, input.lastHeard.get(task.id), input.now),
      at: task.created_at,
    };
    if (task.status === TaskStatus.done) {
      // An agent-closed task stays until you have read its result.
      if (lane === Lane.agentdone) sections.tasks.push(item);
      continue;
    }
    if (task.status === TaskStatus.dropped) continue;
    if (task.status === TaskStatus.later) {
      // Unless its agent asks you something: then it is back on you.
      if (task.agent_state === AgentState.blocked) sections.tasks.push(item);
      else sections.later.push({ ...item, at: task.remind_at ?? item.at });
      continue;
    }
    if (task.watching) sections.watching.push(item);
    else sections.tasks.push(item);
  }

  for (const idea of input.ideas) {
    sections.advisor.push({
      type: "idea",
      key: `i${idea.id}`,
      idea,
      at: idea.created_at,
    });
  }
  for (const message of input.fyi) {
    sections.fyi.push({
      type: "fyi",
      key: `m${message.id}`,
      message,
      at: message.received_at,
    });
  }

  const byAt = (a: RailItem, b: RailItem) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : a.key < b.key ? -1 : 1;
  return (Object.keys(sections) as Section[])
    .map((section) => ({
      section,
      items: [...sections[section]].sort(byAt),
    }))
    .filter((s) => s.items.length > 0);
}

export function flattenRail(sections: RailSection[]): RailItem[] {
  return sections.flatMap((s) => s.items);
}

// Next on a walk: the row after this one in walked sections. A key that left
// the rail (marked done) resumes from where it stood in the previous order.
export function nextKey(
  order: string[],
  walkable: Set<string>,
  current: string | null,
  direction: 1 | -1,
): string | null {
  if (order.length === 0) return null;
  const start = current ? order.indexOf(current) : -1;
  for (let i = start + direction; i >= 0 && i < order.length; i += direction) {
    if (walkable.has(order[i])) return order[i];
  }
  return null;
}

export function ageLabel(iso: string, now: Date): string {
  const ms = now.getTime() - Date.parse(iso);
  const future = ms < 0;
  const abs = Math.abs(ms);
  const min = Math.floor(abs / 60000);
  let text: string;
  if (min < 5) text = "<5m";
  else if (min < 60) text = `${min}m`;
  else if (min < 60 * 24) text = `${Math.floor(min / 60)}h`;
  else text = `${Math.floor(min / (60 * 24))}d`;
  return future ? `in ${text}` : text;
}

// Where the rail cursor goes when its row leaves: the row below, else above.
export function neighborKey(order: string[], key: string): string | null {
  const at = order.indexOf(key);
  if (at === -1) return order[0] ?? null;
  return order[at + 1] ?? order[at - 1] ?? null;
}
