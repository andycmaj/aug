// The work rail (sidebar): what still wants something from you, under its
// headings, oldest first. Moving the cursor selects the row; the actions on
// a row work from here as from the Canvas.

import {
  createEffect,
  createMemo,
  For,
  Index,
  on,
  Show,
  type Accessor,
} from "solid-js";
import type { Renderable, ScrollBoxRenderable } from "@opentui/core";
import {
  contrastingForeground,
  Pane,
  truncate,
  useFocus,
  useScope,
  useTheme,
  type Theme,
  type ThemeColor,
} from "@andycmaj/opentui-app";
import { Commands } from "../commands";
import { FILTER_COMMANDS } from "../keymap";
import { useRiker } from "../context/riker";
import { Lane, LANE_META } from "@riker/core/lanes";
import {
  ageLabel,
  baseKey,
  RAIL_FILTERS,
  SECTION_TITLES,
  TAG_MARK,
  type RailItem,
} from "@riker/core/rail";
import { prChip, prQueueWord } from "@riker/core/pr";
import { taskRef } from "@riker/core/rows";
import { AgentState, Kind, TaskStatus, type ProjectRow } from "@riker/core/types";
import { CHANNEL_WORD, priorityColor, toneColor, useLaneMeta } from "./ui";
import { ConnectorLine } from "./connector-line";
import type { TaskActions } from "./task-actions";

// A task in a project shows the project's name where its channel would be.
function projectChip(project: ProjectRow | null): string | null {
  const name = project?.tmux_session;
  return name ? `◫ ${name.length > 14 ? `${name.slice(0, 13)}…` : name}` : null;
}

export const RAIL_WIDTH = 46;
// A task under its project's row sits this much further in.
const NEST = 2;

const isNested = (item: RailItem) =>
  item.type === "task" && item.group !== null;

// How a row reads. A task with a PR shows its age, the PR's chip in the
// chip's color, then sub, in place of where the task came from.
interface RowView {
  bar: ThemeColor;
  bar2: ThemeColor;
  mark: string;
  markColor: ThemeColor;
  title: string;
  titleColor: ThemeColor;
  // Tag marks beside the title (★ Win, ◉ watched), where the row's place
  // does not already say it.
  tags?: string;
  sub: string;
  lead?: string;
  chip?: { text: string; color: ThemeColor } | null;
}

export function Rail(props: { actions: TaskActions }) {
  const riker = useRiker();
  const theme = useTheme();
  const { isPaneFocused, setActivePane } = useFocus();
  const focused = () => isPaneFocused("rail");
  let scrollRef: ScrollBoxRenderable | undefined;
  let pane: Renderable | undefined;

  // First visit: the first row is selected. A cursor whose row left the rail
  // comes back to the selected row, if the rail shows it.
  createEffect(() => {
    const list = riker.shownItems();
    if (list.length === 0) return;
    const shown = (key: string | null) => list.some((i) => i.key === key);
    if (!riker.selectedKey()) riker.select(list[0].key);
    else if (!shown(riker.cursorKey()))
      riker.moveCursor(riker.selectedRowKey() ?? list[0].key);
  });

  const cursorIndex = () =>
    riker.shownItems().findIndex((i) => i.key === riker.cursorKey());

  function rowOf(key: string | null): { top: number; height: number } {
    let row = 0;
    let first = true;
    for (const section of riker.shownRail()) {
      row += first ? 1 : 2;
      first = false;
      for (const item of section.items) {
        if (item.key === key) return { top: row, height: 2 };
        row += 3;
      }
    }
    return { top: 0, height: 1 };
  }

  createEffect(
    on([riker.cursorKey, riker.shownRail], ([key]) => {
      if (!scrollRef) return;
      const { top, height } = rowOf(key);
      const view = scrollRef.viewport.height ?? 10;
      // Keep the section heading in view when its first row is selected.
      const want = Math.max(0, top - 1);
      if (want < scrollRef.scrollTop) scrollRef.scrollTo(want);
      else if (top + height > scrollRef.scrollTop + view)
        scrollRef.scrollTo(top + height - view);
    }),
  );

  // A filter that hides the cursor's row, or leaves it on Home (which every
  // filter keeps), lands it on the first task the filter left.
  function landCursor() {
    const list = riker.shownItems();
    const at = list.find((i) => i.key === riker.cursorKey());
    if (at && !(at.type === "task" && at.task.kind === Kind.home)) return;
    const first =
      list.find((i) => i.type === "task" && i.task.kind !== Kind.home) ??
      list[0];
    if (first) riker.moveCursor(first.key);
  }

  const filterHandlers = Object.fromEntries(
    RAIL_FILTERS.map((f, i) => [
      FILTER_COMMANDS[i],
      () => {
        riker.toggleFilter(f.filter);
        landCursor();
      },
    ]),
  );

  function move(next: (i: number, n: number) => number) {
    const list = riker.shownItems();
    if (list.length === 0) return;
    const i = Math.max(0, cursorIndex());
    riker.moveCursor(
      list[Math.min(list.length - 1, Math.max(0, next(i, list.length)))].key,
    );
  }

  useScope(
    "rail",
    {
      [Commands.NAV_DOWN]: () => move((i) => i + 1),
      [Commands.NAV_UP]: () => move((i) => i - 1),
      [Commands.NAV_TOP]: () => move(() => 0),
      [Commands.NAV_BOTTOM]: () => move((_, n) => n - 1),
      // enter selects the row under the cursor; a project's view
      // has nothing to type into, so the rail keeps focus.
      [Commands.OPEN]: () => {
        const item = riker.cursorItem();
        riker.select(riker.cursorKey());
        if (item?.type !== "project") setActivePane("canvas");
      },
      [Commands.FOLD]: () => {
        const item = riker.cursorItem();
        if (item?.type === "project") riker.toggleFold(item.project.id);
      },
      [Commands.FILTER_CYCLE]: () => {
        riker.cycleFilter();
        landCursor();
      },
      [Commands.FILTER_CLEAR]: () => riker.clearFilter(),
      ...filterHandlers,
      ...props.actions,
    },
    { target: () => pane },
  );

  return (
    <Pane
      name="rail"
      variant="sidebar"
      width={RAIL_WIDTH}
      ref={(r) => (pane = r)}
    >
      <FilterBar />

      <scrollbox
        ref={(r: ScrollBoxRenderable) => (scrollRef = r)}
        paddingLeft={1}
        flexGrow={1}
        stickyScroll={false}
      >
        <Show when={riker.shownRail().length > 0} fallback={<EmptyRail />}>
          {/* Index, not For: the rail is rebuilt with fresh objects on every
              store write, and For would recreate every row (thousands of
              native text buffers) each time. By position, rows are reused
              and only their contents change. Headings and rows get an Index
              each, so a slot never turns from one into the other: a row
              behind a <Match> whose own memos ran before the Switch dropped
              it threw "Stale read from <Match>". */}
          <Index each={riker.shownRail()}>
            {(section, index) => (
              <>
                <box
                  paddingLeft={1}
                  marginTop={index > 0 ? 1 : 0}
                  flexDirection="row"
                >
                  <text fg={theme.accent} attributes={1}>
                    {section().done !== undefined
                      ? `${SECTION_TITLES[section().section]} (${section().done}/${section().count})`
                      : `${SECTION_TITLES[section().section]} (${section().count})`}
                  </text>
                </box>
                <Index each={section().items}>
                  {(item) => (
                    <RailRow
                      item={item()}
                      nested={isNested(item())}
                      cursor={riker.cursorKey() === item().key}
                      onTable={riker.selectedRowKey() === item().key}
                      twin={
                        riker.selectedRowKey() !== item().key &&
                        riker.selectedKey() === baseKey(item().key)
                      }
                      focused={focused()}
                      theme={theme}
                    />
                  )}
                </Index>
              </>
            )}
          </Index>
        </Show>
      </scrollbox>

      <ConnectorLine />
    </Pane>
  );
}

// status filter bar: a pill per status with its count, lit while it
// filters. Digits 1-9 toggle the pills in this order; f steps through them.
// Nine pills fit the rail only as mark+count with one space between. It is
// the rail's only header: the pills already count the work, so the inbox
// badge (ideas and messages wait on the Board's Inbox) rides at its end, and
// wraps under the pills when all nine are lit.
function FilterBar() {
  const riker = useRiker();
  const theme = useTheme();
  const anyOn = () => riker.railFilter().size > 0;
  return (
    <box
      flexDirection="row"
      paddingLeft={2}
      paddingTop={1}
      paddingBottom={1}
      flexShrink={0}
      flexWrap="wrap"
      justifyContent="space-evenly"
    >
      <For each={RAIL_FILTERS}>
        {(f) => {
          const on = () => riker.railFilter().has(f.filter);
          const count = () => riker.filterCounts()[f.filter];
          const color = () => toneColor(theme, f.tone);
          const fg = () =>
            on()
              ? contrastingForeground(color())
              : anyOn() || count() === 0
                ? (theme.borderSubtle ?? theme.textMuted)
                : color();
          return (
            <Show when={count() > 0}>
              <text
                fg={fg()}
                bg={on() ? color() : undefined}
                attributes={on() ? 1 : 0}
              >{` ${f.mark} ${count()} `}</text>
            </Show>
          );
        }}
      </For>
      <Show when={riker.inboxCount() > 0}>
        <text fg={theme.warning}>{` inbox ${riker.inboxCount()} `}</text>
      </Show>
    </box>
  );
}

function EmptyRail() {
  const theme = useTheme();
  return (
    <box paddingLeft={1} paddingTop={1} flexDirection="column">
      <text fg={theme.textMuted}>Nothing wants you right now.</text>
      <text fg={theme.textMuted}>New GitHub and Slack work lands here.</text>
    </box>
  );
}

// The highlight is the cursor while the rail has focus, and the selected row
// while it does not (tilt-tui's focused/unfocused selection). The selected
// row carries a ▸ in the gutter, beside its mark rather than in
// place of it: the task you are watching is the one whose lane you want to
// see move. The selected task's other row (a Win or a watched task is
// listed twice) carries a dim ▹: the same task.
function RailRow(props: {
  item: RailItem;
  nested: boolean;
  cursor: boolean;
  onTable: boolean;
  twin: boolean;
  focused: boolean;
  theme: Theme;
}) {
  const riker = useRiker();
  const metaOf = useLaneMeta();
  const theme = () => props.theme;
  const lit = () => (props.focused ? props.cursor : props.onTable);
  const selFg = () =>
    contrastingForeground(props.focused ? theme().primary : theme().secondary);
  const bg = () =>
    lit() ? (props.focused ? theme().primary : theme().secondary) : undefined;

  const subWidth = () => RAIL_WIDTH - 7 - (props.nested ? NEST : 0);
  // What its lane says, with the one fact that lane is about: which tasks
  // block it, why its agent stopped, that it landed while its agent works.
  const laneWord = (item: Extract<RailItem, { type: "task" }>) => {
    if (item.lane === Lane.blocked) {
      const by = riker.blockers(item.task.id);
      if (by.length) return `blocked by ${by.map(taskRef).join(", ")}`;
    }
    if (item.lane === Lane.stopped) {
      const why = riker.latestSession(item.task.id)?.end_reason;
      if (why) return `stopped: ${why}`;
    }
    // What review means here: read what it closed, or close it yourself.
    if (item.lane === Lane.ready)
      return item.task.status === TaskStatus.done
        ? "ready: its agent closed it"
        : "ready: yours to close";
    // Working outranks merged (an agent that landed its branch is often
    // still writing its note), so the word carries the merge; first, so a
    // cut sub line keeps it.
    if (item.lane === Lane.working && item.task.merged_at)
      return "merged, agent working";
    // Past review: its PR waits in GitHub's merge queue, or was put out.
    if (item.lane === Lane.review) {
      const queued = prQueueWord(riker.prStatus(item.task.id));
      if (queued) return queued;
    }
    return LANE_META[item.lane].word;
  };
  const view = createMemo((): RowView => {
    const item = props.item;
    const now = riker.now();
    switch (item.type) {
      case "task": {
        if (item.task.kind === Kind.home) {
          const working = item.task.agent_state === AgentState.working;
          return {
            bar: theme().primary,
            bar2: theme().borderSubtle ?? theme().textMuted,
            mark: working ? riker.spinner() : "⌂",
            markColor: theme().primary,
            title: "Home",
            titleColor: theme().text,
            sub: working ? "the Assistant is working" : "ask the Assistant · a",
          };
        }
        const meta = metaOf(item.lane);
        const working =
          item.task.agent_state === AgentState.working &&
          item.lane === Lane.working;
        const word = item.slipped ? "slipped" : laneWord(item);
        const age =
          item.lane === Lane.later && item.task.remind_at
            ? ageLabel(item.task.remind_at, now)
            : ageLabel(item.at, now);
        // The last read only: finding the PR anew is a few queries a row.
        const status = riker.prStatus(item.task.id);
        const chip = status ? prChip(status) : null;
        const project = projectChip(
          item.task.project_id ? riker.project(item.task.project_id) : null,
        );
        return {
          bar: item.slipped ? theme().error : toneColor(theme(), meta.tone),
          bar2:
            priorityColor(theme(), item.priority) ??
            theme().borderSubtle ??
            theme().textMuted,
          mark: working ? riker.spinner() : meta.mark,
          markColor: toneColor(theme(), meta.tone),
          title: item.task.title,
          titleColor: item.priority === "urgent" ? theme().error : theme().text,
          tags: item.tags.map((t) => TAG_MARK[t]).join(""),
          // A copy under Wins or Watching is out of its project: it names it,
          // PR chip or not.
          sub: chip
            ? [taskRef(item.task.id), item.copy ? project : null, word]
                .filter(Boolean)
                .join(" · ")
            : [
                age,
                (!props.nested && project) || CHANNEL_WORD[item.task.channel],
                taskRef(item.task.id),
                word,
              ].join(" · "),
          lead: `${age} · `,
          chip: chip && {
            text: chip.text,
            color: toneColor(theme(), chip.tone),
          },
        };
      }
      case "project": {
        const folded = riker.folded().has(item.project.id);
        // Folded, what its hidden tasks want from you still shows here.
        let asks = 0;
        let review = 0;
        let ready = 0;
        if (folded)
          for (const i of riker.items()) {
            if (i.type !== "task" || i.group !== item.project.id) continue;
            if (i.lane === Lane.waiting) asks++;
            if (i.lane === Lane.ready) review++;
            if (i.lane === Lane.approve) ready++;
          }
        return {
          bar: item.working ? theme().info : theme().secondary,
          bar2: theme().borderSubtle ?? theme().textMuted,
          mark: item.working ? riker.spinner() : folded ? "⊞" : "⊟",
          markColor: item.working ? theme().info : theme().secondary,
          title: item.project.name,
          titleColor: theme().text,
          sub: [
            `${item.open} open`,
            item.working ? `${item.working} working` : "",
            item.goals ? `goals ${item.goalsMet}/${item.goals}` : "",
            asks ? `${LANE_META.waiting.mark} ${asks}` : "",
            review ? `${LANE_META.ready.mark} ${review}` : "",
            ready ? `${LANE_META.approve.mark} ${ready}` : "",
            item.repos.join(", ") || "no repo",
          ]
            .filter(Boolean)
            .join(" · "),
        };
      }
    }
  });

  return (
    <box
      flexDirection="row"
      marginLeft={props.nested ? NEST : 0}
      marginBottom={1}
    >
      <text fg={props.onTable ? theme().accent : theme().textMuted}>
        {props.onTable ? "▸" : props.twin ? "▹" : " "}
      </text>
      <box flexDirection="column" flexGrow={1} backgroundColor={bg()}>
        <box flexDirection="row" gap={1}>
          <text bg={view().bar}> </text>
          <text fg={lit() ? selFg() : view().markColor}>{view().mark}</text>
          <Show when={view().tags}>
            <text fg={lit() ? selFg() : theme().warning}>{view().tags}</text>
          </Show>
          <text
            fg={lit() ? selFg() : view().titleColor}
            attributes={lit() ? 1 : 0}
          >
            {truncate(
              view().title,
              RAIL_WIDTH -
                9 -
                (props.nested ? NEST : 0) -
                (view().tags ? (view().tags ?? "").length + 1 : 0),
            )}
          </text>
        </box>
        <box flexDirection="row" gap={1}>
          <text bg={view().bar2}> </text>
          <Show
            when={view().chip}
            fallback={
              <text fg={lit() ? selFg() : theme().textMuted}>
                {truncate(view().sub, subWidth())}
              </text>
            }
          >
            {(chip: Accessor<{ text: string; color: ThemeColor }>) => (
              <text fg={lit() ? selFg() : theme().textMuted}>
                <span>{view().lead ?? ""}</span>
                <span style={{ fg: lit() ? selFg() : chip().color }}>
                  {chip().text}
                </span>
                <span>
                  {truncate(
                    ` · ${view().sub}`,
                    Math.max(
                      0,
                      subWidth() -
                        (view().lead ?? "").length -
                        chip().text.length,
                    ),
                  )}
                </span>
              </text>
            )}
          </Show>
        </box>
      </box>
    </box>
  );
}

interface LegendEntry {
  bar: ThemeColor;
  mark: string;
  markColor: ThemeColor;
  word: string;
}

// Done never reaches the rail, so it has no place in the key.
const LEGEND_LANES = (Object.keys(LANE_META) as Lane[]).filter(
  (l) => l !== Lane.done,
);
const LEGEND_COLUMN = 28;

// The help dialog's key to the rail's colors and marks. Lanes come from
// LANE_META, so a new lane shows here without anyone remembering to add it.
export function RailLegend() {
  const theme = useTheme();
  const metaOf = useLaneMeta();
  const entries = (): LegendEntry[] => [
    ...LEGEND_LANES.map((lane) => {
      const meta = metaOf(lane);
      const color = toneColor(theme, meta.tone);
      return { bar: color, mark: meta.mark, markColor: color, word: meta.word };
    }),
    {
      bar: theme.error,
      mark: LANE_META.theirs.mark,
      markColor: theme.textMuted,
      word: "slipped, quiet 3+ days",
    },
    {
      bar: theme.primary,
      mark: "⌂",
      markColor: theme.primary,
      word: "Home",
    },
    {
      bar: theme.borderSubtle ?? theme.textMuted,
      mark: TAG_MARK.win,
      markColor: theme.warning,
      word: "Win, listed under Wins",
    },
    {
      bar: theme.borderSubtle ?? theme.textMuted,
      mark: TAG_MARK.watching,
      markColor: theme.warning,
      word: "watched, under Watching",
    },
    {
      bar: theme.secondary,
      mark: "⊟",
      markColor: theme.secondary,
      word: "project",
    },
    {
      bar: theme.info,
      mark: "⊟",
      markColor: theme.info,
      word: "project, agents working",
    },
  ];
  const columns = () => {
    const all = entries();
    const half = Math.ceil(all.length / 2);
    return [all.slice(0, half), all.slice(half)];
  };

  return (
    <box flexDirection="column">
      <text fg={theme.accent} attributes={1}>
        The rail's colors
      </text>
      <box flexDirection="row">
        <For each={columns()}>
          {(column) => (
            <box flexDirection="column" width={LEGEND_COLUMN} flexShrink={0}>
              <For each={column}>
                {(e) => (
                  <box flexDirection="row" gap={1}>
                    <text bg={e.bar}> </text>
                    <text fg={e.markColor}>{e.mark}</text>
                    <text fg={theme.textMuted}>{e.word}</text>
                  </box>
                )}
              </For>
            </box>
          )}
        </For>
      </box>
      <box flexDirection="row" gap={1} marginTop={1}>
        <text fg={theme.textMuted}>lower bar</text>
        <text bg={theme.error}> </text>
        <text fg={theme.textMuted}>urgent</text>
        <text bg={theme.secondary}> </text>
        <text fg={theme.textMuted}>important</text>
        <text fg={theme.accent}>▸</text>
        <text fg={theme.textMuted}>selected</text>
      </box>
    </box>
  );
}
