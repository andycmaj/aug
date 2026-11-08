// The app's view of the store. Reads are plain SQLite queries re-run when a
// version signal bumps: on any in-process write (store.onChange) and when
// another process commits (an agent's hook; PRAGMA data_version).

import {
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type ParentProps,
} from "solid-js";
import { createRequiredContext } from "@andycmaj/opentui-app";
import { dataVersion } from "../core/db";
import { Engine, type EngineStatus } from "../core/engine";
import { boardColumnOf, BoardColumn, type LaneFacts } from "../core/lanes";
import {
  buildRail,
  flattenRail,
  nextKey,
  WALKED,
  type RailItem,
  type RailSection,
} from "../core/rail";
import { railProjects } from "../core/lookup";
import * as store from "../core/store";
import { AgentState, type TaskRow } from "../core/types";

export const ViewMode = { chat: "chat", board: "board" } as const;
export type ViewMode = (typeof ViewMode)[keyof typeof ViewMode];

interface AugContextValue {
  engine: Engine;
  version: Accessor<number>;
  status: Accessor<EngineStatus>;
  now: Accessor<Date>;
  spinner: Accessor<string>;
  rail: Accessor<RailSection[]>;
  items: Accessor<RailItem[]>;
  // On the table: what the canvas shows.
  selectedKey: Accessor<string | null>;
  selected: Accessor<RailItem | null>;
  // Puts a row on the table; the rail cursor follows it.
  select: (key: string | null) => void;
  selectTask: (taskId: number) => void;
  // The rail's highlight, which moves without changing the table.
  cursorKey: Accessor<string | null>;
  cursorItem: Accessor<RailItem | null>;
  moveCursor: (key: string | null) => void;
  walk: (direction: 1 | -1) => string | null;
  pending: Accessor<Set<number>>;
  facts: (task: TaskRow) => LaneFacts;
  board: Accessor<Record<BoardColumn, TaskRow[]>>;
  mode: Accessor<ViewMode>;
  setMode: (mode: ViewMode) => void;
  // The rail shows one project's tasks while set.
  projectFilter: Accessor<number | null>;
  setProjectFilter: (id: number | null) => void;
  cycleProjectFilter: () => number | null;
  // Home: the Assistant's thread, first on the rail.
  homeId: number;
  // Puts Home on the table in Chat and asks for its box to take focus.
  goHome: () => void;
  // Chat focuses the box once it is mounted, then clears this.
  wantsInput: Accessor<boolean>;
  setWantsInput: (on: boolean) => void;
}

const [AugContext, useAug] = createRequiredContext<AugContextValue>("Aug");
export { useAug };

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FYI_DAYS = 14;

export function AugProvider(props: ParentProps<{ engine: Engine }>) {
  const engine = props.engine;
  const [version, setVersion] = createSignal(0);
  const [status, setStatus] = createSignal(engine.status);
  const [now, setNow] = createSignal(new Date());
  const [frame, setFrame] = createSignal(0);
  const [mode, setMode] = createSignal<ViewMode>(ViewMode.chat);
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null);
  const [cursorKey, setCursorKey] = createSignal<string | null>(null);
  const bump = () => setVersion((v) => v + 1);

  onMount(() => {
    const offChange = store.onChange(bump);
    const offStatus = engine.onStatus(setStatus);
    let seen = dataVersion();
    const poll = setInterval(() => {
      const v = dataVersion();
      if (v !== seen) {
        seen = v;
        bump();
      }
    }, 400);
    const clock = setInterval(() => setNow(new Date()), 30_000);
    const spin = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER.length),
      120,
    );
    onCleanup(() => {
      offChange();
      offStatus();
      clearInterval(poll);
      clearInterval(clock);
      clearInterval(spin);
    });
  });

  const pending = createMemo(() => {
    version();
    return store.tasksWithPendingAction();
  });

  const [projectFilter, setProjectFilter] = createSignal<number | null>(null);
  // Off, then each active project in turn, then off again.
  const cycleProjectFilter = (): number | null => {
    const ids = store
      .listProjects()
      .filter((p) => p.status === "active")
      .map((p) => p.id);
    const at = ids.indexOf(projectFilter() ?? -1);
    const next = at + 1 < ids.length ? ids[at + 1] : null;
    setProjectFilter(next);
    return next;
  };

  const homeId = store.homeTask().id;
  const [wantsInput, setWantsInput] = createSignal(false);

  const rail = createMemo(() => {
    version();
    const only = projectFilter();
    const tasks = store
      .listTasks()
      .filter((t) => only === null || t.project_id === only);
    const lastHeard = new Map<number, string>();
    for (const t of tasks) {
      if (!t.waiting_on) continue;
      const heard = [...store.messagesForTask(t.id)]
        .reverse()
        .find((m) => !m.from_me);
      if (heard) lastHeard.set(t.id, heard.received_at);
    }
    const since = new Date(now().getTime() - FYI_DAYS * 86400000).toISOString();
    return buildRail({
      home: store.getTask(homeId),
      projects: railProjects(),
      tasks,
      pendingActions: pending(),
      ideas: store.openIdeas(),
      fyi: store.fyiMessages(since),
      lastHeard,
      now: now(),
    });
  });

  const items = createMemo(() => flattenRail(rail()));
  // The order the walk last saw, so Next from a row that just left the rail
  // (marked done) goes on from where it stood.
  let lastOrder: string[] = [];
  const order = createMemo(() => {
    const keys = items().map((i) => i.key);
    const current = selectedKey();
    if (current && !keys.includes(current) && lastOrder.includes(current)) {
      // keep the departed key in place for one more Next
      const at = lastOrder.indexOf(current);
      const merged = [...keys];
      const before = lastOrder
        .slice(0, at)
        .filter((k) => keys.includes(k))
        .pop();
      merged.splice(before ? merged.indexOf(before) + 1 : 0, 0, current);
      return merged;
    }
    lastOrder = keys;
    return keys;
  });

  const selected = createMemo(() => {
    const key = selectedKey();
    return items().find((i) => i.key === key) ?? null;
  });

  function select(key: string | null) {
    setSelectedKey(key);
    setCursorKey(key);
  }

  function selectTask(taskId: number) {
    select(`t${taskId}`);
  }

  function goHome() {
    setMode(ViewMode.chat);
    selectTask(homeId);
    setWantsInput(true);
  }

  const cursorItem = createMemo(() => {
    const key = cursorKey();
    return items().find((i) => i.key === key) ?? null;
  });

  function walk(direction: 1 | -1): string | null {
    const walkable = new Set(
      rail()
        .filter((s) => WALKED.includes(s.section))
        .flatMap((s) => s.items.map((i) => i.key)),
    );
    const key = nextKey(order(), walkable, selectedKey(), direction);
    if (key) select(key);
    return key;
  }

  const anyWorking = createMemo(() =>
    items().some(
      (i) => i.type === "task" && i.task.agent_state === AgentState.working,
    ),
  );
  const spinner = () => (anyWorking() ? SPINNER[frame()] : SPINNER[0]);

  const board = createMemo(() => {
    version();
    const today = new Date().toISOString().slice(0, 10);
    const out: Record<BoardColumn, TaskRow[]> = {
      queued: [],
      working: [],
      blocked: [],
      left: [],
      agentdone: [],
    };
    const set = pending();
    for (const task of store.listTasks()) {
      const col = boardColumnOf(
        task,
        { hasPendingAction: set.has(task.id) },
        today,
      );
      if (col) out[col].push(task);
    }
    return out;
  });

  return (
    <AugContext.Provider
      value={{
        engine,
        version,
        status,
        now,
        spinner,
        rail,
        items,
        selectedKey,
        selected,
        select,
        selectTask,
        cursorKey,
        cursorItem,
        moveCursor: setCursorKey,
        walk,
        pending,
        facts: (task) => ({ hasPendingAction: pending().has(task.id) }),
        board,
        mode,
        setMode,
        projectFilter,
        setProjectFilter,
        homeId,
        goHome,
        wantsInput,
        setWantsInput,
        cycleProjectFilter,
      }}
    >
      {props.children}
    </AugContext.Provider>
  );
}
