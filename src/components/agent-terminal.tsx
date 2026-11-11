// A coding agent's live terminal on the table. While the task pane has focus
// and the session runs, every key goes to the agent except the detach chord;
// detaching moves focus back to the rail and the session keeps running.

import { createEffect, createMemo, onCleanup, Show } from "solid-js";
import type { BoxRenderable, Renderable } from "@opentui/core";
import { useKeyPassthrough, useScope, useTheme } from "@andycmaj/opentui-app";
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

export function TerminalHost(props: {
  id: string;
  attached: () => boolean;
  pane: () => Renderable | undefined;
  onDetach: () => void;
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

  useScope(
    "terminal",
    { [Commands.TERMINAL_DETACH]: () => props.onDetach() },
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
      ? { text: "attached · ^] detach", color: theme.success }
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
