// The app's view of the store. Views read through the read model
// (core/read-model.ts), each read subscribing to the tables it queries. A
// table's signal bumps when its row in table_versions moves: checked on any
// in-process write (store.onChange) and when another process commits (an
// agent's hook; PRAGMA data_version).

import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
  type ParentProps,
  type Setter,
} from "solid-js";
import { createRequiredContext, PaletteMode } from "@andycmaj/opentui-app";
import { coalesce } from "@riker/core/coalesce";
import { dataVersion, TABLES, tableVersions, type Table } from "@riker/core/db";
import type { Desk } from "@riker/core/desk";
import { Engine, type EngineStatus } from "@riker/core/engine";
import { laneOf, type BoardColumn, type LaneFacts } from "@riker/core/lanes";
import { count, perfOn, sample, timing } from "@riker/core/perf";
import { readModel, readsRun, type ReadModel } from "@riker/core/read-model";
import {
  baseKey,
  cycleFilter as nextFilter,
  filterCounts,
  filterRail,
  flattenRail,
  foldRail,
  nextKey,
  rowFor,
  Section,
  walkableKeys,
  type RailFilter,
  type RailItem,
  type RailSection,
} from "@riker/core/rail";
import { onChange } from "@riker/core/store";
import { NavHistory, type Place } from "@riker/core/nav-history";
import { useRenderPerf } from "./render-perf";
import { AgentState, type TaskRow } from "@riker/core/types";

export const ViewMode = { chat: "chat", board: "board" } as const;
export type ViewMode = (typeof ViewMode)[keyof typeof ViewMode];

// The read model's reads sit on the context itself: riker.task(id),
// riker.turns(id), riker.pendingAction(id).
interface RikerContextValue extends ReadModel {
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
  // The selected task's key (`t<id>`, never a copy's row key): what the
  // Canvas shows. A task listed twice (a Win, a watched task) is one
  // selection on either row.
  selectedKey: Accessor<string | null>;
  selected: Accessor<RailItem | null>;
  // The shown row that stands for the selection: the cursor's, when it is
  // on one of the selected task's rows, else the task's own row.
  selectedRowKey: Accessor<string | null>;
  // Selects a row; the rail cursor follows it.
  select: (key: string | null) => void;
  selectTask: (taskId: number) => void;
  // A task selected that has no rail row (done or dropped): its key.
  offRailKey: Accessor<string | null>;
  // The rail's highlight, which moves without changing the selection.
  cursorKey: Accessor<string | null>;
  cursorItem: Accessor<RailItem | null>;
  moveCursor: (key: string | null) => void;
  walk: (direction: 1 | -1) => string | null;
  // Selects a row in Chat from anywhere (the Board too): a jump.
  goTo: (key: string) => void;
  // Back and forward through the places you have been (core/nav-history).
  // False when there is nowhere to go.
  history: (direction: 1 | -1) => boolean;
  // Rows seen lately, most recent first, the selected one left out.
  recent: Accessor<RailItem[]>;
  pending: Accessor<Set<number>>;
  facts: (task: TaskRow) => LaneFacts;
  board: Accessor<Record<BoardColumn, TaskRow[]>>;
  mode: Accessor<ViewMode>;
  setMode: (mode: ViewMode) => void;
  // Projects whose tasks the rail hides under their row.
  folded: Accessor<Set<number>>;
  toggleFold: (projectId: number) => void;
  // The palette's mode, kept for the session and shared by Chat and Board.
  paletteMode: Accessor<PaletteMode>;
  setPaletteMode: (mode: PaletteMode) => void;
  // Whether the go-to list shows done and dropped work, kept for the session.
  searchShowsDone: Accessor<boolean>;
  setSearchShowsDone: (on: boolean) => void;
  // The rail's status filter; empty shows every status.
  railFilter: Accessor<Set<RailFilter>>;
  filterCounts: Accessor<Record<RailFilter, number>>;
  toggleFilter: (filter: RailFilter) => void;
  cycleFilter: () => void;
  clearFilter: () => void;
  // Home: the Assistant's thread, first on the rail.
  homeId: number;
  // Selects Home in Chat and asks for its box to take focus.
  goHome: () => void;
  // Chat focuses the box once it is mounted, then clears this.
  wantsInput: Accessor<boolean>;
  setWantsInput: (on: boolean) => void;
}

const [RikerContext, useRiker] = createRequiredContext<RikerContextValue>("Riker");
export { useRiker };

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function RikerProvider(props: ParentProps<{ engine: Engine }>) {
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

  // Kept in kv by the desk, so a restart opens the rail folded as it was.
  const [folded, setFolded] = createSignal<Set<number>>(
    engine.desk.foldedProjects(),
  );
  const setFold = (projectId: number, on: boolean) => {
    if (folded().has(projectId) === on) return;
    const next = new Set(folded());
    if (on) next.add(projectId);
    else next.delete(projectId);
    setFolded(next);
    engine.desk.setFoldedProjects(next);
  };

  const homeId = reads.home().id;
  const [wantsInput, setWantsInput] = createSignal(false);

  const rail = createMemo(() => reads.rail(now(), pending()));

  const items = createMemo(() => flattenRail(rail()));
  const [railFilter, setRailFilter] = createSignal<Set<RailFilter>>(new Set());
  const [paletteMode, setPaletteMode] = createSignal<PaletteMode>(
    PaletteMode.CONTEXT,
  );
  const [searchShowsDone, setSearchShowsDone] = createSignal(false);
  const filtered = createMemo(() => filterRail(rail(), railFilter()));
  const counts = createMemo(() => filterCounts(rail()));
  const shownRail = createMemo(() => foldRail(filtered(), folded()));
  const shownItems = createMemo(() => flattenRail(shownRail()));
  // Where the selection is on the rail. A row that just left keeps its key
  // here while the cursor is still on it, so Next goes on from it.
  const currentRow = (): string | null => {
    const sel = selectedKey();
    const cur = cursorKey();
    if (sel && cur && baseKey(cur) === sel) return cur;
    return rowFor(shownItems(), sel)?.key ?? sel;
  };
  const selectedRowKey = createMemo((): string | null => {
    const key = currentRow();
    return shownItems().some((i) => i.key === key) ? key : null;
  });
  // The order the walk last saw, so Next from a row that just left the rail
  // (marked done) goes on from where it stood.
  let lastOrder: string[] = [];
  const order = createMemo(() => {
    const keys = shownItems().map((i) => i.key);
    const current = currentRow();
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

  // A task the rail leaves out (done, dropped) that was gone to on purpose,
  // from the Inbox or the Board: the Canvas shows it all the same. Only the
  // one asked for, so a row that leaves the rail while selected (marked
  // done) still clears it.
  const [offRail, setOffRail] = createSignal<string | null>(null);

  const selected = createMemo((): RailItem | null => {
    const key = selectedKey();
    const item = rowFor(items(), key);
    if (item) return item;
    if (!key || key !== offRail()) return null;
    const task = reads.task(Number(key.slice(1)));
    if (!task) return null;
    return {
      type: "task",
      key,
      task,
      lane: laneOf(task, { hasPendingAction: pending().has(task.id) }),
      priority: task.priority,
      slipped: false,
      at: task.created_at,
      group: null,
      copy: false,
      tags: [],
    };
  });

  // A task selected from anywhere (Next, an @ link) unfolds its
  // project so the rail can show it. A task's key lands on its own row; a
  // copy's row key (from the rail) on that row.
  function select(key: string | null) {
    // A row written a moment ago (a new task) is on the rail before we look.
    redraw.flush();
    const item = rowFor(items(), key);
    if (item?.type === "task" && item.group !== null)
      setFold(item.group, false);
    // Nor does the status filter hide it: like tilt-tui's picker, going to
    // a row the filter leaves out clears the filter.
    if (
      item &&
      railFilter().size > 0 &&
      !flattenRail(filtered()).some((i) => i.key === item.key)
    )
      setRailFilter(new Set<RailFilter>());
    const base = baseKey(key);
    setOffRail(!item && base?.startsWith("t") ? base : null);
    setSelectedKey(base);
    setCursorKey(item?.key ?? base);
  }

  function selectTask(taskId: number) {
    select(`t${taskId}`);
  }

  function goHome() {
    setMode(ViewMode.chat);
    selectTask(homeId);
    setWantsInput(true);
  }

  // A task gone to off the rail (done or dropped, from go-to or the Board)
  // has no row: the cursor stands on it all the same, so the rail's keys (d
  // reopens) reach it until the cursor moves.
  const cursorItem = createMemo(() => {
    const key = cursorKey();
    const row = items().find((i) => i.key === key);
    if (row) return row;
    const off = selected();
    return off && off.key === key && key === offRail() ? off : null;
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
    const walkable = walkableKeys(shownRail(), selectedKey());
    const key = nextKey(order(), walkable, currentRow(), direction);
    if (key) select(key);
    return key;
  }

  function goTo(key: string) {
    batch(() => {
      setMode(ViewMode.chat);
      select(key);
    });
  }

  // Every way to change the selection or the view (open, walk, search, Home, v)
  // is a visit. Recorded after the handler that moved it is done, so a
  // switch to Chat and a select in one key make one visit, not two.
  // A task open on the Canvas while a timer on it rings (the rail's Due):
  // you have seen it, so it stops, whether you went to it or it fired while
  // you were there.
  createEffect(() => {
    const key = selectedKey();
    if (mode() !== ViewMode.chat || !key) return;
    const due = rail().find((s) => s.section === Section.due);
    if (due?.items.some((i) => baseKey(i.key) === key))
      engine.desk.seenTimers(Number(key.slice(1)));
  });

  const trail = new NavHistory();
  const [trailMoved, setTrailMoved] = createSignal(0);
  let recordQueued = false;
  const here = (): Place | null => {
    if (mode() === ViewMode.board) return { view: "board" };
    const key = selectedKey();
    return key ? { view: "chat", key } : null;
  };
  createEffect(() => {
    mode();
    selectedKey();
    if (recordQueued) return;
    recordQueued = true;
    queueMicrotask(() => {
      recordQueued = false;
      const place = here();
      if (!place) return;
      trail.visit(place);
      setTrailMoved((n) => n + 1);
    });
  });
  const exists = (place: Place) =>
    place.view === "board" || rowFor(items(), place.key) !== null;
  function history(direction: 1 | -1): boolean {
    redraw.flush();
    const place = direction < 0 ? trail.back(exists) : trail.forward(exists);
    if (!place) return false;
    if (place.view === "board") setMode(ViewMode.board);
    else goTo(place.key);
    return true;
  }
  const recent = createMemo(() => {
    trailMoved();
    const list = items();
    return trail.recent().flatMap((k) => rowFor(list, k) ?? []);
  });

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
    <RikerContext.Provider
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
        selectedRowKey,
        select,
        selectTask,
        offRailKey: offRail,
        cursorKey,
        cursorItem,
        moveCursor: setCursorKey,
        walk,
        goTo,
        history,
        recent,
        pending,
        facts: (task) => ({ hasPendingAction: pending().has(task.id) }),
        board,
        mode,
        setMode,
        folded,
        toggleFold,
        paletteMode,
        setPaletteMode,
        searchShowsDone,
        setSearchShowsDone,
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
    </RikerContext.Provider>
  );
}
