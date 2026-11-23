// The Canvas: the selected row. A task is its chat (or, while a
// coding agent's terminal is open, that terminal; or ghdash on its PR, while
// the owner has that open), with the draft pinned above the box; an FYI or an
// Advisor idea shows the item itself.

import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
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
  Pane,
  truncate,
  useFocus,
  usePane,
  useScope,
  useTheme,
} from "@andycmaj/opentui-app";
import { Commands } from "../commands";
import { useRiker } from "../context/riker";
import { useTerminals, type TermState } from "../context/terminals";
import type { Lane, LaneMeta } from "@riker/core/lanes";
import { proposalHeadline } from "@riker/core/knowledge";
import { prChip, prLine } from "@riker/core/pr";
import { usd } from "@riker/core/spend";
import { journalSwitch, lines, storySwitchOf, switchWords } from "@riker/core/digests";
import {
  type Mention,
  mentionAt,
  mentionRef,
  suggestMentions,
} from "@riker/core/mentions";
import type { RailItem } from "@riker/core/rail";
import { isClosed, taskRef } from "@riker/core/rows";
import {
  AgentState,
  Kind,
  ProposalSource,
  ProposalStatus,
  type ProjectRow,
  type TaskRow,
} from "@riker/core/types";
import { inTmux } from "@riker/core/driver";
import { TerminalHost } from "./agent-terminal";
import { ActionCard, ChatTurn } from "./chat-turn";
import { actionTermId, unlessTyping, type TaskActions } from "./task-actions";
import { docReviewId } from "./use-doc-review";
import { prDashId, usePrDash } from "./use-pr-dash";
import { RAIL_WIDTH } from "./rail";
import {
  Badge,
  CHANNEL_WORD,
  dayClock,
  KeyHints,
  priorityColor,
  toneColor,
  useLaneMeta,
} from "./ui";

type Compose = (initial: string, keep: (text: string) => void) => void;

export function Canvas(props: {
  actions: TaskActions;
  onSay: (text: string) => void;
  onCompose: Compose;
}) {
  const riker = useRiker();
  const terminals = useTerminals();
  const { isPaneFocused, setActivePane, sidebarVisible } = useFocus();
  const leave = () => setActivePane("rail");
  const dims = useTerminalDimensions();
  let pane: Renderable | undefined;
  let scrollRef: ScrollBoxRenderable | undefined;

  const width = () =>
    dims().width - (sidebarVisible() ? RAIL_WIDTH + 2 : 0) - 6;
  const item = () => riker.selected();
  const task = createMemo(() => {
    const i = item();
    return i?.type === "task" ? riker.task(i.task.id) : null;
  });
  const term = createMemo(() => {
    const t = task();
    // Live, it takes the Canvas; once it stops, its Result in the chat does.
    const tm =
      t && inTmux(t) ? terminals.forTask(t.id) : undefined;
    return tm?.running ? tm : undefined;
  });
  // ghdash (P), a System task's diff in revdiff (e) or a task action's
  // terminal (the guide's review, a quiz) takes the Canvas over the chat
  // and the agent.
  const dash = createMemo(() => {
    const t = task();
    if (!t) return undefined;
    const d = terminals.get(prDashId(t.id));
    if (d?.running) return d;
    const r = terminals.get(docReviewId(t.id));
    if (r?.running) return r;
    const a = terminals.get(actionTermId(t.id));
    return a?.running ? a : undefined;
  });
  const attached = () =>
    isPaneFocused("canvas") && Boolean(dash() ?? term()?.running);
  const editor = () => terminals.get("editor");

  useScope(
    "canvas",
    unlessTyping(
      {
        [Commands.NAV_DOWN]: () => scrollRef?.scrollBy(2),
        [Commands.NAV_UP]: () => scrollRef?.scrollBy(-2),
        [Commands.NAV_TOP]: () => scrollRef?.scrollTo(0),
        [Commands.NAV_BOTTOM]: () =>
          scrollRef?.scrollTo(scrollRef.scrollHeight),
        [Commands.SCROLL_PAGEDOWN]: () => scrollRef?.scrollBy(0.8, "viewport"),
        [Commands.SCROLL_PAGEUP]: () => scrollRef?.scrollBy(-0.8, "viewport"),
        [Commands.BACK_TO_RAIL]: leave,
        ...props.actions,
      },
      () => isPaneFocused("input"),
    ),
    { target: () => pane },
  );

  // ghdash goes when the selection moves on: it polls GitHub while it runs.
  const prDash = usePrDash();
  createEffect(
    on(
      () => riker.selectedKey(),
      () => prDash.closeOthers(task()?.id ?? null),
    ),
  );

  // A newly selected item opens at its newest line.
  createEffect(
    on(
      () => riker.selectedKey(),
      () => queueMicrotask(() => scrollRef?.scrollTo(scrollRef.scrollHeight)),
    ),
  );

  return (
    <Pane name="canvas" ref={(r) => (pane = r)}>
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
              attached={() => isPaneFocused("canvas")}
              pane={() => pane}
              onDetach={leave}
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
                when={!dash()}
                fallback={
                  <TerminalHost
                    id={dash()?.id ?? prDashId(t().id)}
                    attached={attached}
                    pane={() => pane}
                    onDetach={leave}
                  />
                }
              >
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
                      onDetach={leave}
                      onJump={() => void props.actions[Commands.JUMP]?.()}
                    />
                  )}
                </Show>
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
        <Match when={item()?.type === "project" && item()}>
          {(i: Accessor<RailItem>) => (
            <ProjectView
              item={i() as Extract<RailItem, { type: "project" }>}
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
  const riker = useRiker();
  const lane = () => {
    const item = riker
      .items()
      .find((i) => i.type === "task" && i.task.id === props.task.id);
    return item?.type === "task" ? item.lane : null;
  };
  const metaOf = useLaneMeta();
  const meta = () => (lane() ? metaOf(lane()!) : null);
  const came = createMemo(() => {
    const first = riker.messages(props.task.id)[0];
    const from = first
      ? `${CHANNEL_WORD[first.channel]} · ${first.author_name} · ${first.title}`
      : "typed by you";
    return `${from} · ${dayClock(props.task.created_at, riker.now())}`;
  });
  // One line of what is attached: titles, else the bare address. o opens.
  const links = createMemo(() => {
    const names = riker
      .taskLinks(props.task.id)
      .map((l) => l.title ?? l.url.replace(/^https?:\/\//, ""));
    return names.length
      ? truncate(`links · ${names.join(" · ")}  (o opens)`, Math.max(20, props.width - 4))
      : null;
  });
  // The task's PR as of the last read; P opens it in ghdash.
  const pr = createMemo(() => {
    const found = riker.taskPrStatus(props.task);
    if (!found) return null;
    const { pr: ref, status } = found;
    const text = status
      ? prLine(status)
      : `PR ${ref.repo}#${ref.number} · not read yet`;
    return {
      text: truncate(`${text}  (P ghdash)`, Math.max(20, props.width - 4)),
      tone: status ? prChip(status).tone : ("muted" as const),
    };
  });
  // Its story, when on: the owner's pins, the next step, what blocks it.
  // I shows all of it; J turns it off.
  const story = createMemo(() => {
    const t = props.task;
    const project = t.project_id ? riker.project(t.project_id) : null;
    if (!storySwitchOf(riker.desk.config(), t, project).on) return null;
    const v = riker.story(t.id);
    const width = Math.max(20, props.width - 4);
    if (!v) return truncate("story · written up when a session finishes  (J off)", width);
    const first = (field: string, label: string) => {
      const item = lines(field)[0];
      return item ? `${label}: ${item}` : null;
    };
    const parts = [
      ...lines(v.pinned).map((p) => `pinned: ${p}`),
      first(v.next, "next"),
      first(v.blocked, "blocked"),
    ].filter(Boolean);
    return truncate(`story · ${parts.join(" · ") || "nothing left to do"}  (I all, J off)`, width);
  });
  // What its headless turns have cost (riker-tools spend, the Board's Cost).
  const spent = () => {
    const s = riker.taskSpend(props.task.id);
    return s.calls ? ` · ${usd(s.cost)} spent` : "";
  };
  const says = () => {
    const t = props.task;
    if (t.agent_state === AgentState.waiting && t.agent_says)
      return `agent ${t.agent_says}`;
    if (t.agent_state === AgentState.queued && t.queue_reason)
      return `waiting to start: ${t.queue_reason}`;
    if (t.waiting_on) return `waiting on ${t.waiting_on}`;
    return null;
  };

  // A branch, not an early return: the Canvas keeps this header when the
  // selection moves from Home to a task, so the body must follow props.
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
            >{`${taskRef(props.task.id)}  `}</span>
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
              {(m: Accessor<LaneMeta>) => (
                <Badge text={m().word} color={toneColor(theme, m().tone)} />
              )}
            </Show>
          </box>
        </box>
        <text fg={theme.textMuted} wrapMode="word">
          {`${props.task.kind} · ${came()}${spent()}`}
        </text>
        <Show when={pr()}>
          {(p: Accessor<NonNullable<ReturnType<typeof pr>>>) => (
            <text fg={toneColor(theme, p().tone)}>{p().text}</text>
          )}
        </Show>
        <Show when={links()}>
          <text fg={theme.info}>{links() ?? ""}</text>
        </Show>
        <Show when={story()}>
          <text fg={theme.secondary}>{story() ?? ""}</text>
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
  const riker = useRiker();
  const theme = useTheme();
  const turns = createMemo(() => riker.turns(props.task.id));
  const latestAgentId = createMemo(
    () => [...turns()].reverse().find((t) => t.role === "agent")?.id ?? null,
  );
  // A System task's open proposals: which doc, how big, and why.
  const proposals = createMemo(() => {
    return props.task.kind === Kind.system
      ? riker
          .proposals(props.task.id)
          .filter((p) => p.status === ProposalStatus.open)
      : [];
  });
  // Shown until the agent starts from it; after that the chat carries on.
  const brief = createMemo((): string | null =>
    riker.briefEditable(props.task.id) ? props.task.summary : null,
  );
  const hint = createMemo((): [string, string][] => {
    const t = props.task;
    if (t.kind === Kind.home)
      return [
        ["i", "talk"],
        ["@", "name a task or project"],
        ["a", "back here from anywhere"],
      ];
    if (t.kind === Kind.system)
      return proposals().length
        ? [
            ["e", "read the diff"],
            ["y", "accept"],
            ["x", "reject"],
            ...(proposals().some((p) => p.source !== ProposalSource.shipped)
              ? ([["i", "notes to redraft it"]] as [string, string][])
              : []),
          ]
        : [
            ["y", "accept"],
            ["x", "skip"],
          ];
    if (isClosed(t))
      return [
        ["d", "reopen"],
        ["i", "type: reopens it too"],
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
            <text fg={theme.textMuted}>
              {props.task.kind === Kind.system ? "Riker asks" : "brief"}
            </text>
            <text wrapMode="word">{text()}</text>
          </box>
        )}
      </Show>
      <For each={proposals()}>
        {(p) => (
          <box flexDirection="column" marginBottom={1}>
            <text fg={theme.primary}>{proposalHeadline(p)}</text>
            <Show when={p.reason}>
              <text wrapMode="word" fg={theme.textMuted}>
                {p.reason}
              </text>
            </Show>
          </box>
        )}
      </For>
      <For each={turns()}>
        {(turn) => (
          <ChatTurn
            turn={turn}
            latestAgent={turn.id === latestAgentId()}
            width={props.width}
          />
        )}
      </For>
      <Show when={isClosed(props.task) && props.task.kind !== Kind.home}>
        <text fg={theme.textMuted}>{closedLine(props.task)}</text>
      </Show>
      <box paddingLeft={1} marginTop={1}>
        <KeyHints hints={hint()} />
      </box>
    </scrollbox>
  );
}

// What closed it, who and when: a dropped task is off the rail, so this is
// where the owner learns how it got there and how to bring it back.
function closedLine(task: TaskRow): string {
  const by = task.closed_by ? ` by ${task.closed_by}` : "";
  const at = task.closed_at ? ` ${dayClock(task.closed_at)}` : "";
  return `· ${task.status}${by}${at}`;
}

function PendingCard(props: { taskId: number }) {
  const riker = useRiker();
  const pending = createMemo(() => riker.pendingAction(props.taskId));
  return (
    <Show when={pending()}>
      {(p: Accessor<NonNullable<ReturnType<typeof riker.pendingAction>>>) => (
        <ActionCard action={p().action} result={p().turn.action_result} />
      )}
    </Show>
  );
}

function mentionLine(m: Mention, openTasks: (p: ProjectRow) => number): string {
  if (m.type === "project") {
    const open = openTasks(m.project);
    return `@${mentionRef(m)}  project ${m.project.name}, ${open} open`;
  }
  const t = m.task;
  return `${taskRef(t.id)}  ${t.title}${t.status === "open" ? "" : ` (${t.status})`}`;
}

// Each task's unsent text: what the editor handed back (the box unmounts
// while the editor has the Canvas) and what was typed before the selection
// moved on. The box stays mounted from task to task, so without this a draft
// followed you, and ctrl+a carried it into Home's box, where enter sends it.
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
  const riker = useRiker();
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
  // Read at unmount, when the task accessor may already be gone.
  let shown = props.task.id;
  const keep = () => {
    const text = input?.value ?? "";
    if (text) unsent.set(shown, text);
  };
  createEffect(
    on(
      () => props.task.id,
      (id) => {
        if (!input) return;
        keep();
        shown = id;
        input.value = unsent.get(id) ?? "";
        unsent.delete(id);
        track();
      },
      { defer: true },
    ),
  );
  onCleanup(keep);

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
        setActivePane("canvas");
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
      ? "Ask about anything, or tell riker what to do... (@ names a task or project, ^g editor)"
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
                {truncate(mentionLine(m, (p) => riker.projectSummary(p).open), 70)}
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

function ProjectView(props: {
  item: Extract<RailItem, { type: "project" }>;
  width: number;
}) {
  const theme = useTheme();
  const riker = useRiker();
  const p = () => props.item.project;
  const tasks = createMemo(() => {
    return riker
      .tasksForProject(p().id)
      .filter((t) => t.status === "open" || t.status === "later");
  });
  const metaOf = useLaneMeta();
  const laneOfTask = (t: TaskRow) => {
    const row = riker.items().find((i) => i.type === "task" && i.task.id === t.id);
    return row?.type === "task" ? metaOf(row.lane) : null;
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
          switchWords("journal", journalSwitch(riker.desk.config(), riker.project(p().id) ?? p())),
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
                <span style={{ fg: theme.textMuted }}>{`${taskRef(t.id)}  `}</span>
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
          ["J", "journal on/off"],
          ["I", "info"],
        ]}
      />
    </box>
  );
}

function Opening() {
  const theme = useTheme();
  const riker = useRiker();
  const metaOf = useLaneMeta();
  const hour = () => riker.now().getHours();
  const greeting = () =>
    hour() < 12
      ? "Good morning"
      : hour() < 18
        ? "Good afternoon"
        : "Good evening";
  const lanes = createMemo(() => {
    const counts = new Map<string, number>();
    for (const i of riker.items()) {
      if (i.type !== "task" || i.copy) continue;
      counts.set(i.lane, (counts.get(i.lane) ?? 0) + 1);
    }
    return [...counts.entries()];
  });
  return (
    <box flexDirection="column" paddingLeft={2} paddingTop={1} flexGrow={1}>
      <text fg={theme.primary} attributes={1}>
        {greeting()}
      </text>
      <text fg={theme.textMuted}>{riker.now().toDateString()}</text>
      <box flexDirection="column" marginTop={1}>
        <For
          each={lanes()}
          fallback={<text fg={theme.textMuted}>Nothing waits on you.</text>}
        >
          {([lane, n]) => {
            const meta = metaOf(lane as Lane);
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
