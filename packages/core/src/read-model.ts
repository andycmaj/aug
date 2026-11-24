// What the views read, each read naming the tables it queries. The TUI
// passes a `track` that subscribes to those tables' versions, so a write
// re-runs only the views over what it touched. Views read through here and
// never import the store.

import { Table } from "./db";
import { inboxCount, inboxRows, inboxRuns } from "./inbox";
import { boardColumnOf, type BoardColumn } from "./lanes";
import { projectProgress, projectSummary, railProjects } from "./lookup";
import { perfOn, timing } from "./perf";
import { taskPr, taskPrStatus, unmergedPr } from "./pr";
import { buildRail, localDay, type RailSection } from "./rail";
import { spendReport } from "./spend";
import * as store from "./store";
import { winDetail, winsDay } from "./wins-board";
import { Kind, type TaskRow } from "./types";

export type Track = (tables: readonly Table[]) => void;

// A task's brief can be edited until an agent has started from it.
export function briefEditable(taskId: number): boolean {
  const task = store.getTask(taskId);
  return Boolean(task) && task?.kind !== Kind.home && !store.latestSession(taskId);
}

function rail(now: Date, pending: Set<number>): RailSection[] {
  const tasks = store.listTasks();
  const lastHeard = new Map<number, string>();
  for (const t of tasks) {
    if (!t.waiting_on) continue;
    const heard = [...store.messagesForTask(t.id)].reverse().find((m) => !m.from_me);
    if (heard) lastHeard.set(t.id, heard.received_at);
  }
  return buildRail({
    home: store.homeTask(),
    projects: railProjects(),
    tasks,
    pendingActions: pending,
    reviews: store.tasksFromReviewRequests(),
    lastHeard,
    now,
    prStates: store.prStates(),
    blockers: store.allBlockers(),
    wins: store.winsOn(localDay(now)),
    due: store.ringingTimers(),
  });
}

function board(pending: Set<number>): Record<BoardColumn, TaskRow[]> {
  const today = new Date().toISOString().slice(0, 10);
  const out: Record<BoardColumn, TaskRow[]> = {
    working: [],
    waiting: [],
    idle: [],
    left: [],
    ready: [],
  };
  for (const task of store.listTasks()) {
    const col = boardColumnOf(task, { hasPendingAction: pending.has(task.id) }, today);
    if (col) out[col].push(task);
  }
  return out;
}

function searchSources(taskIds: number[]) {
  return {
    messages: store.messagesForTasks(taskIds),
    turns: store.turnsForTasks(taskIds),
  };
}

const T = Table;

// What a read needs from the desk: whether a task's agent runs. A tmux one
// is its latest session; a chat one is the pool, which moves with the task.
export interface LiveCheck {
  isLive(task: TaskRow): boolean;
}

type Read = readonly [readonly Table[], (...args: never[]) => unknown];

// Each read and the tables behind it. A read that calls another module
// (lookup, pr, the desk) lists every table that module's queries touch.
function reads(desk: LiveCheck) {
  return {
    home: [[T.tasks], store.homeTask],
    task: [[T.tasks], store.getTask],
    tasksForProject: [[T.tasks], store.tasksForProject],
    tasksWithPendingAction: [[T.turns], store.tasksWithPendingAction],
    turns: [[T.turns], store.turnsForTask],
    pendingAction: [[T.turns], store.pendingAction],
    latestActionTurns: [[T.turns], store.latestActionTurns],
    messages: [[T.messages], store.messagesForTask],
    message: [[T.messages], store.getMessage],
    taskLinks: [[T.taskLinks], store.linksForTask],
    timers: [[T.timers], store.timersForTask],
    pendingTimers: [[T.timers], store.pendingTimers],
    story: [[T.stories], store.currentStory],
    latestSession: [[T.sessions], store.latestSession],
    isLive: [[T.sessions, T.tasks], (task: TaskRow) => desk.isLive(task)],
    prStatus: [[T.prStatus], store.prStatus],
    taskPr: [[T.tasks, T.taskThreads, T.messages, T.taskLinks], taskPr],
    taskPrStatus: [[T.tasks, T.taskThreads, T.messages, T.taskLinks, T.prStatus], taskPrStatus],
    unmergedPr: [[T.tasks, T.taskThreads, T.messages, T.taskLinks, T.prStatus], unmergedPr],
    briefEditable: [[T.tasks, T.sessions], briefEditable],
    proposals: [[T.proposals], store.proposalsForTask],
    project: [[T.projects], store.getProject],
    projects: [[T.projects], store.listProjects],
    projectLinks: [[T.projectLinks], store.linksForProject],
    projectSummary: [[T.tasks, T.goals], projectSummary],
    projectProgress: [[T.tasks, T.goals], projectProgress],
    knowledge: [[T.knowledge], store.listKnowledge],
    notes: [[T.notes, T.tasks], store.listNotes],
    searchSources: [[T.messages, T.turns], searchSources],
    closedTasks: [[T.tasks], store.closedTasks],
    rail: [
      [T.tasks, T.messages, T.projects, T.goals, T.prStatus, T.taskBlockers, T.wins],
      rail,
    ],
    blockers: [[T.taskBlockers], store.blockersOf],
    wins: [[T.wins], store.winsOn],
    board: [[T.tasks], board],
    inbox: [[T.messages, T.ideas], inboxRows],
    inboxCount: [[T.messages, T.ideas], inboxCount],
    inboxRuns: [[T.triageRuns, T.triageSteps], inboxRuns],
    spendOn: [[T.spend], store.spendOn],
    taskSpend: [[T.spend], store.taskSpend],
    spendReport: [[T.spend, T.tasks], spendReport],
    winsDay: [
      [T.wins, T.taskEvents, T.tasks, T.turns, T.moves, T.prStatus, T.taskBlockers],
      winsDay,
    ],
    winDetail: [
      [
        T.tasks,
        T.taskEvents,
        T.turns,
        T.moves,
        T.sessions,
        T.spend,
        T.prStatus,
        T.taskThreads,
        T.messages,
        T.taskLinks,
      ],
      winDetail,
    ],
  } as const satisfies Record<string, Read>;
}

type Reads = ReturnType<typeof reads>;
export type ReadName = keyof Reads;
export type ReadModel = { [K in ReadName]: Reads[K][1] };

// Reads run so far, for the TUI's refresh to say how many a bump re-ran
// (the invalidation fan-out). Counted only while perf is on.
let runs = 0;
export function readsRun(): number {
  return runs;
}

export function readModel(track: Track, desk: LiveCheck): ReadModel {
  const out: Record<string, unknown> = {};
  for (const [name, [tables, fn]] of Object.entries(reads(desk))) {
    const read = fn as (...args: unknown[]) => unknown;
    const op = `read.${name}`;
    out[name] = (...args: unknown[]) => {
      track(tables);
      if (!perfOn()) return read(...args);
      runs++;
      const started = performance.now();
      try {
        return read(...args);
      } finally {
        timing(op, performance.now() - started);
      }
    };
  }
  return out as ReadModel;
}

// The tables a read depends on, for tests that pin them.
export function readTables(name: ReadName): readonly Table[] {
  return reads({ isLive: () => false })[name][0];
}
