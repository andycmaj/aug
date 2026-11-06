// The Assistant, opened from anywhere with `a`. It already has the item on
// the table and your open work to answer from, and moves things when asked
// ("remind me about this on Monday", "mark it done"). It never sends.

import { createSignal, For, Show, type Accessor, type Setter } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import {
  Modal,
  ModalCommands,
  ModalFilterInput,
  ModalHeader,
  useTheme,
} from "@andycmaj/opentui-app";
import { useAug } from "../context/aug";
import type { AssistantExchange } from "../core/assistant";
import { taskRef } from "../core/store";

export interface AssistantHands {
  open: (taskId: number) => void;
  startCoding: (taskId: number) => void;
}

export function AssistantModal(props: {
  history: Accessor<AssistantExchange[]>;
  setHistory: Setter<AssistantExchange[]>;
  hands: AssistantHands;
  onClose: () => void;
}) {
  const theme = useTheme();
  const aug = useAug();
  const [busy, setBusy] = createSignal(false);
  const [inputKey, setInputKey] = createSignal(0);
  let value = "";
  let scrollRef: ScrollBoxRenderable | undefined;
  const table = () => {
    const item = aug.selected();
    return item?.type === "task" ? item.task.id : null;
  };

  async function submit() {
    const question = value.trim();
    if (!question || busy()) return;
    value = "";
    setInputKey((k) => k + 1);
    const before = props.history();
    props.setHistory([...before, { role: "you", text: question }]);
    setBusy(true);
    try {
      const answer = await aug.engine.askAssistant(
        question,
        table(),
        before.slice(-8),
        props.hands,
      );
      const text = answer.done.length
        ? `${answer.reply}\n(${answer.done.join("; ")})`
        : answer.reply;
      props.setHistory((h) => [...h, { role: "aug", text }]);
    } catch (err) {
      props.setHistory((h) => [
        ...h,
        {
          role: "aug",
          text: `I could not answer: ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    } finally {
      setBusy(false);
      queueMicrotask(() => scrollRef?.scrollTo(scrollRef.scrollHeight));
    }
  }

  return (
    <Modal
      size="lg"
      onClose={props.onClose}
      bindings={[
        { key: "return", cmd: ModalCommands.MODAL_SELECT, desc: "ask" },
      ]}
      commands={{ [ModalCommands.MODAL_SELECT]: () => void submit() }}
    >
      <ModalHeader
        title={`Ask aug${table() ? ` · ${taskRef(table()!)} on the table` : ""}`}
        hint="↵ ask · esc"
      />
      <scrollbox
        ref={(r: ScrollBoxRenderable) => (scrollRef = r)}
        maxHeight={18}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        stickyScroll
        stickyStart="bottom"
      >
        <Show
          when={props.history().length > 0}
          fallback={
            <text fg={theme.textMuted}>
              Ask about the task on the table, or tell me to move things:
              "remind me Monday", "mark it done", "what's waiting on me?"
            </text>
          }
        >
          <For each={props.history()}>
            {(h) => (
              <box flexDirection="column" marginBottom={1}>
                <text fg={h.role === "you" ? theme.primary : theme.accent}>
                  {h.role === "you" ? "you" : "aug"}
                </text>
                <text fg={theme.text} wrapMode="word">
                  {h.text}
                </text>
              </box>
            )}
          </For>
        </Show>
        <Show when={busy()}>
          <text fg={theme.info}>{`${aug.spinner()} thinking...`}</text>
        </Show>
      </scrollbox>
      <Show keyed when={inputKey() + 1}>
        <ModalFilterInput
          onInput={(v) => (value = v)}
          placeholder="Ask aug anything..."
        />
      </Show>
    </Modal>
  );
}
