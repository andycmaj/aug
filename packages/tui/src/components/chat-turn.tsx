// One line of a task's chat. What came in, what you typed and Riker's short
// triggers sit indented on a rule; the agent's turns read as three short
// sections. An older turn folds to its "What I did" and keeps its draft,
// read-only, with where it went since.

import { SELF } from "@riker/core/brand";
import { createMemo, For, Match, Show, Switch, type Accessor } from "solid-js";
import { Markdown, useTheme } from "@andycmaj/opentui-app";
import { useRiker } from "../context/riker";
import { refusalLines } from "@riker/core/capabilities";
import { actionText, describeAction } from "@riker/core/outbound";
import {
  formatBytes,
  parseCsv,
  parseFiles,
  previewOf,
  readPreview,
  tableLines,
  type MadeFile,
} from "@riker/core/files";
import { turnSteps } from "@riker/core/rows";
import { TurnRole, type DraftAction, type TurnRow } from "@riker/core/types";
import { CHANNEL_WORD, clock, dayClock, duration } from "./ui";

export function ChatTurn(props: {
  turn: TurnRow;
  latestAgent: boolean;
  width: number;
}) {
  const theme = useTheme();
  const riker = useRiker();
  const t = () => props.turn;

  return (
    <Switch>
      <Match when={t().role === TurnRole.incoming}>
        <IncomingTurn turn={t()} width={props.width} />
      </Match>
      <Match when={t().role === TurnRole.you}>
        <box
          flexDirection="column"
          marginBottom={1}
          paddingLeft={6}
          border={["left"]}
          borderColor={theme.primary}
          borderStyle="single"
        >
          <text
            fg={theme.primary}
          >{`You · ${dayClock(t().started_at, riker.now())}`}</text>
          <text fg={theme.text} wrapMode="word">
            {t().body}
          </text>
        </box>
      </Match>
      <Match when={t().role === TurnRole.trigger}>
        <box marginBottom={1} paddingLeft={2}>
          <text fg={theme.textMuted} wrapMode="word">
            {`· ${t().body} · ${clock(t().started_at)}`}
          </text>
        </box>
      </Match>
      <Match when={t().role === TurnRole.agent}>
        <AgentTurn turn={t()} latest={props.latestAgent} width={props.width} />
      </Match>
      <Match when={t().role === TurnRole.action}>
        <ActionTurn turn={t()} width={props.width} />
      </Match>
    </Switch>
  );
}

function IncomingTurn(props: { turn: TurnRow; width: number }) {
  const theme = useTheme();
  const riker = useRiker();
  const message = createMemo(() =>
    props.turn.message_id ? riker.message(props.turn.message_id) : null,
  );
  const where = () => {
    const m = message();
    if (!m) return props.turn.author;
    return `${CHANNEL_WORD[m.channel]} · ${m.author_name} · ${m.title}`;
  };
  return (
    <box
      flexDirection="column"
      marginBottom={1}
      paddingLeft={6}
      border={["left"]}
      borderColor={theme.secondary}
      borderStyle="single"
    >
      <text
        fg={theme.secondary}
        wrapMode="word"
      >{`${where()} · ${dayClock(props.turn.started_at, riker.now())}`}</text>
      <text fg={theme.text} wrapMode="word">
        {props.turn.body}
      </text>
    </box>
  );
}

function AgentTurn(props: { turn: TurnRow; latest: boolean; width: number }) {
  const theme = useTheme();
  const riker = useRiker();
  const steps = createMemo(
    () => turnSteps(props.turn),
  );
  const running = () => props.turn.status === "running";
  const refusals = createMemo(() => refusalLines(steps()));
  const files = createMemo(() => parseFiles(props.turn.files));
  const action = createMemo(() =>
    props.turn.action ? (JSON.parse(props.turn.action) as DraftAction) : null,
  );
  const ran = () =>
    duration(props.turn.started_at, props.turn.finished_at, riker.now());
  // the running clock needs the spinner's tick, not the 30s clock
  const liveRan = () => {
    riker.spinner();
    return duration(props.turn.started_at, null, new Date());
  };

  return (
    <box flexDirection="column" marginBottom={1} paddingLeft={1}>
      <text>
        <span style={{ fg: theme.accent, attributes: 1 }}>
          {props.turn.author || "agent"}
        </span>
        <span
          style={{ fg: theme.textMuted }}
        >{` · ${clock(props.turn.started_at)} · `}</span>
        <Show
          when={running()}
          fallback={
            <span style={{ fg: theme.textMuted }}>{`ran ${ran()}`}</span>
          }
        >
          <span
            style={{ fg: theme.info }}
          >{`${riker.spinner()} working ${liveRan()}`}</span>
        </Show>
        <Show when={!running() && steps().length > 0}>
          <span
            style={{ fg: theme.textMuted }}
          >{` · ${steps().length} steps`}</span>
        </Show>
      </text>

      <Switch>
        <Match when={running()}>
          <box flexDirection="column" paddingLeft={2}>
            <For each={steps().slice(-8)}>
              {(step) => <text fg={theme.textMuted}>{`↳ ${step}`}</text>}
            </For>
            <Show when={steps().length === 0}>
              <text fg={theme.textMuted}>↳ reading the thread</text>
            </Show>
          </box>
        </Match>
        <Match when={props.turn.status === "failed"}>
          <text fg={theme.error} wrapMode="word">
            {props.turn.body}
          </text>
        </Match>
        {/* Home is a conversation: every answer stays whole, unheaded. */}
        <Match when={props.turn.author === SELF}>
          <box flexDirection="column" paddingLeft={2}>
            <Markdown
              text={props.turn.did ?? props.turn.body}
              width={Math.max(20, props.width - 4)}
            />
            <Show when={files().length > 0}>
              <WhatItMade files={files()} width={props.width - 4} />
            </Show>
          </box>
        </Match>
        <Match when={!props.latest}>
          <box flexDirection="column" paddingLeft={2}>
            <text fg={theme.textMuted} wrapMode="word">
              {firstLine(props.turn.did ?? props.turn.body)}
            </text>
            <Show when={files().length > 0}>
              <text fg={theme.textMuted}>
                {`made ${files().length} file${files().length === 1 ? "" : "s"}: ${files()
                  .map((f) => f.name)
                  .join(", ")}`}
              </text>
            </Show>
            <Show when={action()}>
              {(a: Accessor<DraftAction>) => (
                <text fg={theme.textMuted} wrapMode="word">
                  {`draft (${props.turn.action_state === "sent" ? "sent" : "not sent"}): ${firstLine(actionText(a()))}`}
                </text>
              )}
            </Show>
          </box>
        </Match>
        <Match when={props.latest}>
          <box flexDirection="column" paddingLeft={2}>
            <Show when={props.turn.about}>
              <text fg={theme.text} attributes={1}>
                What this is about
              </text>
              <text fg={theme.text} wrapMode="word">
                {props.turn.about ?? ""}
              </text>
            </Show>
            <text
              fg={theme.text}
              attributes={1}
              marginTop={props.turn.about ? 1 : 0}
            >
              What I did
            </text>
            <Markdown
              text={props.turn.did ?? props.turn.body}
              width={Math.max(20, props.width - 4)}
            />
            <Show when={files().length > 0}>
              <WhatItMade files={files()} width={props.width - 4} />
            </Show>
            <Show when={props.turn.next}>
              <text fg={theme.text} attributes={1} marginTop={1}>
                Next steps
              </text>
              <text fg={theme.text} wrapMode="word">
                {props.turn.next ?? ""}
              </text>
            </Show>
            <Show when={action() && props.turn.action_state !== "pending"}>
              <text fg={theme.textMuted} marginTop={1} wrapMode="word">
                {`${describeAction(action()!)}: ${props.turn.action_state === "sent" ? (props.turn.action_result ?? "sent") : props.turn.action_state}`}
              </text>
            </Show>
          </box>
        </Match>
      </Switch>
      {/* Steps fold away when a turn ends; a refused call must not. */}
      <Show when={!running() && refusals().length > 0}>
        <box flexDirection="column" paddingLeft={2} marginTop={1}>
          <For each={refusals()}>
            {(line) => (
              <text fg={theme.warning} wrapMode="word">
                {line}
              </text>
            )}
          </For>
        </box>
      </Show>
    </box>
  );
}

const PREVIEW_LINES = 40;

// The files a turn left: one line each, a markdown file rendered and a CSV
// shown as a small table. o opens one in your viewer, O in $EDITOR.
// A task action's answer (core/task-actions.ts): its title, then the result
// whole, on a rule of its own so it never reads as the agent's turn.
function ActionTurn(props: { turn: TurnRow; width: number }) {
  const theme = useTheme();
  const riker = useRiker();
  const steps = createMemo(() => turnSteps(props.turn));
  const refusals = createMemo(() => refusalLines(steps()));
  const files = createMemo(() => parseFiles(props.turn.files));
  const running = () => props.turn.status === "running";
  const liveRan = () => {
    riker.spinner();
    return duration(props.turn.started_at, null, new Date());
  };
  return (
    <box
      flexDirection="column"
      marginBottom={1}
      paddingLeft={2}
      border={["left"]}
      borderColor={theme.accent}
      borderStyle="single"
    >
      <text>
        <span style={{ fg: theme.accent, attributes: 1 }}>
          {props.turn.about || props.turn.author}
        </span>
        <span
          style={{ fg: theme.textMuted }}
        >{` · action · ${clock(props.turn.started_at)} · `}</span>
        <Show
          when={running()}
          fallback={
            <span style={{ fg: theme.textMuted }}>{`ran ${duration(props.turn.started_at, props.turn.finished_at, riker.now())}`}</span>
          }
        >
          <span style={{ fg: theme.info }}>{`${riker.spinner()} running ${liveRan()}`}</span>
        </Show>
      </text>
      <Switch>
        <Match when={running()}>
          <For each={steps().slice(-6)}>
            {(step) => <text fg={theme.textMuted}>{`↳ ${step}`}</text>}
          </For>
        </Match>
        <Match when={props.turn.status === "failed"}>
          <text fg={theme.error} wrapMode="word">
            {props.turn.body}
          </text>
        </Match>
        <Match when={true}>
          <Show
            when={props.turn.body.trim()}
            fallback={<text fg={theme.textMuted}>(it gave no answer)</text>}
          >
            <Markdown text={props.turn.body} width={Math.max(20, props.width - 4)} />
          </Show>
          <Show when={files().length > 0}>
            <WhatItMade files={files()} width={props.width - 4} />
          </Show>
        </Match>
      </Switch>
      <For each={refusals()}>
        {(line) => <text fg={theme.warning} wrapMode="word">{line}</text>}
      </For>
    </box>
  );
}

function WhatItMade(props: { files: MadeFile[]; width: number }) {
  const theme = useTheme();
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={theme.text} attributes={1}>
        What it made
      </text>
      <For each={props.files}>
        {(file) => {
          const kind = previewOf(file.name);
          const text = createMemo(() =>
            kind === "none" ? null : readPreview(file),
          );
          const markdown = () => {
            const lines = (text() ?? "").split("\n");
            return lines.length > PREVIEW_LINES
              ? `${lines.slice(0, PREVIEW_LINES).join("\n")}\n\n…`
              : lines.join("\n");
          };
          const table = () =>
            tableLines(
              parseCsv(
                text() ?? "",
                file.name.toLowerCase().endsWith(".tsv") ? "\t" : ",",
              ),
              Math.max(20, props.width - 4),
            );
          return (
            <box flexDirection="column" marginTop={1}>
              <text>
                <span style={{ fg: theme.secondary }}>{`▤ ${file.name}`}</span>
                <span
                  style={{ fg: theme.textMuted }}
                >{`  ${formatBytes(file.bytes)}`}</span>
              </text>
              <Show when={text() !== null && kind === "markdown"}>
                <box
                  paddingLeft={2}
                  border={["left"]}
                  borderColor={theme.borderSubtle}
                  borderStyle="single"
                >
                  <Markdown
                    text={markdown()}
                    width={Math.max(20, props.width - 6)}
                  />
                </box>
              </Show>
              <Show when={text() !== null && kind === "table"}>
                <box
                  paddingLeft={2}
                  flexDirection="column"
                  border={["left"]}
                  borderColor={theme.borderSubtle}
                  borderStyle="single"
                >
                  <For each={table()}>
                    {(line, i) => (
                      <text
                        fg={i() === 0 ? theme.text : theme.textMuted}
                        attributes={i() === 0 ? 1 : 0}
                      >
                        {line}
                      </text>
                    )}
                  </For>
                </box>
              </Show>
            </box>
          );
        }}
      </For>
      <text fg={theme.textMuted} marginTop={1}>
        <span style={{ fg: theme.primary }}>o</span> open ·{" "}
        <span style={{ fg: theme.primary }}>O</span> edit in $EDITOR
      </text>
    </box>
  );
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line.length > 160 ? `${line.slice(0, 157)}...` : line;
}

// The draft set up for one press, pinned above the box: who it goes to,
// the words, and the keys. Nothing goes out until y.
export function ActionCard(props: {
  action: DraftAction;
  result: string | null;
}) {
  const theme = useTheme();
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      marginLeft={1}
      marginRight={1}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={theme.contentPane}
    >
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.success} attributes={1}>
          {`↑ ${describeAction(props.action)}`}
        </text>
        <text>
          <span style={{ fg: theme.primary }}>y</span>
          <span style={{ fg: theme.textMuted }}> send · </span>
          <span style={{ fg: theme.primary }}>e</span>
          <span style={{ fg: theme.textMuted }}> edit · </span>
          <span style={{ fg: theme.primary }}>E</span>
          <span style={{ fg: theme.textMuted }}> redraft</span>
        </text>
      </box>
      <text fg={theme.text} wrapMode="word" marginTop={1}>
        {actionText(props.action)}
      </text>
      <Show when={props.result}>
        <text fg={theme.error} wrapMode="word" marginTop={1}>
          {props.result ?? ""}
        </text>
      </Show>
    </box>
  );
}
