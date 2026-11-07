// The work rail (sidebar): what still wants something from you, under its
// headings, oldest first. Moving the cursor puts the row on the table; the
// moves on a row work from here as from the table.

import {
  createEffect,
  createMemo,
  For,
  Match,
  on,
  Show,
  Switch,
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
  useToast,
  type Theme,
} from "@andycmaj/opentui-app";
import { Commands } from "../commands";
import { useAug } from "../context/aug";
import { Lane, LANE_META } from "../core/lanes";
import { ageLabel, SECTION_TITLES, type RailItem } from "../core/rail";
import { getProject, taskRef } from "../core/store";

// A task in a project shows the project's name where its channel would be.
function projectChip(projectId: number | null): string | null {
  if (!projectId) return null;
  const name = getProject(projectId)?.tmux_session;
  return name ? `◫ ${name.length > 14 ? `${name.slice(0, 13)}…` : name}` : null;
}
import { AgentState } from "../core/types";
import { CHANNEL_WORD, priorityColor, toneColor } from "./ui";
import { ConnectorLine } from "./connector-line";
import type { ItemMoves } from "./moves";

export const RAIL_WIDTH = 46;

type Node =
  | { type: "section"; title: string; count: number }
  | { type: "item"; item: RailItem };

export function Rail(props: { moves: ItemMoves }) {
  const aug = useAug();
  const theme = useTheme();
  const { isPaneFocused, setActivePane } = useFocus();
  const { showToast } = useToast();
  const focused = () => isPaneFocused("rail");
  let scrollRef: ScrollBoxRenderable | undefined;
  let pane: Renderable | undefined;

  const nodes = createMemo<Node[]>(() =>
    aug.rail().flatMap((s) => [
      {
        type: "section" as const,
        title: SECTION_TITLES[s.section],
        count: s.items.length,
      },
      ...s.items.map((item) => ({ type: "item" as const, item })),
    ]),
  );

  // First visit: the first row is on the table. A cursor whose row left the
  // rail comes back to the table's row.
  createEffect(() => {
    const list = aug.items();
    if (list.length === 0) return;
    if (!aug.selectedKey()) aug.select(list[0].key);
    else if (!aug.cursorItem())
      aug.moveCursor(aug.selected() ? aug.selectedKey() : list[0].key);
  });

  const cursorIndex = () =>
    aug.items().findIndex((i) => i.key === aug.cursorKey());

  function rowOf(key: string | null): { top: number; height: number } {
    let row = 0;
    let first = true;
    for (const node of nodes()) {
      if (node.type === "section") {
        row += first ? 1 : 2;
        first = false;
        continue;
      }
      if (node.item.key === key) return { top: row, height: 2 };
      row += 3;
    }
    return { top: 0, height: 1 };
  }

  createEffect(
    on([aug.cursorKey, nodes], ([key]) => {
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
    const list = aug.items();
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
      // enter puts the row under the cursor on the table.
      [Commands.OPEN]: () => {
        aug.select(aug.cursorKey());
        setActivePane("task");
      },
      [Commands.PROJECT_FILTER]: () => {
        const id = aug.cycleProjectFilter();
        showToast(id ? `Only ${projectChip(id)}` : "Every project");
      },
      ...props.moves,
    },
    { target: () => pane },
  );

  const counts = createMemo(() => {
    let blocked = 0;
    let approve = 0;
    let tasks = 0;
    for (const s of aug.rail()) {
      if (s.section !== "tasks") continue;
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
      <PaneHeader
        title={
          aug.projectFilter()
            ? `Work ${projectChip(aug.projectFilter()) ?? ""}`
            : "Work"
        }
      >
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
        <Show when={nodes().length > 0} fallback={<EmptyRail />}>
          <For each={nodes()}>
            {(node, index) => (
              <Switch>
                <Match when={node.type === "section" && node}>
                  {(s: Accessor<Extract<Node, { type: "section" }>>) => (
                    <box
                      paddingLeft={1}
                      marginTop={index() > 0 ? 1 : 0}
                      flexDirection="row"
                    >
                      <text fg={theme.accent} attributes={1}>
                        {`${s().title} (${s().count})`}
                      </text>
                    </box>
                  )}
                </Match>
                <Match when={node.type === "item" && node}>
                  {(n: Accessor<Extract<Node, { type: "item" }>>) => (
                    <RailRow
                      item={n().item}
                      cursor={aug.cursorKey() === n().item.key}
                      onTable={aug.selectedKey() === n().item.key}
                      focused={focused()}
                      theme={theme}
                    />
                  )}
                </Match>
              </Switch>
            )}
          </For>
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

  const view = createMemo(() => {
    const item = props.item;
    const now = aug.now();
    switch (item.type) {
      case "task": {
        const meta = LANE_META[item.lane];
        const working =
          item.task.agent_state === AgentState.working &&
          item.lane === Lane.working;
        const word = item.slipped ? "slipped" : meta.word;
        const age =
          item.lane === Lane.later && item.task.remind_at
            ? ageLabel(item.task.remind_at, now)
            : ageLabel(item.at, now);
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
          sub: [
            age,
            projectChip(item.task.project_id) ??
              CHANNEL_WORD[item.task.channel],
            taskRef(item.task.id),
            word,
          ].join(" · "),
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
      marginLeft={1}
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
          {truncate(view().title, RAIL_WIDTH - 9)}
        </text>
      </box>
      <box flexDirection="row" gap={1}>
        <text bg={view().bar2}> </text>
        <text fg={lit() ? selFg() : theme().textMuted}>
          {truncate(view().sub, RAIL_WIDTH - 7)}
        </text>
      </box>
    </box>
  );
}
