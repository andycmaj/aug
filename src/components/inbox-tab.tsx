// The Inbox tab: every message triage saw and every Advisor idea, newest
// first, one line each. Enter opens a row in place to show the chain that
// routed it. Nothing here sends anything to anyone.

import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import {
  contrastingForeground,
  truncate,
  useTheme,
  type ThemeColor,
} from "@andycmaj/opentui-app";
import { Commands } from "../commands";
import { useAug } from "../context/aug";
import {
  BODY_CHARS,
  INBOX_FILTERS,
  InboxFilter,
  InboxResult,
  inFilter,
  matchesQuery,
  nextFilter,
  RESULT_WORDS,
  shownBody,
  type InboxRow,
  type InboxRun,
} from "../core/inbox";
import { taskRef } from "../core/rows";
import { StepDecision } from "../core/types";
import type { HelpCtx } from "../keymap";
import type { Actions, Dialogs } from "./actions";
import { PromptModal } from "./modals";

type Handler = () => false | void;

// Kept across tab switches, like the Board's tab.
const [filter, setFilter] = createSignal<InboxFilter>(InboxFilter.actionable);
const [query, setQuery] = createSignal("");
const [at, setAt] = createSignal(0);
const [openKey, setOpenKey] = createSignal<string | null>(null);
const [revealed, setRevealed] = createSignal<string | null>(null);

export function useInboxTab(opts: {
  active: () => boolean;
  actions: Actions;
  dialogs: Dialogs;
}) {
  const aug = useAug();
  const all = createMemo(() => (opts.active() ? aug.inbox() : []));
  const rows = createMemo(() =>
    all().filter((r) => inFilter(r, filter()) && matchesQuery(r, query())),
  );
  const row = (): InboxRow | null =>
    rows()[Math.min(at(), rows().length - 1)] ?? null;
  const counts = createMemo(() => {
    const out = {} as Record<InboxFilter, number>;
    for (const f of INBOX_FILTERS)
      out[f.filter] = all().filter((r) => inFilter(r, f.filter)).length;
    return out;
  });

  const move = (d: number) => {
    setAt((i) => Math.max(0, Math.min(rows().length - 1, i + d)));
    // One row open at a time, and only the one you are on.
    setOpenKey(null);
    setRevealed(null);
  };

  const onRow = (fn: (r: InboxRow) => false | void): Handler => () => {
    if (!opts.active()) return false;
    const r = row();
    if (!r) return false;
    return fn(r);
  };
  const onMessage = (fn: (r: Extract<InboxRow, { type: "message" }>) => false | void) =>
    onRow((r) => (r.type === "message" ? fn(r) : false));

  // The task an Inbox row points at: what Start and Move act on. An open
  // idea's task is only what it is about, so it is not one.
  const task = () => {
    const r = row();
    if (!opts.active() || !r) return null;
    const id = r.type === "message" ? r.taskId : r.idea.made_task_id;
    return id === null ? null : aug.task(id);
  };

  const commands: Record<string, Handler> = {
    [Commands.INBOX_EXPAND]: onRow((r) => {
      setOpenKey((k) => (k === r.key ? null : r.key));
    }),
    [Commands.INBOX_FILTER]: () => {
      if (!opts.active()) return false;
      setFilter(nextFilter(filter()));
      setAt(0);
      setOpenKey(null);
    },
    [Commands.INBOX_SEARCH]: () => {
      if (!opts.active()) return false;
      if (query()) {
        setQuery("");
        setAt(0);
        return;
      }
      opts.dialogs.show(() => (
        <PromptModal
          title="Search the Inbox"
          hint="Subject, sender, source (slack, github, advisor) or result. / again clears it."
          onSubmit={(text) => {
            setQuery(text);
            setAt(0);
            setOpenKey(null);
          }}
          onClose={opts.dialogs.close}
        />
      ));
    },
    [Commands.INBOX_GO]: onRow((r) => {
      if (r.taskId === null) return false;
      opts.actions.goToTask(r.taskId);
    }),
    [Commands.MAKE_TASK]: onRow((r) => {
      if (r.type === "idea" ? r.result !== InboxResult.idea : r.taskId !== null) return false;
      opts.actions.inboxMakeTask(r);
    }),
    [Commands.DISMISS_IDEA]: onRow((r) => {
      if (r.type !== "idea" || r.result !== InboxResult.idea) return false;
      opts.actions.inboxDismiss(r);
    }),
    [Commands.INBOX_READ]: onMessage((r) => {
      if (r.read) return false;
      opts.actions.inboxDismiss(r);
    }),
    [Commands.NOT_TASK]: onMessage((r) => {
      if (r.result !== InboxResult.task) return false;
      return opts.actions.inboxNotATask(r);
    }),
    [Commands.OPEN_URL]: onMessage((r) => opts.actions.openMessage(r.message)),
    [Commands.INBOX_NOISE]: onMessage((r) => {
      if (r.taskId !== null) return false;
      opts.actions.noiseFilter(r.message);
    }),
    [Commands.INBOX_RETRIAGE]: onMessage((r) => {
      if (r.taskId !== null) return false;
      void opts.actions.retriage(r.message);
    }),
    [Commands.INBOX_BODY]: onMessage((r) => {
      setOpenKey(r.key);
      setRevealed((k) => (k === r.key ? null : r.key));
    }),
  };

  const ctx = (): Partial<HelpCtx> => {
    const r = row();
    if (!r) return { item: null };
    return {
      item: r.type === "idea" ? "idea" : r.result === InboxResult.fyi ? "fyi" : "message",
      inboxTask: r.taskId !== null,
      handled: r.type === "idea" && r.result !== InboxResult.idea,
      inboxRead: r.type === "message" && r.read,
      inboxMade: r.type === "message" && r.result === InboxResult.task,
      inboxWork: task() !== null,
      live: Boolean(task() && aug.isLive(task()!)),
    };
  };

  return {
    commands,
    ctx,
    task,
    move,
    View: (props: { width: number }) => (
      <InboxView
        rows={rows()}
        selected={Math.min(at(), rows().length - 1)}
        openKey={openKey()}
        revealed={revealed()}
        counts={counts()}
        filter={filter()}
        query={query()}
        width={props.width}
      />
    ),
  };
}

// Today's time, else the day: a list read top-down by recency.
function when(iso: string, now: Date): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toTimeString().slice(0, 5)
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

type Tone = "muted" | "warning" | "success" | "info";

function resultTone(result: InboxResult): Tone {
  switch (result) {
    case InboxResult.idea:
    case InboxResult.failed:
    case InboxResult.untriaged:
      return "warning";
    case InboxResult.task:
    case InboxResult.tasked:
      return "success";
    case InboxResult.attached:
      return "info";
    default:
      return "muted";
  }
}

function InboxView(props: {
  rows: InboxRow[];
  selected: number;
  openKey: string | null;
  revealed: string | null;
  counts: Record<InboxFilter, number>;
  filter: InboxFilter;
  query: string;
  width: number;
}) {
  const theme = useTheme();
  const aug = useAug();
  let scrollRef: ScrollBoxRenderable | undefined;

  // Rows above the selected one are one line each (only the selected one
  // opens), so its top is its index.
  createEffect(
    on(
      () => [props.selected, props.openKey] as const,
      ([selected, openKey]) => {
        if (!scrollRef || selected < 0) return;
        const view = scrollRef.viewport.height ?? 10;
        if (openKey || selected < scrollRef.scrollTop) scrollRef.scrollTo(selected);
        else if (selected + 1 > scrollRef.scrollTop + view)
          scrollRef.scrollTo(selected + 1 - view);
      },
    ),
  );

  const tone = (t: Tone): ThemeColor =>
    t === "muted"
      ? theme.textMuted
      : t === "warning"
        ? theme.warning
        : t === "success"
          ? theme.success
          : theme.info;

  const subjectWidth = () => Math.max(16, props.width - 7 - 8 - 16 - 16 - 22 - 12);

  return (
    <box flexDirection="column" flexGrow={1} flexBasis={0} paddingLeft={1}>
      <box flexDirection="row" gap={1} flexShrink={0} paddingBottom={1}>
        <For each={INBOX_FILTERS}>
          {(f) => (
            <text
              fg={f.filter === props.filter ? contrastingForeground(theme.secondary) : theme.textMuted}
              bg={f.filter === props.filter ? theme.secondary : undefined}
            >{` ${f.word} ${props.counts[f.filter]} `}</text>
          )}
        </For>
        <text fg={theme.textMuted}>{"f next"}</text>
        <Show when={props.query}>
          <text fg={theme.accent}>{`/ "${props.query}"`}</text>
        </Show>
      </box>
      <Show
        when={props.rows.length > 0}
        fallback={
          <text fg={theme.textMuted}>
            {props.query
              ? "Nothing matches. / clears the search."
              : props.filter === InboxFilter.actionable
                ? "Nothing needs you here. f shows the rest; GitHub and Slack messages and Advisor ideas land here."
                : "Nothing under this filter. f shows the next."}
          </text>
        }
      >
        <scrollbox
          ref={(r: ScrollBoxRenderable) => (scrollRef = r)}
          flexGrow={1}
          flexBasis={0}
        >
          <For each={props.rows}>
            {(row, i) => {
              const sel = () => i() === props.selected;
              const fg = (c: ThemeColor) => (sel() ? contrastingForeground(theme.primary) : c);
              const ref = () => {
                if (row.taskId === null) return "";
                const t = aug.task(row.taskId);
                const project = t?.project_id ? aug.project(t.project_id)?.name : null;
                // An idea's task is only what it is about until approving it
                // makes one; a bare ref read as "the Advisor made a task".
                const about = row.type === "idea" && row.idea.made_task_id === null;
                return `${about ? "about " : ""}${taskRef(row.taskId)}${project ? ` ${project}` : ""}`;
              };
              return (
                <box flexDirection="column">
                  <box flexDirection="row" gap={1} backgroundColor={sel() ? theme.primary : undefined}>
                    <text fg={fg(theme.textMuted)} width={7} flexShrink={0}>
                      {when(row.at, aug.now())}
                    </text>
                    <text fg={fg(theme.secondary)} width={8} flexShrink={0}>
                      {row.source}
                    </text>
                    <text fg={fg(theme.text)} width={16} flexShrink={0}>
                      {truncate(row.from, 16)}
                    </text>
                    <text fg={fg(row.read ? theme.textMuted : theme.text)} flexGrow={1}>
                      {truncate(row.subject, subjectWidth())}
                    </text>
                    <text fg={fg(tone(resultTone(row.result)))} width={16} flexShrink={0}>
                      {RESULT_WORDS[row.result]}
                    </text>
                    <text fg={fg(theme.textMuted)} width={22} flexShrink={0}>
                      {truncate(ref(), 22)}
                    </text>
                  </box>
                  <Show when={props.openKey === row.key}>
                    <Detail row={row} revealed={props.revealed === row.key} width={props.width} />
                  </Show>
                </box>
              );
            }}
          </For>
        </scrollbox>
      </Show>
    </box>
  );
}

function localStamp(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${d.toTimeString().slice(0, 5)}`;
}

interface VerdictJson {
  verdict?: string;
  title?: string;
  priority?: string;
  reason?: string;
  project?: string;
  error?: string;
}

function readJson<T>(text: string | null): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// The open row: each step the chain ran, the model's verdict, the input,
// the body (capped unless revealed) and the runs before this one.
function Detail(props: { row: InboxRow; revealed: boolean; width: number }) {
  const theme = useTheme();
  const aug = useAug();
  const width = () => Math.max(20, props.width - 8);
  const runs = createMemo((): InboxRun[] =>
    props.row.type === "message" ? aug.inboxRuns(props.row.message.id) : [],
  );
  const latest = () => runs()[0] ?? null;

  return (
    <box flexDirection="column" paddingLeft={2} paddingTop={1} paddingBottom={1} backgroundColor={theme.contentPane}>
      <Show
        when={props.row.type === "message" ? props.row : null}
        fallback={
          <Show when={props.row.type === "idea" ? props.row : null}>
            {(idea: () => Extract<InboxRow, { type: "idea" }>) => (
              <box flexDirection="column">
                <text fg={theme.text} wrapMode="word">{idea().idea.body}</text>
                <text fg={theme.textMuted}>
                  {[
                    idea().idea.task_id ? `about ${taskRef(idea().idea.task_id!)}` : null,
                    idea().idea.made_task_id
                      ? `${RESULT_WORDS[idea().result]}: ${taskRef(idea().idea.made_task_id!)}`
                      : RESULT_WORDS[idea().result],
                    idea().result === InboxResult.idea ? "m approve · x dismiss" : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </text>
              </box>
            )}
          </Show>
        }
      >
        {(msg: () => Extract<InboxRow, { type: "message" }>) => (
          <box flexDirection="column">
            <Show
              when={latest()}
              fallback={
                <text fg={msg().result === InboxResult.untriaged ? theme.warning : theme.textMuted}>
                  {msg().result === InboxResult.untriaged
                    ? "Triage has not run on it. Shift+U runs it."
                    : `filed before triage kept its chain: ${msg().message.reason ?? RESULT_WORDS[msg().result]}`}
                </text>
              }
            >
              {(run: () => InboxRun) => {
                const verdict = () => readJson<VerdictJson>(run().run.verdict);
                const input = () => readJson<Record<string, unknown>>(run().run.input) ?? {};
                return (
                  <box flexDirection="column">
                    <For each={run().steps}>
                      {(step) => (
                        <text>
                          <span style={{ fg: step.decision === StepDecision.claim ? theme.success : theme.textMuted }}>
                            {step.decision === StepDecision.claim ? "● " : "· "}
                          </span>
                          <span style={{ fg: step.decision === StepDecision.claim ? theme.text : theme.textMuted }}>
                            {step.rule.padEnd(14)}
                          </span>
                          <span style={{ fg: theme.textMuted }}>
                            {truncate(step.reason, width() - 18)}
                          </span>
                        </text>
                      )}
                    </For>
                    <Show when={verdict()}>
                      {(v: () => VerdictJson) => (
                        <text fg={theme.info}>
                          {truncate(
                            v().error
                              ? `model: failed (${v().error})`
                              : `model: ${[v().verdict, v().priority, v().title ? `"${v().title}"` : null, v().project ? `project ${v().project}` : null]
                                  .filter(Boolean)
                                  .join(" · ")}`,
                            width(),
                          )}
                        </text>
                      )}
                    </Show>
                    <text fg={theme.textMuted}>
                      {truncate(
                        [
                          input().dm ? "a DM" : null,
                          input().openOnThread ? `open on the thread: ${String(input().openOnThread)}` : null,
                          !input().openOnThread && input().lastOnThread
                            ? `last on the thread: ${String(input().lastOnThread)}`
                            : null,
                          `ran ${localStamp(run().run.at)}`,
                        ]
                          .filter(Boolean)
                          .join(" · "),
                        width(),
                      )}
                    </text>
                  </box>
                );
              }}
            </Show>
            <box marginTop={1}>
              <text fg={theme.text} wrapMode="word">
                {shownBody(msg().message.body, props.revealed)}
              </text>
            </box>
            <Show when={!props.revealed && msg().message.body.length > BODY_CHARS}>
              <text fg={theme.textMuted}>Shift+B shows the whole message.</text>
            </Show>
            <Show when={runs().length > 1}>
              <box flexDirection="column" marginTop={1}>
                <text fg={theme.textMuted}>{`${runs().length - 1} earlier run${runs().length > 2 ? "s" : ""}:`}</text>
                <For each={runs().slice(1)}>
                  {(r) => (
                    <text fg={theme.textMuted}>
                      {truncate(
                        `  ${localStamp(r.run.at)} · ${r.run.rule} → ${r.run.outcome ?? "?"} · ${r.run.reason}`,
                        width(),
                      )}
                    </text>
                  )}
                </For>
              </box>
            </Show>
          </box>
        )}
      </Show>
    </box>
  );
}
