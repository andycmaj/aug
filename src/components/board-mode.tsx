// The Board: every agent and its session. Columns are the agent's states;
// the Wall is every live coding terminal side by side; Live handoffs are the
// notes agents leave each other; the Hub is what they learned, by topic.

import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import type { Renderable, ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import {
  contrastingForeground,
  Markdown,
  truncate,
  useFocus,
  useKeyPassthrough,
  usePane,
  useScope,
  useTheme,
  useToast,
  type ThemeColor,
} from "@andycmaj/opentui-app";
import { Commands } from "../commands";
import { useAug, ViewMode } from "../context/aug";
import { useTerminals, type TermState } from "../context/terminals";
import { BOARD_COLUMNS, LANE_META } from "../core/lanes";
import { ageLabel } from "../core/rail";
import * as store from "../core/store";
import {
  AgentState,
  NoteLabel,
  TaskStatus,
  type HubRow,
  type ProjectRow,
  type TaskRow,
} from "../core/types";
import { encodeKey } from "../terminal/key-encode";
import type { HelpCtx } from "../keymap";
import { TermView } from "./agent-terminal";
import { AugFooter } from "./footer";
import { ChoiceModal, PromptModal } from "./modals";
import { useShell } from "./shell";
import { duration, toneColor } from "./ui";

const Tab = {
  columns: "columns",
  wall: "wall",
  notes: "notes",
  hub: "hub",
  projects: "projects",
} as const;
type Tab = (typeof Tab)[keyof typeof Tab];
const TABS: { key: Tab; label: string }[] = [
  { key: "columns", label: "1 Columns" },
  { key: "wall", label: "2 Wall" },
  { key: "notes", label: "3 Live handoffs" },
  { key: "hub", label: "4 Hub" },
  { key: "projects", label: "5 Projects" },
];

type ProjectLine =
  | { type: "project"; project: ProjectRow; tasks: number }
  | { type: "task"; task: TaskRow; project: ProjectRow };

const [tab, setTab] = createSignal<Tab>(Tab.columns);

export function BoardMode() {
  const aug = useAug();
  const theme = useTheme();
  const terminals = useTerminals();
  const { showToast } = useToast();
  const { isPaneFocused } = useFocus();
  const shell = useShell({ typing: () => false });
  const p = usePane("board");
  const dims = useTerminalDimensions();

  const [col, setCol] = createSignal(0);
  const [row, setRow] = createSignal(0);
  const [tile, setTile] = createSignal(0);
  const [wallCols, setWallCols] = createSignal(2);
  const [attached, setAttached] = createSignal(false);
  const [hubAt, setHubAt] = createSignal(0);
  const [projAt, setProjAt] = createSignal(0);
  let notesScroll: ScrollBoxRenderable | undefined;

  const columns = createMemo(() =>
    BOARD_COLUMNS.map((c) => ({ ...c, tasks: aug.board()[c.key] })),
  );
  const cardTask = (): TaskRow | null =>
    columns()[col()]?.tasks[
      Math.min(row(), (columns()[col()]?.tasks.length ?? 1) - 1)
    ] ?? null;
  const tiles = createMemo(() =>
    terminals.list().filter((t) => t.kind === "agent"),
  );
  const tileTerm = (): TermState | undefined =>
    tiles()[Math.min(tile(), tiles().length - 1)];
  const hub = createMemo(() => {
    aug.version();
    return store.listHub();
  });
  const notes = createMemo(() => {
    aug.version();
    return store.listNotes(100);
  });
  const projectLines = createMemo((): ProjectLine[] => {
    aug.version();
    const out: ProjectLine[] = [];
    for (const project of store.listProjects()) {
      const tasks = store
        .tasksForProject(project.id)
        .filter(
          (t) => t.status === TaskStatus.open || t.status === TaskStatus.later,
        );
      out.push({ type: "project", project, tasks: tasks.length });
      for (const task of tasks) out.push({ type: "task", task, project });
    }
    return out;
  });
  const projectLine = (): ProjectLine | null =>
    projectLines()[Math.min(projAt(), projectLines().length - 1)] ?? null;

  const target = (): TaskRow | null => {
    if (tab() === Tab.columns) return cardTask();
    if (tab() === Tab.wall) {
      const id = tileTerm()?.taskId;
      return id ? store.getTask(id) : null;
    }
    if (tab() === Tab.projects) {
      const line = projectLine();
      return line?.type === "task" ? line.task : null;
    }
    return null;
  };

  const openInChat = (task: TaskRow) => {
    aug.setMode(ViewMode.chat);
    aug.selectTask(task.id);
  };

  // The Wall hands every key to the selected tile while attached.
  useKeyPassthrough(
    "terminal",
    (event) => {
      const id = tileTerm()?.id;
      const bytes = encodeKey(event);
      if (id && bytes) terminals.write(id, bytes);
    },
    {
      target: p.target,
      enabled: () =>
        tab() === Tab.wall && attached() && Boolean(tileTerm()?.running),
    },
  );
  useScope(
    "terminal",
    { [Commands.TERMINAL_DETACH]: () => setAttached(false) },
    { target: p.target },
  );

  const onTask = (fn: (t: TaskRow) => void) => () => {
    const t = target();
    if (!t) return false;
    fn(store.getTask(t.id) ?? t);
  };

  function compose() {
    if (tab() === Tab.projects) {
      shell.actions.newProject();
      return;
    }
    if (tab() === Tab.hub) {
      shell.dialogs.show(() => (
        <PromptModal
          title="Hub: a durable discovery"
          hint="topic: title - what was learned. Short-lived coordination belongs in Live handoffs."
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
            store.addHub(m[1], m[2], m[3], "you");
          }}
          onClose={shell.dialogs.close}
        />
      ));
      return;
    }
    shell.dialogs.show(() => (
      <ChoiceModal
        title="Leave a live handoff for the agents"
        hint="Task-specific and short-lived; agents read it before starting."
        choices={Object.values(NoteLabel).map((label) => ({
          label,
          run: () =>
            shell.dialogs.show(() => (
              <PromptModal
                title={`Handoff (${label})`}
                placeholder="the census sync is behind a VPN and will not run from a laptop"
                onSubmit={(body) => store.addNote("you", label, body)}
                onClose={shell.dialogs.close}
              />
            )),
        }))}
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
      case Tab.wall:
        setTile((t) =>
          Math.max(0, Math.min(tiles().length - 1, t + d * wallCols())),
        );
        break;
      case Tab.notes:
        notesScroll?.scrollBy(d * 2);
        break;
      case Tab.hub:
        setHubAt((h) => Math.max(0, Math.min(hub().length - 1, h + d)));
        break;
      case Tab.projects:
        setProjAt((i) =>
          Math.max(0, Math.min(projectLines().length - 1, i + d)),
        );
        break;
    }
  };
  const horizontal = (d: number) => {
    if (tab() === Tab.columns) {
      setCol((c) => Math.max(0, Math.min(BOARD_COLUMNS.length - 1, c + d)));
      setRow(0);
    } else if (tab() === Tab.wall)
      setTile((t) => Math.max(0, Math.min(tiles().length - 1, t + d)));
  };

  useScope(
    "board",
    {
      [Commands.NAV_DOWN]: () => vertical(1),
      [Commands.NAV_UP]: () => vertical(-1),
      [Commands.NAV_TOP]: () =>
        tab() === Tab.columns
          ? setRow(0)
          : tab() === Tab.hub
            ? setHubAt(0)
            : tab() === Tab.projects
              ? setProjAt(0)
              : notesScroll?.scrollTo(0),
      [Commands.NAV_BOTTOM]: () => vertical(999),
      [Commands.BOARD_LEFT]: () => horizontal(-1),
      [Commands.BOARD_RIGHT]: () => horizontal(1),
      [Commands.BOARD_TAB_1]: () => setTab(Tab.columns),
      [Commands.BOARD_TAB_2]: () => setTab(Tab.wall),
      [Commands.BOARD_TAB_3]: () => {
        setTab(Tab.notes);
        store.markNotesRead("you");
      },
      [Commands.BOARD_TAB_4]: () => setTab(Tab.hub),
      [Commands.BOARD_TAB_5]: () => setTab(Tab.projects),
      [Commands.PROJECT_ADOPT]: () => void shell.actions.adoptProject(),
      [Commands.PROJECT_ARCHIVE]: () => {
        const line = projectLine();
        if (tab() !== Tab.projects || !line) return false;
        shell.actions.archiveProject(line.project.id);
      },
      [Commands.MOVE_TO_PROJECT]: onTask(shell.actions.moveToProject),
      [Commands.OPEN]: () => {
        if (tab() === Tab.wall) {
          if (tileTerm()?.running) setAttached(true);
          return;
        }
        const line = tab() === Tab.projects ? projectLine() : null;
        if (line?.type === "project") {
          void shell.actions.jumpToProject(line.project.id);
          return;
        }
        const t = target();
        if (t) openInChat(t);
      },
      [Commands.BOARD_COMPOSE]: compose,
      [Commands.WALL_COLS]: () => setWallCols((c) => (c % 3) + 1),
      [Commands.START]: onTask(shell.actions.start),
      [Commands.STOP]: onTask(shell.actions.stop),
      [Commands.JUMP]: () => {
        const line = tab() === Tab.projects ? projectLine() : null;
        if (line?.type === "project")
          return void shell.actions.jumpToProject(line.project.id);
        const t = target();
        if (!t) return false;
        void shell.actions.jumpTo(t.id);
      },
      [Commands.NUDGE]: onTask((t) => void shell.actions.nudge(t.id)),
      [Commands.DONE]: onTask(shell.actions.done),
    },
    { target: p.target },
  );

  const ctx = (): HelpCtx => ({
    item: target() ? "task" : null,
    kind: target()?.kind ?? null,
    hasDraft: false,
    live: false,
    coding: target()?.kind === "coding",
    watching: false,
    started: false,
  });

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
            <Show when={tab() === Tab.notes}>
              <text fg={theme.textMuted}>agents post with aug-tools note</text>
            </Show>
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
            <Match when={tab() === Tab.wall}>
              <Wall
                tiles={tiles()}
                selected={tile()}
                cols={wallCols()}
                attached={attached()}
              />
            </Match>
            <Match when={tab() === Tab.notes}>
              <scrollbox
                ref={(r: ScrollBoxRenderable) => (notesScroll = r)}
                flexGrow={1}
                flexBasis={0}
                paddingLeft={1}
                paddingRight={2}
              >
                <For
                  each={notes()}
                  fallback={
                    <text fg={theme.textMuted}>
                      No handoffs yet. c writes one; agents post with aug-tools
                      note.
                    </text>
                  }
                >
                  {(n) => {
                    const readBy = store.noteReadBy(n);
                    const tone =
                      n.label === "blocked"
                        ? theme.error
                        : n.label === "ready to push"
                          ? theme.success
                          : n.label === "working on"
                            ? theme.info
                            : theme.textMuted;
                    return (
                      <box flexDirection="column" marginBottom={1}>
                        <box flexDirection="row" justifyContent="space-between">
                          <text>
                            <span style={{ fg: theme.text, attributes: 1 }}>
                              {n.author}
                            </span>
                            <span style={{ fg: tone }}>{`  ● ${n.label}`}</span>
                          </text>
                          <text
                            fg={theme.textMuted}
                          >{`${ageLabel(n.created_at, aug.now())} ago`}</text>
                        </box>
                        <text fg={theme.text} wrapMode="word">
                          {n.body}
                        </text>
                        <Show when={readBy.length > 0}>
                          <text
                            fg={theme.textMuted}
                          >{`· read by ${readBy.join(", ")}`}</text>
                        </Show>
                      </box>
                    );
                  }}
                </For>
              </scrollbox>
            </Match>
            <Match when={tab() === Tab.hub}>
              <Hub entries={hub()} selected={hubAt()} width={dims().width} />
            </Match>
            <Match when={tab() === Tab.projects}>
              <Projects
                lines={projectLines()}
                selected={projAt()}
                width={dims().width}
              />
            </Match>
          </Switch>
        </box>
        <AugFooter ctx={ctx} />
        <box height={1} flexShrink={0} />
      </box>
      <shell.Modals />
    </box>
  );
}

function Projects(props: {
  lines: ProjectLine[];
  selected: number;
  width: number;
}) {
  const theme = useTheme();
  const aug = useAug();
  const live = (task: TaskRow) => {
    aug.version();
    const s = store.latestSession(task.id);
    return Boolean(s?.tmux_window && !s.ended_at);
  };
  return (
    <Show
      when={props.lines.length > 0}
      fallback={
        <box paddingLeft={1} flexDirection="column">
          <text fg={theme.textMuted}>
            No projects yet. c makes one (a tmux session); A adopts a session
            you already have.
          </text>
          <text fg={theme.textMuted}>
            Starting a coding task outside a project makes a project of its own.
          </text>
        </box>
      }
    >
      <scrollbox flexGrow={1} flexBasis={0} paddingLeft={1}>
        <For each={props.lines}>
          {(line, i) => {
            const on = () => i() === props.selected;
            const fg = (color: ThemeColor) =>
              on() ? contrastingForeground(theme.primary) : color;
            if (line.type === "project") {
              const repos = store.projectRepos(line.project);
              return (
                <box
                  flexDirection="row"
                  gap={2}
                  marginTop={i() === 0 ? 0 : 1}
                  backgroundColor={on() ? theme.primary : undefined}
                >
                  <text fg={fg(theme.primary)} attributes={1}>
                    {`◫ ${line.project.name}`}
                  </text>
                  <text fg={fg(theme.textMuted)}>
                    {truncate(
                      [
                        `tmux ${line.project.tmux_session}`,
                        repos.length ? repos.join(", ") : null,
                        `${line.tasks} open`,
                        line.project.solo ? "one task" : null,
                      ]
                        .filter(Boolean)
                        .join(" · "),
                      props.width - line.project.name.length - 12,
                    )}
                  </text>
                </box>
              );
            }
            const t = line.task;
            return (
              <box
                flexDirection="row"
                gap={2}
                paddingLeft={2}
                backgroundColor={on() ? theme.primary : undefined}
              >
                <text fg={fg(theme.textMuted)}>{store.taskRef(t.id)}</text>
                <text fg={fg(theme.text)}>{truncate(t.title, 44)}</text>
                <text fg={fg(theme.textMuted)}>
                  {truncate(
                    [
                      t.branch ?? (t.kind === "coding" ? "no worktree" : t.kind),
                      t.agent_state === AgentState.none ? null : t.agent_state,
                      live(t) ? "● live" : null,
                    ]
                      .filter(Boolean)
                      .join(" · "),
                    Math.max(10, props.width - 70),
                  )}
                </text>
              </box>
            );
          }}
        </For>
      </scrollbox>
    </Show>
  );
}

function Columns(props: {
  columns: ((typeof BOARD_COLUMNS)[number] & { tasks: TaskRow[] })[];
  col: number;
  row: number;
  width: number;
}) {
  const theme = useTheme();
  const aug = useAug();
  const colWidth = () =>
    Math.max(18, Math.floor((props.width - 6) / props.columns.length) - 1);
  return (
    <box flexDirection="row" flexGrow={1} flexBasis={0} gap={1}>
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
              {`${column.title} (${column.tasks.length})`}
            </text>
            <scrollbox flexGrow={1} flexBasis={0} marginTop={1}>
              <For
                each={column.tasks}
                fallback={<text fg={theme.textMuted}>—</text>}
              >
                {(task, ri) => {
                  const on = () =>
                    ci() === props.col &&
                    ri() === Math.min(props.row, column.tasks.length - 1);
                  return (
                    <Card
                      task={task}
                      on={on()}
                      width={colWidth() - 2}
                      spinner={aug.spinner()}
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

function Card(props: {
  task: TaskRow;
  on: boolean;
  width: number;
  spinner: string;
}) {
  const theme = useTheme();
  const aug = useAug();
  const session = createMemo(() => {
    aug.version();
    return store.latestSession(props.task.id);
  });
  const fg = () =>
    props.on ? contrastingForeground(theme.primary) : undefined;
  const line = () => {
    const t = props.task;
    const s = session();
    if (t.agent_state === AgentState.working) {
      return `${props.spinner} ${s?.last_tool ?? "working"} · ${s ? duration(s.started_at, null) : ""}`;
    }
    if (t.agent_state === AgentState.blocked)
      return `${LANE_META.blocked.mark} ${t.agent_says ?? "waiting on you"}`;
    if (t.agent_state === AgentState.queued)
      return `${LANE_META.queued.mark} ${t.queue_reason ?? "waiting to start"}`;
    if (aug.pending().has(t.id))
      return `${LANE_META.approve.mark} ready to send`;
    if (t.agent_state === AgentState.agentdone)
      return `${LANE_META.agentdone.mark} ${s?.result ?? "finished"}`;
    return `${t.agent_state}`;
  };
  return (
    <box
      flexDirection="column"
      marginBottom={1}
      backgroundColor={props.on ? theme.primary : theme.background}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={fg() ?? theme.textMuted}>
        {truncate(
          `${store.taskRef(props.task.id)} · ${props.task.kind}${props.task.repo ? ` · ${props.task.repo}` : ""}`,
          props.width - 2,
        )}
      </text>
      <text fg={fg() ?? theme.text} attributes={1}>
        {truncate(props.task.title, props.width - 2)}
      </text>
      <text fg={fg() ?? theme.textMuted}>
        {truncate(line(), props.width - 2)}
      </text>
    </box>
  );
}

function Wall(props: {
  tiles: TermState[];
  selected: number;
  cols: number;
  attached: boolean;
}) {
  const theme = useTheme();
  const rows = createMemo(() => {
    const out: TermState[][] = [];
    for (let i = 0; i < props.tiles.length; i += props.cols)
      out.push(props.tiles.slice(i, i + props.cols));
    return out;
  });
  return (
    <Show
      when={props.tiles.length > 0}
      fallback={
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>
            No coding sessions are open. Start one on a coding task with s.
          </text>
        </box>
      }
    >
      <box flexDirection="column" flexGrow={1} flexBasis={0} gap={1}>
        <For each={rows()}>
          {(r, ri) => (
            <box flexDirection="row" flexGrow={1} flexBasis={0} gap={1}>
              <For each={r}>
                {(t, ti) => {
                  const on = () => ri() * props.cols + ti() === props.selected;
                  const task = () =>
                    t.taskId ? store.getTask(t.taskId) : null;
                  return (
                    <box
                      flexDirection="column"
                      flexGrow={1}
                      flexBasis={0}
                      border
                      borderStyle={on() && props.attached ? "heavy" : "rounded"}
                      borderColor={
                        on()
                          ? props.attached
                            ? theme.success
                            : theme.primary
                          : theme.border
                      }
                      title={` ${t.title} ${truncate(task()?.title ?? "", 30)} ${t.running ? "" : `[exited ${t.exitCode ?? "?"}]`}`}
                    >
                      <TermView id={t.id} />
                    </box>
                  );
                }}
              </For>
            </box>
          )}
        </For>
        <text fg={theme.textMuted}>
          {props.attached
            ? "attached · ^] detach"
            : "enter attach · h/l/j/k move · L tiles across"}
        </text>
      </box>
    </Show>
  );
}

function Hub(props: { entries: HubRow[]; selected: number; width: number }) {
  const theme = useTheme();
  const current = () => props.entries[props.selected];
  return (
    <Show
      when={props.entries.length > 0}
      fallback={
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>
            The Hub is empty. Agents add discoveries with aug-tools hub add; c
            writes one.
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
          {(entry: () => HubRow) => (
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
