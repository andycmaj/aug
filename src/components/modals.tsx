// The small dialogs: a line of text, a pick from a list, the Send confirm,
// and the connections status. All on the framework's Modal, so they own the
// keyboard while open and hand focus back on close.

import { createMemo, createSignal, For, Show } from "solid-js";
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import {
  contrastingForeground,
  copyToClipboard,
  Modal,
  ModalCommands,
  ModalFilterInput,
  ModalHeader,
  modalNavBindings,
  useTheme,
  type BindingSpec,
} from "@andycmaj/opentui-app";
import { useAug } from "../context/aug";
import { paths } from "../core/paths";
import type { InfoSection } from "../core/info";
import { actionText, describeAction } from "../core/outbound";
import type { DraftAction } from "../core/types";
import { stateColor, stateGlyph } from "./connector-line";
import { dayClock } from "./ui";

export function PromptModal(props: {
  title: string;
  placeholder?: string;
  hint?: string;
  initial?: string;
  onSubmit: (text: string) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  let value = props.initial ?? "";
  return (
    <Modal
      size="lg"
      onClose={props.onClose}
      bindings={[
        { key: "return", cmd: ModalCommands.MODAL_SELECT, desc: "ok" },
      ]}
      commands={{
        [ModalCommands.MODAL_SELECT]: () => {
          if (!value.trim()) return;
          props.onClose();
          props.onSubmit(value.trim());
        },
      }}
    >
      <ModalHeader title={props.title} hint="↵ ok · esc" />
      <Show when={props.hint}>
        <box paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={theme.textMuted} wrapMode="word">
            {props.hint ?? ""}
          </text>
        </box>
      </Show>
      <ModalFilterInput
        onInput={(v) => (value = v)}
        placeholder={props.placeholder}
        initialValue={props.initial}
      />
    </Modal>
  );
}

export interface Choice {
  label: string;
  hint?: string;
  run: () => void;
}

export function ChoiceModal(props: {
  title: string;
  hint?: string;
  choices: Choice[];
  onClose: () => void;
}) {
  const theme = useTheme();
  const [selected, setSelected] = createSignal(0);
  const move = (d: number) =>
    setSelected((s) => Math.max(0, Math.min(props.choices.length - 1, s + d)));
  const bindings: BindingSpec[] = [
    ...modalNavBindings,
    { key: "j", cmd: ModalCommands.MODAL_DOWN, desc: "down" },
    { key: "k", cmd: ModalCommands.MODAL_UP, desc: "up" },
  ];
  return (
    <Modal
      size="md"
      onClose={props.onClose}
      bindings={bindings}
      commands={{
        [ModalCommands.MODAL_DOWN]: () => move(1),
        [ModalCommands.MODAL_UP]: () => move(-1),
        [ModalCommands.MODAL_SELECT]: () => {
          const choice = props.choices[selected()];
          props.onClose();
          choice?.run();
        },
      }}
    >
      <ModalHeader title={props.title} hint="↵ pick · esc" />
      <Show when={props.hint}>
        <box paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={theme.textMuted} wrapMode="word">
            {props.hint ?? ""}
          </text>
        </box>
      </Show>
      <box
        flexDirection="column"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <For each={props.choices}>
          {(choice, i) => {
            const on = () => i() === selected();
            return (
              <box
                flexDirection="row"
                justifyContent="space-between"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={on() ? theme.primary : undefined}
              >
                <text
                  fg={on() ? contrastingForeground(theme.primary) : theme.text}
                  attributes={on() ? 1 : 0}
                >
                  {choice.label}
                </text>
                <Show when={choice.hint}>
                  <text
                    fg={
                      on()
                        ? contrastingForeground(theme.primary)
                        : theme.textMuted
                    }
                  >
                    {choice.hint ?? ""}
                  </text>
                </Show>
              </box>
            );
          }}
        </For>
      </box>
    </Modal>
  );
}

// Nothing goes out until this second yes: what, to whom, the exact words.
export function ConfirmSendModal(props: {
  action: DraftAction;
  onSend: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  return (
    <Modal
      size="lg"
      onClose={props.onClose}
      bindings={[
        { key: "y", cmd: ModalCommands.MODAL_SELECT, desc: "send" },
        { key: "return", cmd: ModalCommands.MODAL_SELECT, desc: "send" },
        { key: "n", cmd: ModalCommands.MODAL_CLOSE, desc: "cancel" },
      ]}
      commands={{
        [ModalCommands.MODAL_SELECT]: () => {
          props.onClose();
          props.onSend();
        },
      }}
    >
      <ModalHeader
        title={`Send: ${describeAction(props.action)}?`}
        hint="y send · n/esc cancel"
      />
      <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
        <text fg={theme.text} wrapMode="word">
          {actionText(props.action)}
        </text>
      </box>
    </Modal>
  );
}

export function StatusModal(props: {
  onClose: () => void;
  onAdvisor: () => void;
  onPoll: () => void;
}) {
  const theme = useTheme();
  const aug = useAug();
  const rows = () =>
    [
      ["GitHub", aug.status().github],
      ["Slack", aug.status().slack],
      ["Advisor", aug.status().advisor],
    ] as const;
  return (
    <Modal
      size="lg"
      onClose={props.onClose}
      bindings={[
        { key: "a", cmd: "status.advisor", desc: "run the Advisor now" },
        { key: "r", cmd: "status.poll", desc: "check now" },
      ]}
      commands={{
        "status.advisor": () => {
          props.onClose();
          props.onAdvisor();
        },
        "status.poll": () => {
          props.onClose();
          props.onPoll();
        },
      }}
    >
      <ModalHeader title="Connections" hint="r check now · a advisor · esc" />
      <box
        flexDirection="column"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <For each={rows()}>
          {([name, s]) => (
            <box flexDirection="column" marginBottom={1}>
              <text>
                <span
                  style={{ fg: stateColor(theme, s.state), attributes: 1 }}
                >{`${stateGlyph(s.state)} ${name}`}</span>
                <span
                  style={{ fg: theme.textMuted }}
                >{`  ${s.state}${s.at ? ` · ${dayClock(s.at)}` : ""}`}</span>
              </text>
              <text
                fg={theme.textMuted}
                wrapMode="word"
              >{`  ${s.detail}`}</text>
            </box>
          )}
        </For>
        <text
          fg={theme.textMuted}
          wrapMode="word"
        >{`GitHub uses your gh login. Slack needs a user token in SLACK_TOKEN or ${paths.config()}.`}</text>
      </box>
    </Modal>
  );
}

export type { InputRenderable };

// I: what aug knows about a row. j/k pick a line, c copies its value
// (a session id, a thread key, a path).
export function InfoModal(props: {
  title: string;
  sections: InfoSection[];
  onCopied: (label: string, ok: boolean) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const dims = useTerminalDimensions();
  // Each row with its index and the scrollbox line it sits on: every
  // section is a blank line and a title, then its rows.
  const laid = createMemo(() => {
    let i = 0;
    let line = 0;
    return props.sections.map((s) => {
      line += 2;
      return {
        title: s.title,
        rows: s.rows.map((r) => ({ ...r, i: i++, line: line++ })),
      };
    });
  });
  const rows = () => laid().flatMap((s) => s.rows);
  const [selected, setSelected] = createSignal(0);
  let scrollRef: ScrollBoxRenderable | undefined;
  const labelWidth = () =>
    Math.max(4, ...rows().map((r) => r.label.length)) + 2;
  const height = () =>
    Math.max(6, Math.min((rows().at(-1)?.line ?? 0) + 2, dims().height - 10));
  const move = (d: number) => {
    const next = Math.max(0, Math.min(rows().length - 1, selected() + d));
    setSelected(next);
    const line = rows()[next]?.line ?? 0;
    if (!scrollRef) return;
    // Up past the top shows the row's section title too.
    if (line - 1 < scrollRef.scrollTop) scrollRef.scrollTo(Math.max(0, line - 2));
    else if (line >= scrollRef.scrollTop + height())
      scrollRef.scrollTo(line - height() + 1);
  };
  return (
    <Modal
      size="lg"
      onClose={props.onClose}
      bindings={[
        ...modalNavBindings,
        { key: "j", cmd: ModalCommands.MODAL_DOWN, desc: "down" },
        { key: "k", cmd: ModalCommands.MODAL_UP, desc: "up" },
        { key: "c", cmd: "info.copy", desc: "copy the value" },
        { key: "y", cmd: "info.copy", desc: "copy the value" },
      ]}
      commands={{
        [ModalCommands.MODAL_DOWN]: () => move(1),
        [ModalCommands.MODAL_UP]: () => move(-1),
        [ModalCommands.MODAL_SELECT]: () => props.onClose(),
        "info.copy": () => {
          const row = rows()[selected()];
          if (!row) return;
          void copyToClipboard(row.value).then((ok) =>
            props.onCopied(row.label, ok),
          );
        },
      }}
    >
      <ModalHeader title={props.title} hint="j/k · c copy · esc" />
      <scrollbox
        ref={(r: ScrollBoxRenderable) => (scrollRef = r)}
        height={height()}
        paddingLeft={2}
        paddingRight={2}
        stickyScroll={false}
      >
        <For each={laid()}>
          {(s) => (
            <box flexDirection="column" marginTop={1}>
              <text fg={theme.accent} attributes={1}>
                {s.title}
              </text>
              <For each={s.rows}>
                {(row) => {
                  const on = () => row.i === selected();
                  const fg = () =>
                    on() ? contrastingForeground(theme.primary) : undefined;
                  return (
                    <box
                      flexDirection="row"
                      backgroundColor={on() ? theme.primary : undefined}
                    >
                      <text
                        width={labelWidth()}
                        flexShrink={0}
                        fg={fg() ?? theme.textMuted}
                      >
                        {row.label}
                      </text>
                      <text
                        flexGrow={1}
                        fg={fg() ?? theme.text}
                        attributes={on() ? 1 : 0}
                        wrapMode="none"
                      >
                        {row.value.replace(/\s+/g, " ")}
                      </text>
                    </box>
                  );
                }}
              </For>
            </box>
          )}
        </For>
        <box height={1} />
      </scrollbox>
    </Modal>
  );
}
