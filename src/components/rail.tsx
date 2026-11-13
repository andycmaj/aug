// The work rail (sidebar): what still wants something from you, under its
// headings, oldest first. Moving the cursor puts the row on the table; the
// actions on a row work from here as from the table.

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
  PaneHeader,
  truncate,
  useFocus,
  useScope,
  useTheme,
  type Theme,
  type ThemeColor,
} from "@andycmaj/opentui-app";
import { Commands } from "../commands";
import { useAug } from "../context/aug";
import { Lane, LANE_META } from "../core/lanes";
import {
  ageLabel,
  SECTION_TITLES,
  SHOW_FYI,
  type RailItem,
} from "../core/rail";
import { prChip } from "../core/pr";
import { getProject, prStatus as getPrStatus, taskRef } from "../core/store";
import { AgentState, Kind } from "../core/types";
import { CHANNEL_WORD, priorityColor, toneColor } from "./ui";
import { ConnectorLine } from "./connector-line";
import type { TaskActions } from "./task-actions";

// A task in a project shows the project's name where its channel would be.
function projectChip(projectId: number | null): string | null {
  if (!projectId) return null;
  const name = getProject(projectId)?.tmux_session;
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
  sub: string;
  lead?: string;
  chip?: { text: string; color: ThemeColor } | null;
}

export function Rail(props: { actions: TaskActions }) {
  const aug = useAug();
  const theme = useTheme();
  const { isPaneFocused, setActivePane } = useFocus();
  const focused = () => isPaneFocused("rail");
  let scrollRef: ScrollBoxRenderable | undefined;
  let pane: Renderable | undefined;

  // First visit: the first row is on the table. A cursor whose row left the
  // rail comes back to the table's row, if the rail shows it.
  createEffect(() => {
    const list = aug.shownItems();
    if (list.length === 0) return;
    const shown = (key: string | null) => list.some((i) => i.key === key);
    if (!aug.selectedKey()) aug.select(list[0].key);
    else if (!shown(aug.cursorKey()))
      aug.moveCursor(
        shown(aug.selectedKey()) ? aug.selectedKey() : list[0].key,
      );
  });

  const cursorIndex = () =>
    aug.shownItems().findIndex((i) => i.key === aug.cursorKey());

  function rowOf(key: string | null): { top: number; height: number } {
    let row = 0;
    let first = true;
    for (const section of aug.shownRail()) {
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
    on([aug.cursorKey, aug.shownRail], ([key]) => {
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

  function move(next: (i: number, n: number) => number) {
    const list = aug.shownItems();
    if (list.length === 0) return;
    const i = Math.max(0, cursorIndex());
    aug.moveCursor(
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
      // enter puts the row under the cursor on the table; a project's view
      // has nothing to type into, so the rail keeps focus.
      [Commands.OPEN]: () => {
        const item = aug.cursorItem();
        aug.select(aug.cursorKey());
        if (item?.type !== "project") setActivePane("task");
      },
      [Commands.FOLD]: () => {
        const item = aug.cursorItem();
        if (item?.type === "project") aug.toggleFold(item.project.id);
      },
      ...props.actions,
    },
    { target: () => pane },
  );

  const counts = createMemo(() => {
    let blocked = 0;
    let approve = 0;
    let tasks = 0;
    for (const s of aug.rail()) {
      if (s.section !== "tasks" && s.section !== "reviews") continue;
      for (const i of s.items) {
        if (i.type !== "task") continue;
        tasks++;
        if (i.lane === Lane.blocked) blocked++;
        if (i.lane === Lane.approve) approve++;
      }
    }
    return { blocked, approve, tasks };
  });

  return (
    <Pane
      name="rail"
      variant="sidebar"
      width={RAIL_WIDTH}
      ref={(r) => (pane = r)}
    >
      <PaneHeader title="Work">
        <text>
          <Show when={counts().blocked > 0}>
            <span
              style={{ fg: theme.warning }}
            >{`${LANE_META.blocked.mark} ${counts().blocked}  `}</span>
          </Show>
          <Show when={counts().approve > 0}>
            <span
              style={{ fg: theme.success }}
            >{`${LANE_META.approve.mark} ${counts().approve}  `}</span>
          </Show>
          <span
            style={{ fg: theme.textMuted }}
          >{`${counts().tasks} open`}</span>
        </text>
      </PaneHeader>

      <scrollbox
        ref={(r: ScrollBoxRenderable) => (scrollRef = r)}
        paddingLeft={1}
        flexGrow={1}
        stickyScroll={false}
      >
        <Show when={aug.shownRail().length > 0} fallback={<EmptyRail />}>
          {/* Index, not For: the rail is rebuilt with fresh objects on every
              store write, and For would recreate every row (thousands of
              native text buffers) each time. By position, rows are reused
              and only their contents change. Headings and rows get an Index
              each, so a slot never turns from one into the other: a row
              behind a <Match> whose own memos ran before the Switch dropped
              it threw "Stale read from <Match>". */}
          <Index each={aug.shownRail()}>
            {(section, index) => (
              <>
                <box
                  paddingLeft={1}
                  marginTop={index > 0 ? 1 : 0}
                  flexDirection="row"
                >
                  <text fg={theme.accent} attributes={1}>
                    {`${SECTION_TITLES[section().section]} (${section().count})`}
                  </text>
                </box>
                <Index each={section().items}>
                  {(item) => (
                    <RailRow
                      item={item()}
                      nested={isNested(item())}
                      cursor={aug.cursorKey() === item().key}
                      onTable={aug.selectedKey() === item().key}
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

function EmptyRail() {
  const theme = useTheme();
  return (
    <box paddingLeft={1} paddingTop={1} flexDirection="column">
      <text fg={theme.textMuted}>Nothing wants you right now.</text>
      <text fg={theme.textMuted}>New GitHub and Slack work lands here.</text>
    </box>
  );
}

// The highlight is the cursor while the rail has focus, and the row on the
// table while it does not (tilt-tui's focused/unfocused selection). The row
// on the table always carries a ▸.
function RailRow(props: {
  item: RailItem;
  nested: boolean;
  cursor: boolean;
  onTable: boolean;
  focused: boolean;
  theme: Theme;
}) {
  const aug = useAug();
  const theme = () => props.theme;
  const lit = () => (props.focused ? props.cursor : props.onTable);
  const selFg = () =>
    contrastingForeground(props.focused ? theme().primary : theme().secondary);
  const bg = () =>
    lit() ? (props.focused ? theme().primary : theme().secondary) : undefined;

  const subWidth = () => RAIL_WIDTH - 7 - (props.nested ? NEST : 0);
  const view = createMemo((): RowView => {
    const item = props.item;
    const now = aug.now();
    switch (item.type) {
      case "task": {
        if (item.task.kind === Kind.home) {
          const working = item.task.agent_state === AgentState.working;
          return {
            bar: theme().primary,
            bar2: theme().borderSubtle ?? theme().textMuted,
            mark: working ? aug.spinner() : "⌂",
            markColor: theme().primary,
            title: "Home",
            titleColor: theme().text,
            sub: working ? "the Assistant is working" : "ask the Assistant · a",
          };
        }
        const meta = LANE_META[item.lane];
        const working =
          item.task.agent_state === AgentState.working &&
          item.lane === Lane.working;
        const word = item.slipped ? "slipped" : meta.word;
        const age =
          item.lane === Lane.later && item.task.remind_at
            ? ageLabel(item.task.remind_at, now)
            : ageLabel(item.at, now);
        // The last read only: finding the PR anew is a few queries a row.
        aug.version();
        const status = getPrStatus(item.task.id);
        const chip = status ? prChip(status) : null;
        return {
          bar: item.slipped ? theme().error : toneColor(theme(), meta.tone),
          bar2:
            priorityColor(theme(), item.priority) ??
            theme().borderSubtle ??
            theme().textMuted,
          mark: working ? aug.spinner() : meta.mark,
          markColor: toneColor(theme(), meta.tone),
          title: item.task.title,
          titleColor: item.priority === "urgent" ? theme().error : theme().text,
          sub: chip
            ? `${taskRef(item.task.id)} · ${word}`
            : [
                age,
                (!props.nested && projectChip(item.task.project_id)) ||
                  CHANNEL_WORD[item.task.channel],
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
      case "fyi":
        return {
          bar: theme().textMuted,
          bar2: theme().borderSubtle ?? theme().textMuted,
          mark: "·",
          markColor: theme().textMuted,
          title: `${item.message.author_name}: ${item.message.body.replace(/\s+/g, " ")}`,
          titleColor: theme().textMuted,
          sub: `${ageLabel(item.at, now)} · ${CHANNEL_WORD[item.message.channel]} · ${item.message.reason ?? "fyi"}`,
        };
      case "project": {
        const folded = aug.folded().has(item.project.id);
        // Folded, what its hidden tasks want from you still shows here.
        let asks = 0;
        let ready = 0;
        if (folded)
          for (const i of aug.items()) {
            if (i.type !== "task" || i.group !== item.project.id) continue;
            if (i.lane === Lane.blocked) asks++;
            if (i.lane === Lane.approve) ready++;
          }
        return {
          bar: item.working ? theme().info : theme().secondary,
          bar2: theme().borderSubtle ?? theme().textMuted,
          mark: item.working ? aug.spinner() : folded ? "⊞" : "⊟",
          markColor: item.working ? theme().info : theme().secondary,
          title: item.project.name,
          titleColor: theme().text,
          sub: [
            `${item.open} open`,
            item.working ? `${item.working} working` : "",
            item.goals ? `goals ${item.goalsMet}/${item.goals}` : "",
            asks ? `${LANE_META.blocked.mark} ${asks}` : "",
            ready ? `${LANE_META.approve.mark} ${ready}` : "",
            item.repos.join(", ") || "no repo",
          ]
            .filter(Boolean)
            .join(" · "),
        };
      }
      case "idea":
        return {
          bar: theme().accent,
          bar2: theme().borderSubtle ?? theme().textMuted,
          mark: "*",
          markColor: theme().accent,
          title: item.idea.title,
          titleColor: theme().text,
          sub: `${ageLabel(item.at, now)} · advisor idea`,
        };
    }
  });

  return (
    <box
      flexDirection="column"
      marginLeft={props.nested ? 1 + NEST : 1}
      marginBottom={1}
      backgroundColor={bg()}
    >
      <box flexDirection="row" gap={1}>
        <text bg={view().bar}> </text>
        <text
          fg={
            lit() ? selFg() : props.onTable ? theme().accent : view().markColor
          }
        >
          {props.onTable ? "▸" : view().mark}
        </text>
        <text
          fg={lit() ? selFg() : view().titleColor}
          attributes={lit() ? 1 : 0}
        >
          {truncate(view().title, RAIL_WIDTH - 9 - (props.nested ? NEST : 0))}
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
  const entries = (): LegendEntry[] => [
    ...LEGEND_LANES.map((lane) => {
      const meta = LANE_META[lane];
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
    {
      bar: theme.accent,
      mark: "*",
      markColor: theme.accent,
      word: "advisor idea",
    },
    ...(SHOW_FYI
      ? [
          {
            bar: theme.textMuted,
            mark: "·",
            markColor: theme.textMuted,
            word: "fyi",
          },
        ]
      : []),
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
        <text fg={theme.textMuted}>on the table</text>
      </box>
    </box>
  );
}
