// The app's view of the store. Views read through the read model
// (core/read-model.ts), each read subscribing to the tables it queries. A
// table's signal bumps when its row in table_versions moves: checked on any
// in-process write (store.onChange) and when another process commits (an
// agent's hook; PRAGMA data_version).

import {
  batch,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type ParentProps,
  type Setter,
} from "solid-js";
import { createRequiredContext } from "@andycmaj/opentui-app";
import { coalesce } from "../core/coalesce";
import { dataVersion, TABLES, tableVersions, type Table } from "../core/db";
import type { Desk } from "../core/desk";
import { Engine, type EngineStatus } from "../core/engine";
import type { BoardColumn, LaneFacts } from "../core/lanes";
import { count, perfOn, sample, timing } from "../core/perf";
import { readModel, readsRun, type ReadModel } from "../core/read-model";
import {
  cycleFilter as nextFilter,
  filterCounts,
  filterRail,
  flattenRail,
  foldRail,
  nextKey,
  WALKED,
  type RailFilter,
  type RailItem,
  type RailSection,
} from "../core/rail";
import { onChange } from "../core/store";
import { useRenderPerf } from "./render-perf";
import { AgentState, type TaskRow } from "../core/types";

export const ViewMode = { chat: "chat", board: "board" } as const;
export type ViewMode = (typeof ViewMode)[keyof typeof ViewMode];

// The read model's reads sit on the context itself: aug.task(id),
// aug.turns(id), aug.pendingAction(id).
interface AugContextValue extends ReadModel {
  engine: Engine;
  // The owner's moves: what the keys and the palette call.
  desk: Desk;
  status: Accessor<EngineStatus>;
  now: Accessor<Date>;
  spinner: Accessor<string>;
  // Every row, folded ones included.
  rail: Accessor<RailSection[]>;
  items: Accessor<RailItem[]>;
  // What the rail shows: the status filter applied and folded projects'
  // tasks left out. The cursor and the walk move over these.
  shownRail: Accessor<RailSection[]>;
  shownItems: Accessor<RailItem[]>;
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
  // Projects whose tasks the rail hides under their row.
  folded: Accessor<Set<number>>;
  toggleFold: (projectId: number) => void;
  // The rail's status filter; empty shows every status.
  railFilter: Accessor<Set<RailFilter>>;
  filterCounts: Accessor<Record<RailFilter, number>>;
  toggleFilter: (filter: RailFilter) => void;
  cycleFilter: () => void;
  clearFilter: () => void;
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

export function AugProvider(props: ParentProps<{ engine: Engine }>) {
  const engine = props.engine;
  // One counter per table; a read subscribes to the ones it queries.
  const tableSignals = new Map<Table, [Accessor<number>, Setter<number>]>(
    TABLES.map((t) => [t, createSignal(0)]),
  );
  const track = (tables: readonly Table[]) => {
    for (const t of tables) tableSignals.get(t)![0]();
  };
  const reads = readModel(track, engine.desk);
  let seenTables = tableVersions();
  const refresh = () => {
    const started = performance.now();
    const runsBefore = readsRun();
    const next = tableVersions();
    const bumped: Table[] = [];
    batch(() => {
      for (const t of TABLES)
        if (next[t] !== seenTables[t]) {
          bumped.push(t);
          tableSignals.get(t)![1]((v) => v + 1);
        }
    });
    seenTables = next;
    // Solid re-runs the reads over the bumped tables when the batch ends,
    // so this times the whole fan-out a write causes (not the frame).
    if (!perfOn()) return;
    for (const t of bumped) count(`bump.${t}`);
    const reran = readsRun() - runsBefore;
    timing("tui.refresh", performance.now() - started, { tables: bumped.join(","), reads: reran });
    sample("tui.refresh_reads", reran, "reads");
  };
  const [status, setStatus] = createSignal(engine.status);
  const [now, setNow] = createSignal(new Date());
  const [frame, setFrame] = createSignal(0);
  const [mode, setMode] = createSignal<ViewMode>(ViewMode.chat);
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null);
  const [cursorKey, setCursorKey] = createSignal<string | null>(null);
  // Writes come in bursts (a poll files a dozen messages, each with a few
  // writes), and every bump re-runs the views over the tables it touched.
  // One redraw per burst keeps that from churning thousands of native text
  // buffers.
  const redraw = coalesce(refresh);
  useRenderPerf();
  const bump = () => redraw.schedule();

  onMount(() => {
    const offChange = onChange(bump);
    const offStatus = engine.onStatus(setStatus);
    let seen = dataVersion();
    const poll = setInterval(() => {
      const v = dataVersion();
      if (v !== seen) {
        seen = v;
        count("tui.data_version");
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
      redraw.cancel();
    });
  });

  const pending = createMemo(() => reads.tasksWithPendingAction());

  const [folded, setFolded] = createSignal<Set<number>>(new Set());
  const setFold = (projectId: number, on: boolean) => {
    if (folded().has(projectId) === on) return;
    const next = new Set(folded());
    if (on) next.add(projectId);
    else next.delete(projectId);
    setFolded(next);
  };

  const homeId = reads.home().id;
  const [wantsInput, setWantsInput] = createSignal(false);

  const rail = createMemo(() => reads.rail(now(), pending()));

  const items = createMemo(() => flattenRail(rail()));
  const [railFilter, setRailFilter] = createSignal<Set<RailFilter>>(new Set());
  const filtered = createMemo(() => filterRail(rail(), railFilter()));
  const counts = createMemo(() => filterCounts(rail()));
  const shownRail = createMemo(() => foldRail(filtered(), folded()));
  const shownItems = createMemo(() => flattenRail(shownRail()));
  // The order the walk last saw, so Next from a row that just left the rail
  // (marked done) goes on from where it stood.
  let lastOrder: string[] = [];
  const order = createMemo(() => {
    const keys = shownItems().map((i) => i.key);
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

  // A task put on the table from anywhere (Next, an @ link) unfolds its
  // project so the rail can show it.
  function select(key: string | null) {
    // A row written a moment ago (a new task) is on the rail before we look.
    redraw.flush();
    const item = items().find((i) => i.key === key);
    if (item?.type === "task" && item.group !== null)
      setFold(item.group, false);
    // Nor does the status filter hide it: like tilt-tui's picker, going to
    // a row the filter leaves out clears the filter.
    if (
      item &&
      railFilter().size > 0 &&
      !flattenRail(filtered()).some((i) => i.key === key)
    )
      setRailFilter(new Set<RailFilter>());
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

  // Folding a project brings the cursor up to its row.
  function toggleFold(projectId: number) {
    redraw.flush();
    const fold = !folded().has(projectId);
    if (fold) {
      const under = items().find((i) => i.key === cursorKey());
      if (under?.type === "task" && under.group === projectId)
        setCursorKey(`p${projectId}`);
    }
    setFold(projectId, fold);
  }

  function toggleFilter(filter: RailFilter) {
    redraw.flush();
    const next = new Set(railFilter());
    if (next.has(filter)) next.delete(filter);
    else next.add(filter);
    setRailFilter(next);
  }

  function walk(direction: 1 | -1): string | null {
    redraw.flush();
    const walkable = new Set(
      shownRail()
        .filter((s) => WALKED.includes(s.section))
        .flatMap((s) => s.items)
        .filter((i) => i.type !== "project")
        .map((i) => i.key),
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

  const board = createMemo((): Record<BoardColumn, TaskRow[]> =>
    reads.board(pending()),
  );

  return (
    <AugContext.Provider
      value={{
        ...reads,
        engine,
        desk: engine.desk,
        status,
        now,
        spinner,
        rail,
        items,
        shownRail,
        shownItems,
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
        folded,
        toggleFold,
        railFilter,
        filterCounts: counts,
        toggleFilter,
        cycleFilter: () => {
          redraw.flush();
          setRailFilter(nextFilter(railFilter(), counts()));
        },
        clearFilter: () => setRailFilter(new Set<RailFilter>()),
        homeId,
        goHome,
        wantsInput,
        setWantsInput,
      }}
    >
      {props.children}
    </AugContext.Provider>
  );
}
