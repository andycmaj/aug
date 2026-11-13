// The Board: every agent and its session. Columns are the agent's states;
// Live handoffs are the notes agents leave each other; Knowledge is what
// they learned, by topic.

import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
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
  type ThemeColor,
} from "@andycmaj/opentui-app";
import { Commands } from "../commands";
import { useAug, ViewMode } from "../context/aug";
import { BOARD_COLUMNS, LANE_META } from "../core/lanes";
import { projectProgress, projectSummary, type GoalProgress } from "../core/lookup";
import { taskPr } from "../core/pr";
import { ageLabel } from "../core/rail";
import * as store from "../core/store";
import {
  AgentState,
  GoalStatus,
  NoteLabel,
  TaskStatus,
  type KnowledgeRow,
  type ProjectRow,
  type TaskRow,
} from "../core/types";
import type { HelpCtx } from "../keymap";
import { AugFooter } from "./footer";
import { ChoiceModal, PromptModal } from "./modals";
import { useShell } from "./shell";
import { duration, toneColor } from "./ui";

const Tab = {
  columns: "columns",
  notes: "notes",
  knowledge: "knowledge",
  projects: "projects",
} as const;
type Tab = (typeof Tab)[keyof typeof Tab];
const TABS: { key: Tab; label: string }[] = [
  { key: "columns", label: "1 Columns" },
  { key: "notes", label: "2 Live handoffs" },
  { key: "knowledge", label: "3 Knowledge" },
  { key: "projects", label: "4 Projects" },
];

// A project, then its goals each with their open tasks, then the open tasks
// that serve no goal.
type ProjectLine =
  | { type: "project"; project: ProjectRow; tasks: number; goalsMet: number; goals: number; docs: number }
  | { type: "goal"; project: ProjectRow; progress: GoalProgress }
  | { type: "task"; task: TaskRow; project: ProjectRow; underGoal: boolean };

const [tab, setTab] = createSignal<Tab>(Tab.columns);

export function BoardMode() {
  const aug = useAug();
  const theme = useTheme();
  const { showToast } = useToast();
  const { isPaneFocused } = useFocus();
  const shell = useShell({ typing: () => false });
  const p = usePane("board");
  const dims = useTerminalDimensions();

  const [col, setCol] = createSignal(0);
  const [row, setRow] = createSignal(0);
  const [knowledgeAt, setKnowledgeAt] = createSignal(0);
  const [projAt, setProjAt] = createSignal(0);
  let notesScroll: ScrollBoxRenderable | undefined;

  const columns = createMemo(() =>
    BOARD_COLUMNS.map((c) => ({ ...c, tasks: aug.board()[c.key] })),
  );
  const cardTask = (): TaskRow | null =>
    columns()[col()]?.tasks[
      Math.min(row(), (columns()[col()]?.tasks.length ?? 1) - 1)
    ] ?? null;
  const knowledge = createMemo(() => {
    aug.version();
    return store.listKnowledge();
  });
  const notes = createMemo(() => {
    aug.version();
    return store.listNotes(100);
  });
  const projectLines = createMemo((): ProjectLine[] => {
    aug.version();
    const out: ProjectLine[] = [];
    const isOpen = (t: TaskRow) =>
      t.status === TaskStatus.open || t.status === TaskStatus.later;
    for (const project of store.listProjects()) {
      const summary = projectSummary(project);
      const progress = projectProgress(project);
      out.push({
        type: "project",
        project,
        tasks: summary.open,
        goalsMet: summary.goalsMet,
        goals: summary.goals,
        docs: store.linksForProject(project.id).length,
      });
      for (const g of progress.goals) {
        if (g.goal.status === GoalStatus.dropped) continue;
        out.push({ type: "goal", project, progress: g });
        for (const task of g.tasks.filter(isOpen))
          out.push({ type: "task", task, project, underGoal: true });
      }
      for (const task of progress.loose)
        out.push({ type: "task", task, project, underGoal: false });
    }
    return out;
  });
  const projectLine = (): ProjectLine | null =>
    projectLines()[Math.min(projAt(), projectLines().length - 1)] ?? null;

  const target = (): TaskRow | null => {
    if (tab() === Tab.columns) return cardTask();
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
    if (tab() === Tab.knowledge) {
      shell.dialogs.show(() => (
        <PromptModal
          title="Knowledge: a durable discovery"
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
            store.addKnowledge(m[1], m[2], m[3], "you");
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
      case Tab.notes:
        notesScroll?.scrollBy(d * 2);
        break;
      case Tab.knowledge:
        setKnowledgeAt((k) =>
          Math.max(0, Math.min(knowledge().length - 1, k + d)),
        );
        break;
      case Tab.projects:
        setProjAt((i) =>
          Math.max(0, Math.min(projectLines().length - 1, i + d)),
        );
        break;
    }
  };
  const horizontal = (d: number) => {
    if (tab() !== Tab.columns) return;
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
            : tab() === Tab.projects
              ? setProjAt(0)
              : notesScroll?.scrollTo(0),
      [Commands.NAV_BOTTOM]: () => vertical(999),
      [Commands.BOARD_LEFT]: () => horizontal(-1),
      [Commands.BOARD_RIGHT]: () => horizontal(1),
      [Commands.BOARD_TAB_1]: () => setTab(Tab.columns),
      [Commands.BOARD_TAB_2]: () => {
        setTab(Tab.notes);
        store.markNotesRead("you");
      },
      [Commands.BOARD_TAB_3]: () => setTab(Tab.knowledge),
      [Commands.BOARD_TAB_4]: () => setTab(Tab.projects),
      [Commands.PROJECT_ADOPT]: () =>
        void shell.actions.adopt(tab() === Tab.projects ? projectLine()?.project.id : undefined),
      [Commands.PROJECT_ARCHIVE]: () => {
        const line = projectLine();
        if (tab() !== Tab.projects || !line) return false;
        shell.actions.archiveProject(line.project.id);
      },
      [Commands.PROJECT_EDIT]: () => {
        const line = projectLine();
        if (tab() !== Tab.projects || !line) return false;
        return shell.actions.editProject(line.project.id);
      },
      [Commands.MOVE_TO_PROJECT]: onTask(shell.actions.moveToProject),
      [Commands.OPEN]: () => {
        const line = tab() === Tab.projects ? projectLine() : null;
        if (line?.type === "project" || line?.type === "goal") {
          void shell.actions.jumpToProject(line.project.id);
          return;
        }
        const t = target();
        if (t) openInChat(t);
      },
      [Commands.BOARD_COMPOSE]: compose,
      [Commands.START]: onTask(shell.actions.start),
      [Commands.STOP]: onTask(shell.actions.stop),
      [Commands.JUMP]: () => {
        const line = tab() === Tab.projects ? projectLine() : null;
        if (line?.type === "project" || line?.type === "goal")
          return void shell.actions.jumpToProject(line.project.id);
        const t = target();
        if (!t) return false;
        void shell.actions.jumpTo(t.id);
      },
      [Commands.NUDGE]: onTask((t) => void shell.actions.nudge(t.id)),
      [Commands.DONE]: onTask(shell.actions.done),
      [Commands.PR_DASH]: () => {
        const t = target();
        if (!t) return false;
        return shell.actions.togglePrDash(store.getTask(t.id) ?? t);
      },
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
    pr: Boolean(target() && taskPr(target()!)),
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
            <Match when={tab() === Tab.knowledge}>
              <Knowledge
                entries={knowledge()}
                selected={knowledgeAt()}
                width={dims().width}
              />
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

// Ten cells of done out of all.
function meter(done: number, all: number): string {
  const full = all ? Math.round((done / all) * 10) : 0;
  return `${"▰".repeat(full)}${"▱".repeat(10 - full)}`;
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
            or a claude you already have.
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
              const brief = line.project.brief.split("\n").find((l) => l.trim()) ?? "";
              return (
                <box flexDirection="column" marginTop={i() === 0 ? 0 : 1}>
                  <box
                    flexDirection="row"
                    gap={2}
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
                          line.goals ? `goals ${line.goalsMet}/${line.goals} met` : null,
                          line.docs ? `${line.docs} doc${line.docs === 1 ? "" : "s"}` : null,
                          line.project.solo ? "one task" : null,
                        ]
                          .filter(Boolean)
                          .join(" · "),
                        props.width - line.project.name.length - 12,
                      )}
                    </text>
                  </box>
                  <box paddingLeft={2}>
                    <text fg={theme.textMuted}>
                      {brief
                        ? truncate(brief, props.width - 8)
                        : "no brief yet: e writes one, with goals and docs"}
                    </text>
                  </box>
                </box>
              );
            }
            if (line.type === "goal") {
              const g = line.progress;
              const met = g.goal.status === GoalStatus.met;
              return (
                <box
                  flexDirection="row"
                  gap={2}
                  paddingLeft={2}
                  backgroundColor={on() ? theme.primary : undefined}
                >
                  <text fg={fg(met ? theme.success : theme.secondary)}>
                    {`${met ? "◉" : "◎"} ${store.goalRef(g.goal.id)}`}
                  </text>
                  <text fg={fg(met ? theme.textMuted : theme.text)}>
                    {truncate(g.goal.title, 44)}
                  </text>
                  <text fg={fg(theme.textMuted)}>
                    {[
                      g.tasks.length ? `${meter(g.done, g.tasks.length)} ${g.done}/${g.tasks.length} done` : "no tasks yet",
                      g.working ? `${g.working} working` : null,
                      met ? "met" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </text>
                </box>
              );
            }
            const t = line.task;
            return (
              <box
                flexDirection="row"
                gap={2}
                paddingLeft={line.underGoal ? 4 : 2}
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

function Knowledge(props: { entries: KnowledgeRow[]; selected: number; width: number }) {
  const theme = useTheme();
  const current = () => props.entries[props.selected];
  return (
    <Show
      when={props.entries.length > 0}
      fallback={
        <box paddingLeft={1}>
          <text fg={theme.textMuted}>
            Nothing learned yet. Agents add discoveries with aug-tools
            knowledge add; c writes one.
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
