// A coding agent's live terminal on the Canvas. While the Canvas has focus
// and the session runs, every key goes to the agent except the detach chord;
// detaching moves focus back to the rail and the session keeps running.
// ctrl+t detaches too and moves your own tmux client to the agent's window;
// ctrl+e shows or hides the rail and leaves you attached. ctrl+o (ctrl+[ in
// a kitty terminal) and ctrl+a detach, then go back or Home (shell.tsx).
// A paste goes in too, bracketed when the program asked for it.

import { batch, createEffect, createMemo, onCleanup, Show } from "solid-js";
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
import { LinkMark } from "./link-mark";

// Just the screen: adopts the session's renderable while mounted. The Canvas
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
const CTRL_E = "\x05";
const CTRL_A = "\x01";
const CTRL_O = "\x0f";
// What ctrl+[ is in a legacy terminal: Esc.
const CTRL_BRACKET = "\x1b";

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
  const { openModal, toggleSidebar, setActivePane, state: focus } = useFocus();
  useScope(
    "terminal",
    {
      [Commands.TERMINAL_DETACH]: () => props.onDetach(),
      [Commands.GO_TO]: () => {
        props.onDetach();
        openModal("search");
      },
      // Detach, then decline: the key falls through to the shell's own
      // layer, which goes back (or Home) as from anywhere else.
      [Commands.TERMINAL_BACK]: () => {
        if (!props.onJump) return terminals.write(props.id, CTRL_O);
        props.onDetach();
        return false;
      },
      [Commands.TERMINAL_KITTY_BACK]: () => {
        if (!props.onJump) return terminals.write(props.id, CTRL_BRACKET);
        props.onDetach();
        return false;
      },
      [Commands.GO_HOME]: () => {
        if (!props.onJump) return terminals.write(props.id, CTRL_A);
        props.onDetach();
        return false;
      },
      [Commands.TERMINAL_JUMP]: () => {
        if (!props.onJump) return terminals.write(props.id, CTRL_T);
        props.onDetach();
        props.onJump();
      },
      // onJump marks an agent (it has a window of its own), as for ctrl+t.
      // Showing the rail focuses it, which would detach: put focus back in
      // the same batch, so the agent never loses the keys in between.
      [Commands.SIDEBAR_TOGGLE]: () => {
        if (!props.onJump) return terminals.write(props.id, CTRL_E);
        const pane = focus.activePane;
        batch(() => {
          toggleSidebar();
          setActivePane(pane);
        });
      },
    },
    { target: props.pane },
  );

  // Until its first output the session is still connecting (tmux attach,
  // claude booting): say that, animated, rather than a blank screen.
  const link = () => {
    const s = state();
    return s?.running && s.link.phase !== "connected" ? s.link : null;
  };
  const status = createMemo(() => {
    const s = state();
    if (!s) return { text: "no session", color: theme.textMuted };
    if (!s.running && s.link.phase === "failed")
      return { text: s.link.reason ?? "failed", color: theme.error };
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
        <Show
          when={link()}
          fallback={<text fg={status().color}>{`[${status().text}]`}</text>}
        >
          {(l: () => NonNullable<ReturnType<typeof link>>) => (
            <text>
              <span>[</span>
              <LinkMark link={l()} />
              <span style={{ fg: theme.textMuted }}>
                {l().phase === "failed" ? ` ${l().reason ?? "failed"}` : " connecting"}
              </span>
              <span>]</span>
            </text>
          )}
        </Show>
        <Show when={!running()}>
          <text fg={theme.textMuted}> · s continue · d mark done</text>
        </Show>
      </box>
    </box>
  );
}
