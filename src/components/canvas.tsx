// The table: whatever the rail cursor is on. A task is its chat (or, while a
// coding agent's terminal is open, that terminal), with the draft pinned
// above the box; an FYI or an Advisor idea shows the item itself.

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onMount,
  Show,
  Switch,
  type Accessor,
} from "solid-js";
import type {
  InputRenderable,
  Renderable,
  ScrollBoxRenderable,
} from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import {
  contrastingForeground,
  Markdown,
  Pane,
  truncate,
  useFocus,
  usePane,
  useScope,
  useTheme,
} from "@andycmaj/opentui-app";
import { Commands } from "../commands";
import { useAug } from "../context/aug";
import { useTerminals, type TermState } from "../context/terminals";
import { LANE_META } from "../core/lanes";
import {
  type Mention,
  mentionAt,
  mentionRef,
  projectSummary,
  suggestMentions,
} from "../core/lookup";
import type { RailItem } from "../core/rail";
import * as store from "../core/store";
import { AgentState, Kind, type TaskRow } from "../core/types";
import { TerminalHost } from "./agent-terminal";
import { ActionCard, ChatTurn } from "./chat-turn";
import { unlessTyping, type TaskActions } from "./task-actions";
import { RAIL_WIDTH } from "./rail";
import {
  Badge,
  CHANNEL_WORD,
  dayClock,
  KeyHints,
  priorityColor,
  toneColor,
} from "./ui";

type Compose = (initial: string, keep: (text: string) => void) => void;

export function Canvas(props: {
  actions: TaskActions;
  onSay: (text: string) => void;
  onCompose: Compose;
}) {
  const aug = useAug();
  const terminals = useTerminals();
  const { isPaneFocused, setActivePane, sidebarVisible } = useFocus();
  const dims = useTerminalDimensions();
  let pane: Renderable | undefined;
  let scrollRef: ScrollBoxRenderable | undefined;

  const width = () =>
    dims().width - (sidebarVisible() ? RAIL_WIDTH + 2 : 0) - 6;
  const item = () => aug.selected();
  const task = createMemo(() => {
    aug.version();
    const i = item();
    return i?.type === "task" ? store.getTask(i.task.id) : null;
  });
  const term = createMemo(() => {
    const t = task();
    // Live, it takes the table; once it stops, its Result in the chat does.
    const tm =
      t && t.kind === Kind.coding ? terminals.forTask(t.id) : undefined;
    return tm?.running ? tm : undefined;
  });
  const attached = () => isPaneFocused("task") && Boolean(term()?.running);
  const editor = () => terminals.get("editor");

  useScope(
    "task",
    unlessTyping(
      {
        [Commands.NAV_DOWN]: () => scrollRef?.scrollBy(2),
        [Commands.NAV_UP]: () => scrollRef?.scrollBy(-2),
        [Commands.NAV_TOP]: () => scrollRef?.scrollTo(0),
        [Commands.NAV_BOTTOM]: () =>
          scrollRef?.scrollTo(scrollRef.scrollHeight),
        [Commands.SCROLL_PAGEDOWN]: () => scrollRef?.scrollBy(0.8, "viewport"),
        [Commands.SCROLL_PAGEUP]: () => scrollRef?.scrollBy(-0.8, "viewport"),
        [Commands.BACK_TO_RAIL]: () => setActivePane("rail"),
        ...props.actions,
      },
      () => isPaneFocused("input"),
    ),
    { target: () => pane },
  );

  // A new item on the table opens at its newest line.
  createEffect(
    on(
      () => aug.selectedKey(),
      () => queueMicrotask(() => scrollRef?.scrollTo(scrollRef.scrollHeight)),
    ),
  );

  return (
    <Pane name="task" ref={(r) => (pane = r)}>
      <Show when={editor()}>
        {(ed: Accessor<TermState>) => (
          <>
            <box paddingLeft={2} paddingTop={1} flexShrink={0}>
              <text
                fg={useTheme().primary}
                attributes={1}
              >{`Editing ${ed().title} · save and quit the editor to finish`}</text>
            </box>
            <TerminalHost
              id={ed().id}
              attached={() => isPaneFocused("task")}
              pane={() => pane}
              onDetach={() => setActivePane("rail")}
            />
          </>
        )}
      </Show>
      <Switch
        fallback={
          <Show when={!editor()}>
            <Opening />
          </Show>
        }
      >
        <Match when={editor()}>{null}</Match>
        <Match when={task()}>
          {(t: Accessor<TaskRow>) => (
            <>
              <TaskHeader task={t()} width={width()} />
              <Show
                when={term()}
                fallback={
                  <TaskChat
                    task={t()}
                    width={width()}
                    scrollRef={(r) => (scrollRef = r)}
                  />
                }
              >
                {(tm: Accessor<TermState>) => (
                  <TerminalHost
                    id={tm().id}
                    attached={attached}
                    pane={() => pane}
                    onDetach={() => setActivePane("rail")}
                  />
                )}
              </Show>
              <PendingCard taskId={t().id} />
              <ChatInput
                task={t()}
                hidden={attached}
                onSay={props.onSay}
                onCompose={props.onCompose}
              />
            </>
          )}
        </Match>
        <Match when={item()?.type === "fyi" && item()}>
          {(i: Accessor<RailItem>) => (
            <FyiView
              item={i() as Extract<RailItem, { type: "fyi" }>}
              width={width()}
            />
          )}
        </Match>
        <Match when={item()?.type === "project" && item()}>
          {(i: Accessor<RailItem>) => (
            <ProjectView
              item={i() as Extract<RailItem, { type: "project" }>}
              width={width()}
            />
          )}
        </Match>
        <Match when={item()?.type === "idea" && item()}>
          {(i: Accessor<RailItem>) => (
            <IdeaView
              item={i() as Extract<RailItem, { type: "idea" }>}
              width={width()}
            />
          )}
        </Match>
      </Switch>
    </Pane>
  );
}

function TaskHeader(props: { task: TaskRow; width: number }) {
  const theme = useTheme();
  const aug = useAug();
  const lane = () => {
    aug.version();
    const item = aug
      .items()
      .find((i) => i.type === "task" && i.task.id === props.task.id);
    return item?.type === "task" ? item.lane : null;
  };
  const meta = () => (lane() ? LANE_META[lane()!] : null);
  const came = createMemo(() => {
    aug.version();
    const first = store.messagesForTask(props.task.id)[0];
    const from = first
      ? `${CHANNEL_WORD[first.channel]} · ${first.author_name} · ${first.title}`
      : "typed by you";
    return `${from} · ${dayClock(props.task.created_at, aug.now())}`;
  });
  // One line of what is attached: titles, else the bare address. o opens.
  const links = createMemo(() => {
    aug.version();
    const names = store
      .linksForTask(props.task.id)
      .map((l) => l.title ?? l.url.replace(/^https?:\/\//, ""));
    return names.length
      ? truncate(`links · ${names.join(" · ")}  (o opens)`, Math.max(20, props.width - 4))
      : null;
  });
  const says = () => {
    const t = props.task;
    if (t.agent_state === AgentState.blocked && t.agent_says)
      return `agent ${t.agent_says}`;
    if (t.agent_state === AgentState.queued && t.queue_reason)
      return `waiting to start: ${t.queue_reason}`;
    if (t.waiting_on) return `waiting on ${t.waiting_on}`;
    return null;
  };

  // A branch, not an early return: the canvas keeps this header when the
  // table moves from Home to a task, so the body must follow props.
  return (
    <Show
      when={props.task.kind !== Kind.home}
      fallback={
        <box
          flexDirection="column"
          flexShrink={0}
          paddingLeft={2}
          paddingTop={1}
        >
          <text fg={theme.primary} attributes={1}>
            Home · the Assistant
          </text>
          <text fg={theme.textMuted} wrapMode="word">
            Ask about any work (@ names a task or project), or tell it to make,
            move, start or close things.
          </text>
        </box>
      }
    >
      <box
        flexDirection="column"
        flexShrink={0}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
      >
        <box flexDirection="row" justifyContent="space-between">
          <text>
            <span
              style={{ fg: theme.textMuted }}
            >{`${store.taskRef(props.task.id)}  `}</span>
            <span
              style={{
                fg: priorityColor(theme, props.task.priority) ?? theme.primary,
                attributes: 1,
              }}
            >
              {truncate(props.task.title, Math.max(20, props.width - 32))}
            </span>
          </text>
          <box flexDirection="row" gap={1}>
            <Show when={props.task.priority !== "regular"}>
              <Badge
                text={props.task.priority}
                color={priorityColor(theme, props.task.priority)}
              />
            </Show>
            <Show when={meta()}>
              {(m: Accessor<(typeof LANE_META)[keyof typeof LANE_META]>) => (
                <Badge text={m().word} color={toneColor(theme, m().tone)} />
              )}
            </Show>
          </box>
        </box>
        <text fg={theme.textMuted} wrapMode="word">
          {`${props.task.kind} · ${came()}`}
        </text>
        <Show when={links()}>
          <text fg={theme.info}>{links() ?? ""}</text>
        </Show>
        <Show when={props.task.triage_reason}>
          <text
            fg={theme.textMuted}
            wrapMode="word"
          >{`triage: ${props.task.triage_reason}`}</text>
        </Show>
        <Show when={says()}>
          <text fg={theme.warning} wrapMode="word">
            {says() ?? ""}
          </text>
        </Show>
      </box>
    </Show>
  );
}

function TaskChat(props: {
  task: TaskRow;
  width: number;
  scrollRef: (r: ScrollBoxRenderable) => void;
}) {
  const aug = useAug();
  const theme = useTheme();
  const turns = createMemo(() => {
    aug.version();
    return store.turnsForTask(props.task.id);
  });
  const latestAgentId = createMemo(
    () => [...turns()].reverse().find((t) => t.role === "agent")?.id ?? null,
  );
  // Shown until the agent starts from it; after that the chat carries on.
  const brief = createMemo((): string | null => {
    aug.version();
    return aug.desk.briefEditable(props.task.id) ? props.task.summary : null;
  });
  const hint = createMemo((): [string, string][] => {
    const t = props.task;
    if (t.kind === Kind.home)
      return [
        ["i", "talk"],
        ["@", "name a task or project"],
        ["a", "back here from anywhere"],
      ];
    const edit: [string, string][] =
      brief() === null ? [] : [["e", "edit the brief"]];
    if (t.kind === Kind.coding)
      return [
        ["s", "start the coding agent"],
        ...edit,
        ["i", "add a note first"],
        ["d", "mark done"],
      ];
    if (t.kind === Kind.task)
      return [
        ["s", "hand it to an agent"],
        ...edit,
        ["d", "mark done"],
        ["r", "later"],
      ];
    return [
      ["i", "type to the agent"],
      ["s", "run it again"],
      ["d", "mark done"],
    ];
  });

  return (
    <scrollbox
      ref={props.scrollRef}
      flexGrow={1}
      flexBasis={0}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      stickyScroll
      stickyStart="bottom"
    >
      <Show when={brief()}>
        {(text: Accessor<string>) => (
          <box flexDirection="column" marginBottom={1}>
            <text fg={theme.textMuted}>brief</text>
            <text wrapMode="word">{text()}</text>
          </box>
        )}
      </Show>
      <For each={turns()}>
        {(turn) => (
          <ChatTurn
            turn={turn}
            latestAgent={turn.id === latestAgentId()}
            width={props.width}
          />
        )}
      </For>
      <Show
        when={props.task.status === "done" && props.task.kind !== Kind.home}
      >
        <text
          fg={theme.textMuted}
        >{`· done${props.task.closed_by ? ` (${props.task.closed_by})` : ""} · typing reopens it`}</text>
      </Show>
      <box paddingLeft={1} marginTop={1}>
        <KeyHints hints={hint()} />
      </box>
    </scrollbox>
  );
}

function PendingCard(props: { taskId: number }) {
  const aug = useAug();
  const pending = createMemo(() => {
    aug.version();
    return store.pendingAction(props.taskId);
  });
  return (
    <Show when={pending()}>
      {(p: Accessor<NonNullable<ReturnType<typeof store.pendingAction>>>) => (
        <ActionCard action={p().action} result={p().turn.action_result} />
      )}
    </Show>
  );
}

function mentionLine(m: Mention): string {
  if (m.type === "project") {
    const open = projectSummary(m.project).open;
    return `@${mentionRef(m)}  project ${m.project.name}, ${open} open`;
  }
  const t = m.task;
  return `${store.taskRef(t.id)}  ${t.title}${t.status === "open" ? "" : ` (${t.status})`}`;
}

// Text the editor handed back unsent. The box unmounts while the editor has
// the table, so it waits here for the box to come back.
const unsent = new Map<number, string>();

// The box under the chat. Typing always continues the same conversation.
// `@` offers tasks and projects to name; enter or tab takes the highlighted
// one. While a live terminal is attached, keys go to it, so the box hides
// (but keeps its draft) until detach.
function ChatInput(props: {
  task: TaskRow;
  hidden: () => boolean;
  onSay: (text: string) => void;
  onCompose: Compose;
}) {
  const theme = useTheme();
  const { setActivePane } = useFocus();
  const p = usePane("input");
  let input: InputRenderable | undefined;
  const [before, setBefore] = createSignal("");
  const [pick, setPick] = createSignal(0);
  const [dismissed, setDismissed] = createSignal<string | null>(null);

  const mention = createMemo(() => {
    const at = mentionAt(before());
    return at && dismissed() !== before() ? at : null;
  });
  const suggestions = createMemo(() => {
    const at = mention();
    return at ? suggestMentions(at.query) : [];
  });
  const offering = () => suggestions().length > 0;

  const track = () => {
    const value = input?.value ?? "";
    setBefore(value.slice(0, input?.cursorOffset ?? value.length));
    setPick(0);
  };

  const take = () => {
    const at = mention();
    const chosen = suggestions()[pick()];
    if (!input || !at || !chosen) return false;
    const value = input.value;
    const cut = before().length;
    const ref = `@${mentionRef(chosen)} `;
    input.value =
      value.slice(0, at.start) + ref + value.slice(cut).replace(/^ /, "");
    input.cursorOffset = at.start + ref.length;
    track();
  };

  onMount(() => {
    const text = unsent.get(props.task.id);
    unsent.delete(props.task.id);
    if (input && text) input.value = text;
  });

  // Focusing the pane focuses the field inside it.
  createEffect(() => {
    if (p.isFocused()) setTimeout(() => input?.focus(), 0);
  });

  useScope(
    "input",
    {
      [Commands.INPUT_SUBMIT]: () => {
        if (offering()) return take();
        const text = input?.value ?? "";
        if (!text.trim()) return;
        props.onSay(text);
        if (input) input.value = "";
        track();
      },
      [Commands.INPUT_COMPLETE]: () => (offering() ? take() : false),
      [Commands.INPUT_PICK_UP]: () => {
        if (!offering()) return false;
        setPick((i) => (i + suggestions().length - 1) % suggestions().length);
      },
      [Commands.INPUT_PICK_DOWN]: () => {
        if (!offering()) return false;
        setPick((i) => (i + 1) % suggestions().length);
      },
      [Commands.INPUT_LEAVE]: () => {
        if (offering()) return void setDismissed(before());
        setActivePane("task");
      },
      [Commands.INPUT_EDITOR]: () => {
        const id = props.task.id;
        props.onCompose(input?.value ?? "", (text) => {
          if (text) unsent.set(id, text);
        });
      },
    },
    { target: p.target },
  );

  const placeholder = () =>
    props.task.kind === Kind.home
      ? "Ask about anything, or tell aug what to do... (@ names a task or project, ^g editor)"
      : props.task.kind === Kind.coding
        ? "Tell the coding agent... (enter sends, ^g editor, esc leaves)"
        : "Tell the agent what's wrong, or ask about anything here... (^g editor)";

  return (
    <box flexDirection="column" flexShrink={0} visible={!props.hidden()}>
      <Show when={offering()}>
        <box
          flexDirection="column"
          marginLeft={2}
          marginTop={1}
          paddingLeft={1}
          paddingRight={1}
          border
          borderStyle="rounded"
          borderColor={theme.border}
        >
          <For each={suggestions()}>
            {(m: Mention, i) => (
              <text
                fg={
                  i() === pick()
                    ? contrastingForeground(theme.secondary)
                    : theme.text
                }
                bg={i() === pick() ? theme.secondary : undefined}
              >
                {truncate(mentionLine(m), 70)}
              </text>
            )}
          </For>
        </box>
      </Show>
      <box
        ref={p.ref}
        flexShrink={0}
        marginTop={1}
        marginLeft={1}
        marginRight={1}
        paddingLeft={1}
        paddingRight={1}
        border
        borderStyle="rounded"
        borderColor={p.isFocused() ? theme.secondary : theme.border}
        focusedBorderColor={theme.secondary}
      >
        <input
          ref={(r: InputRenderable) => (input = r)}
          placeholder={placeholder()}
          onInput={track}
          focusedBackgroundColor={theme.background}
          backgroundColor={theme.background}
          cursorColor={theme.primary}
          focusedTextColor={theme.text}
          textColor={theme.text}
        />
      </box>
    </box>
  );
}

function FyiView(props: {
  item: Extract<RailItem, { type: "fyi" }>;
  width: number;
}) {
  const theme = useTheme();
  const aug = useAug();
  const m = () => props.item.message;
  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      flexGrow={1}
    >
      <text fg={theme.primary} attributes={1}>
        {`FYI · ${m().author_name}`}
      </text>
      <text
        fg={theme.textMuted}
        wrapMode="word"
      >{`${CHANNEL_WORD[m().channel]} · ${m().title} · ${dayClock(m().received_at, aug.now())}`}</text>
      <text
        fg={theme.textMuted}
        wrapMode="word"
      >{`triage: ${m().reason ?? "fyi"}`}</text>
      <scrollbox flexGrow={1} flexBasis={0} marginTop={1}>
        <text fg={theme.text} wrapMode="word">
          {m().body}
        </text>
      </scrollbox>
      <KeyHints
        hints={[
          ["x", "read"],
          ["n", "read, next"],
          ["m", "it was work: make it a task"],
          ["o", "open"],
        ]}
      />
    </box>
  );
}

// A project on the table: its tasks, newest work last, each with its lane.
function ProjectView(props: {
  item: Extract<RailItem, { type: "project" }>;
  width: number;
}) {
  const theme = useTheme();
  const aug = useAug();
  const p = () => props.item.project;
  const tasks = createMemo(() => {
    aug.version();
    return store
      .tasksForProject(p().id)
      .filter((t) => t.status === "open" || t.status === "later");
  });
  const laneOfTask = (t: TaskRow) => {
    const row = aug.items().find((i) => i.type === "task" && i.task.id === t.id);
    return row?.type === "task" ? LANE_META[row.lane] : null;
  };
  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      flexGrow={1}
      flexBasis={0}
    >
      <text fg={theme.secondary} attributes={1}>
        {`Project · ${p().name}`}
      </text>
      <text fg={theme.textMuted} wrapMode="word">
        {[
          `tmux ${p().tmux_session}`,
          props.item.repos.join(", ") || "no repo",
          `${props.item.open} open`,
          props.item.working ? `${props.item.working} working` : "",
        ]
          .filter(Boolean)
          .join(" · ")}
      </text>
      <scrollbox flexGrow={1} flexBasis={0} marginTop={1}>
        <For
          each={tasks()}
          fallback={
            <text fg={theme.textMuted}>
              Nothing open here. Ask Home to make a task in it.
            </text>
          }
        >
          {(t) => {
            const meta = laneOfTask(t);
            return (
              <text>
                <span style={{ fg: meta ? toneColor(theme, meta.tone) : theme.textMuted }}>
                  {`${meta?.mark ?? "·"} `}
                </span>
                <span style={{ fg: theme.textMuted }}>{`${store.taskRef(t.id)}  `}</span>
                <span style={{ fg: theme.text }}>
                  {truncate(t.title, Math.max(20, props.width - 40))}
                </span>
                <span style={{ fg: theme.textMuted }}>
                  {`  ${t.kind}${meta ? ` · ${meta.word}` : ""}${t.branch ? ` · ${t.branch}` : ""}`}
                </span>
              </text>
            );
          }}
        </For>
      </scrollbox>
      <KeyHints
        hints={[
          ["space", "rail: fold / unfold its tasks"],
          ["T", "jump to its tmux session"],
          ["x", "archive"],
          ["I", "info"],
        ]}
      />
    </box>
  );
}

function IdeaView(props: {
  item: Extract<RailItem, { type: "idea" }>;
  width: number;
}) {
  const theme = useTheme();
  const idea = () => props.item.idea;
  return (
    <box
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      flexGrow={1}
      flexBasis={0}
    >
      <text fg={theme.accent} attributes={1}>
        {`Advisor · ${idea().title}`}
      </text>
      <Show when={idea().task_id}>
        <text
          fg={theme.textMuted}
        >{`about ${store.taskRef(idea().task_id!)}`}</text>
      </Show>
      <box marginTop={1} flexGrow={1}>
        <Markdown text={idea().body} width={Math.max(20, props.width)} />
      </box>
      <KeyHints
        hints={[
          ["m", "put it on my list"],
          ["x", "dismiss"],
          ["n", "next"],
        ]}
      />
    </box>
  );
}

// Nothing on the table: what waits, in each section, and how to begin.
function Opening() {
  const theme = useTheme();
  const aug = useAug();
  const hour = () => aug.now().getHours();
  const greeting = () =>
    hour() < 12
      ? "Good morning"
      : hour() < 18
        ? "Good afternoon"
        : "Good evening";
  const lanes = createMemo(() => {
    const counts = new Map<string, number>();
    for (const i of aug.items()) {
      if (i.type !== "task") continue;
      counts.set(i.lane, (counts.get(i.lane) ?? 0) + 1);
    }
    return [...counts.entries()];
  });
  return (
    <box flexDirection="column" paddingLeft={2} paddingTop={1} flexGrow={1}>
      <text fg={theme.primary} attributes={1}>
        {greeting()}
      </text>
      <text fg={theme.textMuted}>{aug.now().toDateString()}</text>
      <box flexDirection="column" marginTop={1}>
        <For
          each={lanes()}
          fallback={<text fg={theme.textMuted}>Nothing waits on you.</text>}
        >
          {([lane, n]) => {
            const meta = LANE_META[lane as keyof typeof LANE_META];
            return (
              <text>
                <span
                  style={{ fg: toneColor(theme, meta.tone) }}
                >{`${meta.mark} ${n} `}</span>
                <span style={{ fg: theme.text }}>{meta.word}</span>
              </text>
            );
          }}
        </For>
      </box>
      <box marginTop={1}>
        <KeyHints
          hints={[
            ["n", "walk me through my tasks"],
            ["a", "home"],
            ["N", "new task"],
            ["v", "board"],
          ]}
        />
      </box>
    </box>
  );
}
