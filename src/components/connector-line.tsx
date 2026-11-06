// The sidebar's foot: each connection's state in one line, like tilt-tui's
// connection status.

import { For } from "solid-js";
import { useTheme, type Theme, type ThemeColor } from "@andycmaj/opentui-app";
import { useAug } from "../context/aug";
import type { ConnectorState } from "../core/engine";

export function stateGlyph(state: ConnectorState): string {
  return state === "ok"
    ? "●"
    : state === "polling"
      ? "◐"
      : state === "error"
        ? "●"
        : "○";
}

export function stateColor(theme: Theme, state: ConnectorState): ThemeColor {
  return state === "ok"
    ? theme.success
    : state === "polling"
      ? theme.warning
      : state === "error"
        ? theme.error
        : theme.textMuted;
}

export function ConnectorLine() {
  const aug = useAug();
  const theme = useTheme();
  const rows = () => [
    { name: "github", s: aug.status().github },
    { name: "slack", s: aug.status().slack },
  ];
  return (
    <box
      flexDirection="row"
      padding={1}
      paddingLeft={2}
      paddingRight={2}
      flexShrink={0}
      gap={2}
    >
      <For each={rows()}>
        {(r) => (
          <text>
            <span
              style={{ fg: stateColor(theme, r.s.state) }}
            >{`${stateGlyph(r.s.state)} ${r.name}`}</span>
          </text>
        )}
      </For>
    </box>
  );
}
