// The work rail: what still wants something from you, never a history. Rows
// sit oldest first inside each heading and never move; urgency shades a row
// in its place rather than lifting it.

import { Lane, LANE_META, laneOf, type Tone } from "./lanes";
import {
  AgentState,
  Kind,
  TaskStatus,
  type IdeaRow,
  type MessageRow,
  type Priority,
  type ProjectRow,
  type TaskRow,
} from "./types";

// A project as the rail shows it: what is open in it and what is running.
export interface RailProject {
  project: ProjectRow;
  open: number;
  working: number;
  repos: string[];
  // Goals met of the ones not dropped; both 0 for a project without goals.
  goalsMet: number;
  goals: number;
}

// FYIs are still filed and kept; the rail just does not show them until
// they earn a place there.
export const SHOW_FYI = false;

export const Section = {
  home: "home",
  wins: "wins",
  system: "system",
  tasks: "tasks",
  reviews: "reviews",
  watching: "watching",
  later: "later",
  advisor: "advisor",
  fyi: "fyi",
} as const;
export type Section = (typeof Section)[keyof typeof Section];

export const SECTION_TITLES: Record<Section, string> = {
  home: "Home",
  wins: "Wins",
  system: "System",
  tasks: "Tasks",
  reviews: "Code Reviews",
  watching: "Watching",
  later: "For later",
  advisor: "Advisor",
  fyi: "FYI",
};

// The walk visits these in order; For later is never offered by Next, nor is
// a project row.
export const WALKED: Section[] = [
  "wins",
  "system",
  "tasks",
  "reviews",
  "watching",
  "advisor",
  "fyi",
];

export type RailItem =
  | {
      type: "task";
      key: string;
      task: TaskRow;
      lane: Lane;
      priority: Priority;
      slipped: boolean;
      at: string;
      // The project whose row it sits under in Tasks, folding with it.
      group: number | null;
    }
  | ({ type: "project"; key: string; at: string } & RailProject)
  | { type: "idea"; key: string; idea: IdeaRow; at: string }
  | { type: "fyi"; key: string; message: MessageRow; at: string };

export interface RailSection {
  section: Section;
  items: RailItem[];
  // Tasks in it, folded ones included; project rows are not counted.
  count: number;
  // Wins only: how many of the day's are done.
  done?: number;
}

// The most Wins a day holds: few enough to stay a focus.
export const MAX_WINS = 5;

// Wins belong to the owner's day, not UTC's.
export function localDay(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface RailInput {
  // The Home thread, first on the rail and never walked.
  home?: TaskRow | null;
  // Active projects: each a row in Tasks with its tasks under it.
  projects?: RailProject[];
  tasks: TaskRow[];
  pendingActions: Set<number>;
  // Tasks a review request filed; they sit under Code Reviews, not Tasks.
  reviews?: Set<number>;
  ideas: IdeaRow[];
  fyi: MessageRow[];
  // Task id -> when the last message from somebody else arrived, for slipped.
  lastHeard: Map<number, string>;
  now: Date;
  // Task id -> its PR's last read state.
  prStates?: Map<number, string>;
  // Task id -> the open tasks it waits on.
  blockers?: Map<number, number[]>;
  // Today's Wins, in the order they were pinned.
  wins?: number[];
}

// A thread waiting on somebody else goes quiet past this, and it is slipped.
const SLIPPED_AFTER_MS = 3 * 24 * 3600 * 1000;

export function isSlipped(
  task: TaskRow,
  lastHeard: string | undefined,
  now: Date,
  blocked = false,
): boolean {
  // A task waiting on another task: that task's own row says how it goes.
  if (blocked) return false;
  if (!task.waiting_on || task.status !== TaskStatus.open) return false;
  const since = lastHeard ?? task.updated_at;
  return now.getTime() - Date.parse(since) > SLIPPED_AFTER_MS;
}

export function buildRail(input: RailInput): RailSection[] {
  const sections: Record<Section, RailItem[]> = {
    home: [],
    wins: [],
    system: [],
    tasks: [],
    reviews: [],
    watching: [],
    later: [],
    advisor: [],
    fyi: [],
  };

  if (input.home)
    sections.home.push({
      type: "task",
      key: `t${input.home.id}`,
      task: input.home,
      lane: laneOf(input.home, { hasPendingAction: false }),
      priority: input.home.priority,
      slipped: false,
      at: input.home.created_at,
      group: null,
    });

  const projectIds = new Set((input.projects ?? []).map((p) => p.project.id));

  const reviews = input.reviews ?? new Set<number>();
  const wins = new Map((input.wins ?? []).map((id, i) => [id, i]));
  const winItems: RailItem[] = [];
  for (const task of input.tasks) {
    const onYou = reviews.has(task.id) ? sections.reviews : sections.tasks;
    const blockers = input.blockers?.get(task.id)?.length ?? 0;
    const lane = laneOf(task, {
      hasPendingAction: input.pendingActions.has(task.id),
      // A PR you were asked to review is on you, not in its review loop.
      prState: reviews.has(task.id) ? null : (input.prStates?.get(task.id) ?? null),
      blockers,
    });
    const item: RailItem = {
      type: "task",
      key: `t${task.id}`,
      task,
      lane,
      priority: task.priority,
      slipped: isSlipped(
        task,
        input.lastHeard.get(task.id),
        input.now,
        blockers > 0,
      ),
      at: task.created_at,
      group: null,
    };
    // A Win sits in Wins alone for the day, done ones too: the box shows
    // how the day went.
    if (wins.has(task.id) && task.kind !== Kind.system) {
      if (task.status !== TaskStatus.dropped) winItems[wins.get(task.id)!] = item;
      continue;
    }
    // aug asking about its own docs: on you until answered, never later.
    if (task.kind === Kind.system) {
      if (task.status === TaskStatus.open || task.status === TaskStatus.later)
        sections.system.push(item);
      continue;
    }
    if (task.status === TaskStatus.done) {
      // An agent-closed task stays until you have read its result.
      if (lane === Lane.ready) onYou.push(item);
      continue;
    }
    if (task.status === TaskStatus.dropped) continue;
    if (task.status === TaskStatus.later) {
      // Unless its agent asks you something: then it is back on you.
      if (task.agent_state === AgentState.waiting) onYou.push(item);
      else sections.later.push({ ...item, at: task.remind_at ?? item.at });
      continue;
    }
    if (task.watching) sections.watching.push(item);
    else onYou.push(item);
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
  const sorted = (items: RailItem[]) => [...items].sort(byAt);
  const groupOf = (item: RailItem) =>
    item.type === "task" &&
    item.task.project_id !== null &&
    projectIds.has(item.task.project_id)
      ? item.task.project_id
      : null;

  // Tasks: each project's row with its tasks under it, then the tasks in no
  // project.
  const loose = sections.tasks.filter((i) => groupOf(i) === null);
  const grouped: RailItem[] = [];
  // The onboarding interview's window needs a project of one; it is not
  // the owner's work, and its task already shows under System.
  const systemOnly = (projectId: number) => {
    const own = input.tasks.filter((t) => t.project_id === projectId);
    return own.length > 0 && own.every((t) => t.kind === Kind.system);
  };
  for (const p of input.projects ?? []) {
    if (p.project.solo && systemOnly(p.project.id)) continue;
    grouped.push({
      type: "project",
      key: `p${p.project.id}`,
      at: p.project.created_at,
      ...p,
    });
    for (const item of sorted(
      sections.tasks.filter((i) => groupOf(i) === p.project.id),
    ))
      if (item.type === "task") grouped.push({ ...item, group: p.project.id });
  }

  sections.wins = winItems.filter(Boolean);
  return (Object.keys(sections) as Section[])
    .map((section): RailSection => {
      const items =
        section === Section.tasks
          ? [...grouped, ...sorted(loose)]
          : section === Section.wins
            ? sections.wins
            : sorted(sections[section]);
      return {
        section,
        items,
        count: items.filter((i) => i.type !== "project").length,
        ...(section === Section.wins
          ? {
              done: items.filter(
                (i) => i.type === "task" && i.task.status === TaskStatus.done,
              ).length,
            }
          : {}),
      };
    })
    .filter((s) => s.items.length > 0);
}

// What the rail shows: a folded project keeps its row and hides its tasks.
export function foldRail(
  sections: RailSection[],
  folded: Set<number>,
): RailSection[] {
  if (folded.size === 0) return sections;
  return sections.map((s) => ({
    ...s,
    items: s.items.filter(
      (i) => i.type !== "task" || i.group === null || !folded.has(i.group),
    ),
  }));
}

// The rail's status filter (tilt-tui's filter bar): each one a pill over the
// rail that a digit toggles. Lanes the owner reads as one thing share a pill.
export const RailFilter = {
  asks: "asks",
  ready: "ready",
  send: "send",
  working: "working",
  idle: "idle",
  stopped: "stopped",
  review: "review",
  open: "open",
  waiting: "waiting",
} as const;
export type RailFilter = (typeof RailFilter)[keyof typeof RailFilter];

export const RAIL_FILTERS: {
  filter: RailFilter;
  lanes: Lane[];
  mark: string;
  tone: Tone;
  word: string;
}[] = [
  { filter: "asks", lanes: [Lane.waiting], ...pill(Lane.waiting) },
  // On you too, next to asks: its agent is finished and the result waits
  // for your review, or the branch landed and only closing is left.
  {
    filter: "ready",
    lanes: [Lane.ready, Lane.merged],
    ...pill(Lane.ready),
    word: "ready for review, or merged and ready to close",
  },
  { filter: "send", lanes: [Lane.approve], ...pill(Lane.approve) },
  { filter: "working", lanes: [Lane.working], ...pill(Lane.working) },
  { filter: "idle", lanes: [Lane.idle], ...pill(Lane.idle) },
  // Not running either way: Start or Continue gets it going.
  {
    filter: "stopped",
    lanes: [Lane.stopped, Lane.queued],
    ...pill(Lane.stopped),
    word: "stopped, or waiting to start",
  },
  { filter: "review", lanes: [Lane.review], ...pill(Lane.review) },
  {
    filter: "open",
    lanes: [Lane.yours, Lane.asked],
    ...pill(Lane.yours),
    word: "open, on you",
  },
  {
    filter: "waiting",
    lanes: [Lane.blocked, Lane.theirs, Lane.watching, Lane.later],
    ...pill(Lane.theirs),
    word: "blocked, waiting on them, watching, later",
  },
];

// Lanes with no pill, on purpose: done never reaches the rail except as an
// agent-closed task whose result is unread, which is in ready.
export const UNFILTERED_LANES: Lane[] = [Lane.done];

function pill(lane: Lane) {
  const { mark, tone, word } = LANE_META[lane];
  return { mark, tone, word };
}

const FILTER_OF = new Map<Lane, RailFilter>(
  RAIL_FILTERS.flatMap((f) => f.lanes.map((l) => [l, f.filter] as const)),
);

export function filterOf(lane: Lane): RailFilter | null {
  return FILTER_OF.get(lane) ?? null;
}

const isHome = (item: RailItem) =>
  item.type === "task" && item.task.kind === Kind.home;

// Tasks under each pill, Home left out: it is not work.
export function filterCounts(
  sections: RailSection[],
): Record<RailFilter, number> {
  const counts = Object.fromEntries(
    RAIL_FILTERS.map((f) => [f.filter, 0]),
  ) as Record<RailFilter, number>;
  for (const item of flattenRail(sections)) {
    if (item.type !== "task" || isHome(item)) continue;
    const f = filterOf(item.lane);
    if (f) counts[f]++;
  }
  return counts;
}

// What a status filter leaves: Home, the tasks in its lanes, and the project
// rows they sit under. Advisor ideas and FYIs have no status, so they go.
export function filterRail(
  sections: RailSection[],
  active: Set<RailFilter>,
): RailSection[] {
  if (active.size === 0) return sections;
  const keep = (item: RailItem) => {
    if (item.type !== "task") return false;
    if (isHome(item)) return true;
    const f = filterOf(item.lane);
    return f !== null && active.has(f);
  };
  return sections
    .map((s) => {
      const tasks = s.items.filter(keep);
      const groups = new Set(
        tasks.map((i) => (i.type === "task" ? i.group : null)),
      );
      const items = s.items.filter(
        (i) => keep(i) || (i.type === "project" && groups.has(i.project.id)),
      );
      return { ...s, items, count: tasks.length };
    })
    .filter((s) => s.items.length > 0);
}

// f on the rail: one status at a time, through the ones that have tasks, then
// back to everything.
export function cycleFilter(
  active: Set<RailFilter>,
  counts: Record<RailFilter, number>,
): Set<RailFilter> {
  const order = RAIL_FILTERS.map((f) => f.filter);
  const from = active.size === 1 ? order.indexOf([...active][0]) : -1;
  for (let i = from + 1; i < order.length; i++)
    if (counts[order[i]] > 0) return new Set([order[i]]);
  return new Set();
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
