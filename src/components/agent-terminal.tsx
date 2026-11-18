// A coding agent's live terminal on the table. While the task pane has focus
// and the session runs, every key goes to the agent except the detach chord;
// detaching moves focus back to the rail and the session keeps running.
// ctrl+t detaches too and moves your own tmux client to the agent's window.
// A paste goes in too, bracketed when the program asked for it.

import { createEffect, createMemo, onCleanup, Show } from "solid-js";
import {
  decodePasteBytes,
  type BoxRenderable,
  type PasteEvent,
  type Renderable,
} from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { useFocus, useKeyPassthrough, useScope, useTheme } from "@andycmaj/opentui-app";
import { Commands } from "../commands";
import { useTerminals } from "../context/terminals";
import { encodeKey } from "../terminal/key-encode";

// Just the screen: adopts the session's renderable while mounted. The table
// keeps one mounted as you move between live tasks, so it follows the id;
// adopting once showed the first task's claude while keys went to the next.
export function TermView(props: {
  id: string;
  marginLeft?: number;
  marginRight?: number;
}) {
  const terminals = useTerminals();
  let host: BoxRenderable | undefined;
  createEffect(() => {
    const id = props.id;
    if (!host) return;
    const release = terminals.adopt(id, host);
    onCleanup(release);
  });
  return (
    <box
      ref={(r: BoxRenderable) => (host = r)}
      flexGrow={1}
      flexBasis={0}
      minHeight={0}
      overflow="hidden"
      marginLeft={props.marginLeft ?? 0}
      marginRight={props.marginRight ?? 0}
    />
  );
}

const CTRL_T = "\x14";

function within(node: Renderable | null, target: Renderable): boolean {
  for (let n: Renderable | null = node; n; n = n.parent) {
    if (n === target) return true;
  }
  return false;
}

export function TerminalHost(props: {
  id: string;
  attached: () => boolean;
  pane: () => Renderable | undefined;
  onDetach: () => void;
  // Your tmux client to this terminal's window; none for one that has no
  // window of its own (the editor, ghdash), which get the key instead.
  onJump?: () => void;
}) {
  const terminals = useTerminals();
  const theme = useTheme();
  const state = () => terminals.get(props.id);
  const running = () => state()?.running ?? false;

  useKeyPassthrough(
    "terminal",
    (event) => {
      const bytes = encodeKey(event);
      if (bytes) terminals.write(props.id, bytes);
    },
    { target: props.pane, enabled: () => running() && props.attached() },
  );

  createEffect(() => {
    if (!running() || !props.attached()) return;
    onCleanup(terminals.claimKeys(props.id));
  });

  // The outer terminal sends a paste bracketed, and opentui hands it over as
  // one paste event, never as keys, so the passthrough above never sees it.
  const renderer = useRenderer();
  const onPaste = (event: PasteEvent) => {
    const pane = props.pane();
    if (!pane || !running() || !props.attached()) return;
    if (!within(renderer.currentFocusedRenderable, pane)) return;
    if (event.metadata?.kind === "binary") return;
    event.preventDefault();
    event.stopPropagation();
    terminals.paste(props.id, decodePasteBytes(event.bytes));
  };
  renderer.keyInput.on("paste", onPaste);
  onCleanup(() => renderer.keyInput.off("paste", onPaste));

  // The go-to chord is reserved here like detach, so it gets past the agent:
  // it detaches first, so closing the list (or picking another agent's row)
  // never leaves keys going to a terminal.
  const { openModal } = useFocus();
  useScope(
    "terminal",
    {
      [Commands.TERMINAL_DETACH]: () => props.onDetach(),
      [Commands.GO_TO]: () => {
        props.onDetach();
        openModal("search");
      },
      [Commands.TERMINAL_JUMP]: () => {
        if (!props.onJump) return terminals.write(props.id, CTRL_T);
        props.onDetach();
        props.onJump();
      },
    },
    { target: props.pane },
  );

  const status = createMemo(() => {
    const s = state();
    if (!s) return { text: "no session", color: theme.textMuted };
    if (!s.running)
      return {
        text: `exited ${s.exitCode ?? "?"}`,
        color: s.exitCode === 0 ? theme.textMuted : theme.error,
      };
    return props.attached()
      ? { text: "attached", color: theme.success }
      : { text: "detached · enter attach", color: theme.warning };
  });

  return (
    <box flexDirection="column" flexGrow={1} flexBasis={0}>
      <TermView id={props.id} marginLeft={1} marginRight={1} />
      <box flexShrink={0} paddingLeft={2} flexDirection="row">
        <text fg={status().color}>{`[${status().text}]`}</text>
        <Show when={!running()}>
          <text fg={theme.textMuted}> · s continue · d mark done</text>
        </Show>
      </box>
    </box>
  );
}
