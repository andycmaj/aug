// The work rail: what still wants something from you, never a history. Rows
// sit oldest first inside each heading and never move; urgency shades a row
// in its place rather than lifting it. Tasks and projects only: messages
// and Advisor ideas live on the Board's Inbox, and the header's badge says
// when one needs you.

import { Lane, LANE_META, laneOf, type Tone } from "./lanes";
import {
  AgentState,
  Kind,
  TaskStatus,
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

export const Section = {
  home: "home",
  wins: "wins",
  system: "system",
  tasks: "tasks",
  reviews: "reviews",
  watching: "watching",
  later: "later",
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
};

// The walk visits these in order; For later is never offered by Next, nor is
// a project row.
export const WALKED: Section[] = [
  "wins",
  "system",
  "tasks",
  "reviews",
  "watching",
];

// A tag a row wears beside its mark: pinned as today's Win, or watched.
export const Tag = { win: "win", watching: "watching" } as const;
export type Tag = (typeof Tag)[keyof typeof Tag];
export const TAG_MARK: Record<Tag, string> = { win: "★", watching: "◉" };

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
      // The second row of a task that is also listed under Wins or
      // Watching: the task sits in its project too, and that row is the
      // one counted, searched and gone to. Its key is `t<id>@<section>`.
      copy: boolean;
      // Tags the row's place does not already say (no ★ under Wins).
      tags: Tag[];
    }
  | ({ type: "project"; key: string; at: string } & RailProject);

type TaskItem = Extract<RailItem, { type: "task" }>;

// A task's own key: what the selection, history and go-to hold. A copy's
// row key carries the section after an @.
export const taskKey = (taskId: number) => `t${taskId}`;
export function baseKey(key: string): string;
export function baseKey(key: string | null): string | null;
export function baseKey(key: string | null): string | null {
  if (key === null) return null;
  const at = key.indexOf("@");
  return at === -1 ? key : key.slice(0, at);
}

// The row a key stands for: that row, else its task's own row, else the
// first copy of it (a done Win sits only under Wins).
export function rowFor(items: RailItem[], key: string | null): RailItem | null {
  if (key === null) return null;
  const exact = items.find((i) => i.key === key);
  if (exact) return exact;
  const base = baseKey(key);
  return (
    items.find((i) => i.key === base) ??
    items.find((i) => baseKey(i.key) === base) ??
    null
  );
}

// Each row once: a task's copies left out.
export const isCopy = (item: RailItem) => item.type === "task" && item.copy;

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
  // Review task id -> when someone last asked or wrote on it: the oldest
  // ask leads Code Reviews.
  asked?: Map<number, string>;
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

// Where a task sits on the rail, Wins and Watching aside: they list it
// again (buildRail). Null: off the rail.
function placeOf(
  task: TaskRow,
  lane: Lane,
  onYou: Section,
): Section | null {
  // Riker asking about its own docs: on you until answered, never later.
  if (task.kind === Kind.system)
    return task.status === TaskStatus.open || task.status === TaskStatus.later
      ? Section.system
      : null;
  // An agent-closed task stays until you have read its result.
  if (task.status === TaskStatus.done) return lane === Lane.ready ? onYou : null;
  if (task.status === TaskStatus.dropped) return null;
  // Unless its agent asks you something: then it is back on you.
  if (task.status === TaskStatus.later)
    return task.agent_state === AgentState.waiting ? onYou : Section.later;
  return onYou;
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
      copy: false,
      tags: [],
    });

  const projectIds = new Set((input.projects ?? []).map((p) => p.project.id));

  const reviews = input.reviews ?? new Set<number>();
  const wins = new Map((input.wins ?? []).map((id, i) => [id, i]));
  const winItems: TaskItem[] = [];
  for (const task of input.tasks) {
    const onYou = reviews.has(task.id) ? Section.reviews : Section.tasks;
    const blockers = input.blockers?.get(task.id)?.length ?? 0;
    const lane = laneOf(task, {
      hasPendingAction: input.pendingActions.has(task.id),
      // A PR you were asked to review is on you, not in its review loop.
      prState: reviews.has(task.id) ? null : (input.prStates?.get(task.id) ?? null),
      blockers,
    });
    // The rail's clock ticks by the minute: an ask newer than it is now.
    const asked = reviews.has(task.id)
      ? [input.asked?.get(task.id) ?? task.created_at, input.now.toISOString()].sort()[0]
      : undefined;
    const item: TaskItem = {
      type: "task",
      key: taskKey(task.id),
      task,
      lane,
      priority: task.priority,
      slipped: isSlipped(
        task,
        input.lastHeard.get(task.id),
        input.now,
        blockers > 0,
      ),
      // A review's age is how long the ask has waited on you.
      at: asked ?? task.created_at,
      group: null,
      copy: false,
      tags: [],
    };
    // A Win is listed under Wins for the day, done ones too (the box shows
    // how the day went), as well as where it sits.
    const win =
      wins.has(task.id) &&
      task.kind !== Kind.system &&
      task.status !== TaskStatus.dropped;
    // Watching lists an open task you watch; it stays in its project too.
    const watched =
      Boolean(task.watching) &&
      task.status === TaskStatus.open &&
      task.kind !== Kind.system;
    const place = placeOf(task, lane, onYou);
    const tagsFor = (section: Section | null): Tag[] => [
      ...(win && section !== Section.wins ? [Tag.win] : []),
      // The watching lane's mark already says it.
      ...(task.watching &&
      section !== Section.watching &&
      lane !== Lane.watching
        ? [Tag.watching]
        : []),
    ];
    if (place === Section.later)
      sections.later.push({
        ...item,
        at: task.remind_at ?? item.at,
        tags: tagsFor(place),
      });
    else if (place) sections[place].push({ ...item, tags: tagsFor(place) });
    const copy = (section: Section): TaskItem => ({
      ...item,
      // A task with no row of its own (a done Win) is not a copy: its row
      // under Wins is the one.
      key: place ? `${item.key}@${section}` : item.key,
      copy: place !== null,
      tags: tagsFor(section),
    });
    if (win) winItems[wins.get(task.id)!] = copy(Section.wins);
    if (watched) sections.watching.push(copy(Section.watching));
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

// Tasks under each pill, Home left out: it is not work. Each task once: a
// Win or a watched task listed twice is one task.
export function filterCounts(
  sections: RailSection[],
): Record<RailFilter, number> {
  const counts = Object.fromEntries(
    RAIL_FILTERS.map((f) => [f.filter, 0]),
  ) as Record<RailFilter, number>;
  for (const item of flattenRail(sections)) {
    if (item.type !== "task" || isHome(item) || item.copy) continue;
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

// The rows Next may land on: tasks in walked sections, each task at its
// first row in walk order (a Win under Wins, not again in its project),
// and never the selected task's other row.
export function walkableKeys(
  sections: RailSection[],
  selected: string | null,
): Set<string> {
  const seen = new Set<string>(selected ? [baseKey(selected)] : []);
  const keys = new Set<string>();
  for (const s of sections) {
    if (!WALKED.includes(s.section)) continue;
    for (const item of s.items) {
      if (item.type !== "task") continue;
      const base = baseKey(item.key);
      if (seen.has(base)) continue;
      seen.add(base);
      keys.add(item.key);
    }
  }
  return keys;
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
