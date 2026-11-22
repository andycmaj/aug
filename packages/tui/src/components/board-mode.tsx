// The Board: the day's Wins first, then every agent by state (Columns),
// Knowledge (what agents learned, by topic), the Inbox and Cost.

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  Show,
  Switch,
} from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import {
  contrastingForeground,
  Markdown,
  truncate,
  useFocus,
  usePane,
  useScope,
  useTheme,
  useToast,
} from "@andycmaj/opentui-app";
import { Commands } from "../commands";
import { useRiker, ViewMode } from "../context/riker";
import { BOARD_COLUMNS, LANE_META } from "@riker/core/lanes";
import { taskRef } from "@riker/core/rows";
import { AgentState, Kind, type KnowledgeRow, type TaskRow } from "@riker/core/types";
import { BOARD_HELP_OPTIONS, BoardTab, type HelpCtx } from "../keymap";
import { RikerFooter } from "./footer";
import { boardTab, setBoardTab } from "./board-tab";
import { CostTab } from "./cost-tab";
import { useInboxTab } from "./inbox-tab";
import { useWinsTab } from "./wins-tab";
import { PromptModal } from "./modals";
import { useShell } from "./shell";
import { duration, toneColor } from "./ui";

const Tab = BoardTab;
type Tab = BoardTab;
const TABS: { key: Tab; label: string }[] = [
  { key: "wins", label: "1 Wins" },
  { key: "columns", label: "2 Columns" },
  { key: "knowledge", label: "3 Knowledge" },
  { key: "inbox", label: "4 Inbox" },
  { key: "cost", label: "5 Cost" },
];

const tab = boardTab;
const setTab = setBoardTab;

export function BoardMode() {
  const riker = useRiker();
  const theme = useTheme();
  const { showToast } = useToast();
  const { isPaneFocused } = useFocus();
  const shell = useShell({ typing: () => false });
  const p = usePane("board");
  const dims = useTerminalDimensions();

  const [col, setCol] = createSignal(0);
  const [row, setRow] = createSignal(0);
  const [knowledgeAt, setKnowledgeAt] = createSignal(0);
  let costScroll: ScrollBoxRenderable | undefined;

  const columns = createMemo(() =>
    BOARD_COLUMNS.map((c) => ({ ...c, tasks: riker.board()[c.key] })),
  );
  const cardTask = (): TaskRow | null =>
    columns()[col()]?.tasks[
      Math.min(row(), (columns()[col()]?.tasks.length ?? 1) - 1)
    ] ?? null;
  const knowledge = createMemo(() => riker.knowledge());
  const inbox = useInboxTab({
    active: () => tab() === Tab.inbox,
    actions: shell.actions,
    dialogs: shell.dialogs,
  });

  const wins = useWinsTab({
    active: () => tab() === Tab.wins,
    actions: shell.actions,
  });

  const target = (): TaskRow | null => {
    if (tab() === Tab.columns) return cardTask();
    if (tab() === Tab.inbox) return inbox.task();
    if (tab() === Tab.wins) return wins.task();
    return null;
  };

  const openInChat = (task: TaskRow) => {
    riker.setMode(ViewMode.chat);
    riker.selectTask(task.id);
  };

  const onTask = (fn: (t: TaskRow) => void) => () => {
    const t = target();
    if (!t) return false;
    fn(riker.task(t.id) ?? t);
  };

  // c means one thing per tab, one command each, so the footer names it.
  function composeKnowledge() {
    if (tab() !== Tab.knowledge) return false;
    shell.dialogs.show(() => (
        <PromptModal
          title="Knowledge: a durable discovery"
          hint="topic: title - what was learned. Short-lived coordination is a handoff note (riker-tools note)."
          placeholder="export: inter-company transfers - the bank feed keeps them, the export drops them"
          onSubmit={(line) => {
            const m = line.match(/^\s*([^:]+):\s*([^-–]+?)\s*[-–]\s*(.+)$/);
            if (!m) {
              showToast(
                "Write it as  topic: title - what was learned",
                4000,
                "error",
              );
              return;
            }
            riker.desk.addKnowledge(m[1], m[2], m[3]);
          }}
          onClose={shell.dialogs.close}
        />
      ));
  }

  const vertical = (d: number) => {
    switch (tab()) {
      case Tab.columns:
        setRow((r) =>
          Math.max(
            0,
            Math.min((columns()[col()]?.tasks.length ?? 1) - 1, r + d),
          ),
        );
        break;
      case Tab.knowledge:
        setKnowledgeAt((k) =>
          Math.max(0, Math.min(knowledge().length - 1, k + d)),
        );
        break;
      case Tab.inbox:
        inbox.move(d);
        break;
      case Tab.wins:
        wins.move(d);
        break;
      case Tab.cost:
        costScroll?.scrollBy(d * 2);
        break;
    }
  };
  const horizontal = (d: number) => {
    if (tab() !== Tab.columns) return false;
    setCol((c) => Math.max(0, Math.min(BOARD_COLUMNS.length - 1, c + d)));
    setRow(0);
  };

  useScope(
    "board",
    {
      [Commands.NAV_DOWN]: () => vertical(1),
      [Commands.NAV_UP]: () => vertical(-1),
      [Commands.NAV_TOP]: () =>
        tab() === Tab.columns
          ? setRow(0)
          : tab() === Tab.knowledge
            ? setKnowledgeAt(0)
            : tab() === Tab.inbox
              ? inbox.move(-Infinity)
              : tab() === Tab.wins
                ? wins.move(-Infinity)
                : costScroll?.scrollTo(0),
      [Commands.NAV_BOTTOM]: () => vertical(999),
      [Commands.BOARD_LEFT]: () => horizontal(-1),
      [Commands.BOARD_RIGHT]: () => horizontal(1),
      [Commands.BOARD_TAB_1]: () => setTab(Tab.wins),
      [Commands.BOARD_TAB_2]: () => setTab(Tab.columns),
      [Commands.BOARD_TAB_3]: () => setTab(Tab.knowledge),
      [Commands.BOARD_TAB_4]: () => setTab(Tab.inbox),
      [Commands.BOARD_TAB_5]: () => setTab(Tab.cost),
      ...inbox.commands,
      ...wins.commands,
      [Commands.PROJECT_ADOPT]: () => void shell.actions.adopt(),
      [Commands.REPOS]: () => void shell.actions.showRepos(),
      [Commands.MOVE_TO_PROJECT]: onTask(shell.actions.moveToProject),
      [Commands.OPEN]: () => {
        // Enter on the Inbox and Wins opens the row in place (INBOX_EXPAND,
        // WINS_EXPAND).
        if (tab() === Tab.inbox || tab() === Tab.wins) return false;
        const t = target();
        if (t) openInChat(t);
      },
      [Commands.BOARD_COMPOSE_KNOWLEDGE]: composeKnowledge,
      [Commands.START]: onTask(shell.actions.start),
      [Commands.STOP]: onTask(shell.actions.stop),
      [Commands.JUMP]: () => {
        const t = target();
        if (!t) return false;
        void shell.actions.jumpTo(t.id);
      },
      [Commands.NUDGE]: onTask((t) => void shell.actions.nudge(t.id)),
      [Commands.DONE]: onTask(shell.actions.done),
      [Commands.ACTIONS]: onTask(shell.actions.pickAction),
      [Commands.PR_DASH]: () => {
        const t = target();
        if (!t) return false;
        return shell.actions.togglePrDash(riker.task(t.id) ?? t);
      },
    },
    { target: p.target },
  );

  // What the palette's context mode is about: the card or row the keys act
  // on, else the tab.
  const subject = (): string => {
    const t = target();
    if (t) return `${taskRef(t.id)} ${t.title}`;
    const label = TABS.find((x) => x.key === tab())?.label.replace(/^\d+ /, "");
    return `Board: ${label ?? tab()}`;
  };

  const ctx = (): HelpCtx => {
    const t = target();
    return {
      item: t ? "task" : null,
      kind: t?.kind ?? null,
      hasDraft: false,
      live: Boolean(
        t && (t.agent_state === AgentState.working || riker.isLive(t)),
      ),
      coding: t?.kind === Kind.coding,
      watching: false,
      started: false,
      pr: Boolean(t && riker.taskPr(t)),
      board: tab(),
      ...(tab() === Tab.inbox ? inbox.ctx() : {}),
      ...(tab() === Tab.wins ? wins.ctx() : {}),
    };
  };

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={theme.background}
    >
      <box ref={shell.layoutRef} flexDirection="column" flexGrow={1}>
        <box
          ref={p.ref}
          flexDirection="column"
          flexGrow={1}
          flexBasis={0}
          marginTop={1}
          marginLeft={1}
          marginRight={1}
          paddingLeft={isPaneFocused("board") ? 0 : 1}
          border={isPaneFocused("board") ? ["left"] : false}
          borderStyle="heavy"
          borderColor={theme.secondary}
          focusedBorderColor={theme.secondary}
        >
          <box
            flexDirection="row"
            paddingLeft={1}
            paddingBottom={1}
            gap={2}
            flexShrink={0}
          >
            <text fg={theme.primary} attributes={1}>
              Agent board
            </text>
            <For each={TABS}>
              {(t) => (
                <text
                  fg={
                    tab() === t.key
                      ? contrastingForeground(theme.primary)
                      : theme.textMuted
                  }
                  bg={tab() === t.key ? theme.primary : undefined}
                >{` ${t.label} `}</text>
              )}
            </For>
          </box>
          <Switch>
            <Match when={tab() === Tab.columns}>
              <Columns
                columns={columns()}
                col={col()}
                row={row()}
                width={dims().width}
              />
            </Match>
            <Match when={tab() === Tab.knowledge}>
              <Knowledge
                entries={knowledge()}
                selected={knowledgeAt()}
                width={dims().width}
              />
            </Match>
            <Match when={tab() === Tab.inbox}>
              <inbox.View width={dims().width} />
            </Match>
            <Match when={tab() === Tab.wins}>
              <wins.View width={dims().width} />
            </Match>
            <Match when={tab() === Tab.cost}>
              <CostTab
                width={dims().width}
                scrollRef={(r) => (costScroll = r)}
              />
            </Match>
          </Switch>
        </box>
        <RikerFooter ctx={ctx} options={BOARD_HELP_OPTIONS} />
        <box height={1} flexShrink={0} />
      </box>
      <shell.Modals ctx={ctx} subject={subject} />
    </box>
  );
}

function Columns(props: {
  columns: ((typeof BOARD_COLUMNS)[number] & { tasks: TaskRow[] })[];
  col: number;
  row: number;
  width: number;
}) {
  const theme = useTheme();
  const riker = useRiker();
  const colWidth = () =>
    Math.max(20, Math.floor(props.width / props.columns.length) - 1);
  const scrolls: (ScrollBoxRenderable | undefined)[] = [];
  const selectedIn = (ci: number) =>
    Math.min(props.row, (props.columns[ci]?.tasks.length ?? 1) - 1);

  // A column taller than the screen follows the selected card. Cards differ
  // in height (titles wrap), so this measures the card itself.
  // scrollChildIntoView is not used: it leaves a card exactly as tall as the
  // column where it is, off the top.
  createEffect(
    on(
      () => [props.col, props.row, props.columns] as const,
      ([ci]) => {
        const box = scrolls[ci];
        const task = props.columns[ci]?.tasks[selectedIn(ci)];
        const card = task && box?.content.findDescendantById(cardId(task.id));
        if (!box || !card) return;
        const view = box.viewport.height;
        const top = card.y - box.viewport.y + box.scrollTop;
        const bottom = top + card.height;
        if (top < box.scrollTop || card.height >= view) box.scrollTo(top);
        else if (bottom > box.scrollTop + view) box.scrollTo(bottom - view);
      },
    ),
  );

  return (
    <box flexDirection="row" flexGrow={1} flexBasis={0} gap={1} paddingLeft={1}>
      <For each={props.columns}>
        {(column, ci) => (
          <box
            flexDirection="column"
            width={colWidth()}
            backgroundColor={theme.contentPane}
            paddingLeft={1}
            paddingRight={1}
          >
            <text
              fg={toneColor(theme, column.tone)}
              attributes={1}
              paddingTop={1}
            >
              {ci() === props.col && column.tasks.length > 1
                ? `${column.title} (${selectedIn(ci()) + 1}/${column.tasks.length})`
                : `${column.title} (${column.tasks.length})`}
            </text>
            <scrollbox
              ref={(r: ScrollBoxRenderable) => (scrolls[ci()] = r)}
              flexGrow={1}
              flexBasis={0}
              marginTop={1}
              stickyScroll={false}
            >
              <For
                each={column.tasks}
                fallback={<text fg={theme.textMuted}>—</text>}
              >
                {(task, ri) => {
                  const selected = () =>
                    ci() === props.col && ri() === selectedIn(ci());
                  return (
                    <Card
                      task={task}
                      on={selected()}
                      width={colWidth() - 2}
                      spinner={riker.spinner()}
                    />
                  );
                }}
              </For>
            </scrollbox>
          </box>
        )}
      </For>
    </box>
  );
}

const cardId = (taskId: number) => `board-card-${taskId}`;

function Card(props: {
  task: TaskRow;
  on: boolean;
  width: number;
  spinner: string;
}) {
  const theme = useTheme();
  const riker = useRiker();
  const session = createMemo(() => riker.latestSession(props.task.id));
  const fg = () =>
    props.on ? contrastingForeground(theme.primary) : undefined;
  const line = () => {
    const t = props.task;
    const s = session();
    if (t.agent_state === AgentState.working) {
      return `${props.spinner} ${s?.last_tool ?? "working"} · ${s ? duration(s.started_at, null) : ""}`;
    }
    if (t.agent_state === AgentState.waiting)
      return `${LANE_META.waiting.mark} ${t.agent_says ?? "waiting on you"}`;
    if (t.agent_state === AgentState.queued)
      return `${LANE_META.queued.mark} ${t.queue_reason ?? "waiting to start"}`;
    if (riker.pending().has(t.id))
      return `${LANE_META.approve.mark} ready to send`;
    if (t.agent_state === AgentState.ready)
      return `${LANE_META.ready.mark} ${s?.result ?? LANE_META.ready.word}`;
    return `${t.agent_state}`;
  };
  return (
    <box
      id={cardId(props.task.id)}
      flexDirection="column"
      marginBottom={1}
      backgroundColor={props.on ? theme.primary : theme.background}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={fg() ?? theme.textMuted}>
        {truncate(
          `${taskRef(props.task.id)} · ${props.task.kind}${props.task.repo ? ` · ${props.task.repo}` : ""}`,
          props.width - 2,
        )}
      </text>
      <text fg={fg() ?? theme.text} attributes={1}>
        {props.task.title}
      </text>
      <text fg={fg() ?? theme.textMuted}>
        {truncate(line(), props.width - 2)}
      </text>
    </box>
  );
}

function Knowledge(props: {
  entries: KnowledgeRow[];
  selected: number;
  width: number;
}) {
  const theme = useTheme();
  const current = () => props.entries[props.selected];
  return (
    <Show
      when={props.entries.length > 0}
      fallback={
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>
            Nothing learned yet. Agents add discoveries with riker-tools knowledge
            add; c writes one.
          </text>
        </box>
      }
    >
      <box flexDirection="row" flexGrow={1} flexBasis={0} gap={2}>
        <scrollbox width={44} flexShrink={0} paddingLeft={1}>
          <For each={props.entries}>
            {(entry, i) => {
              const header = () =>
                i() === 0 || props.entries[i() - 1].topic !== entry.topic;
              const on = () => i() === props.selected;
              return (
                <box flexDirection="column">
                  <Show when={header()}>
                    <text
                      fg={theme.accent}
                      attributes={1}
                      marginTop={i() === 0 ? 0 : 1}
                    >
                      {entry.topic}
                    </text>
                  </Show>
                  <text
                    fg={
                      on() ? contrastingForeground(theme.primary) : theme.text
                    }
                    bg={on() ? theme.primary : undefined}
                  >
                    {` ${truncate(entry.title, 40)}`}
                  </text>
                </box>
              );
            }}
          </For>
        </scrollbox>
        <Show when={current()}>
          {(entry: () => KnowledgeRow) => (
            <box flexDirection="column" flexGrow={1}>
              <text fg={theme.primary} attributes={1}>
                {entry().title}
              </text>
              <text
                fg={theme.textMuted}
              >{`${entry().topic} · ${entry().author} · ${entry().created_at.slice(0, 10)}`}</text>
              <box marginTop={1}>
                <Markdown
                  text={entry().body}
                  width={Math.max(20, props.width - 56)}
                />
              </box>
            </box>
          )}
        </Show>
      </box>
    </Show>
  );
}
