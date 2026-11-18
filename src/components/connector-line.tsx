// The sidebar's foot: each connection's state in one line, like tilt-tui's
// connection status.

import { For } from "solid-js";
import { useTheme, type Theme, type ThemeColor } from "@andycmaj/opentui-app";
import { useAug } from "../context/aug";
import type { ConnectorState } from "../core/engine";
import { localDay } from "../core/rail";
import { dailyCap, usd } from "../core/spend";

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

// Today's spend on aug's own model calls, against the cap when one is on:
// warning from 80% of it, error once reached (aug's own turns wait then).
export function spendWords(
  spent: number,
  cap: number | null,
): {
  text: string;
  level: "ok" | "near" | "capped";
} {
  if (cap === null) return { text: `${usd(spent)} today`, level: "ok" };
  return {
    text: `${usd(spent)}/${usd(cap)} today`,
    level: spent >= cap ? "capped" : spent >= cap * 0.8 ? "near" : "ok",
  };
}

export function ConnectorLine() {
  const aug = useAug();
  const theme = useTheme();
  // const spend = () =>
  //   spendWords(
  //     aug.spendOn(localDay(aug.now())).cost,
  //     dailyCap(aug.desk.config()),
  //   );
  const rows = () => [
    { name: "github", s: aug.status().github },
    { name: "slack", s: aug.status().slack },
    // Shown once it is turned on.
    ...(aug.status().remote.state === "off"
      ? []
      : [{ name: "remote", s: aug.status().remote }]),
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
      {/* spend section. hide until we have a better design 
      <text
        fg={
          spend().level === "capped"
            ? theme.error
            : spend().level === "near"
              ? theme.warning
              : theme.textMuted
        }
      >
        {spend().text}
      </text> */}
    </box>
  );
}
