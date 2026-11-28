// Small shared pieces: tone -> theme color, channel words, the inline key hint.

import { For, Show } from "solid-js";
import { MouseButton, TextAttributes, type MouseEvent } from "@opentui/core";
import {
  contrastingForeground,
  useTheme,
  type Theme,
  type ThemeColor,
} from "@andycmaj/opentui-app";
import { useRiker } from "../context/riker";
import { nerdFont } from "@riker/core/glyphs";
import {
  laneMeta,
  type Lane,
  type LaneMeta,
  type Tone,
} from "@riker/core/lanes";
import type { Channel, Priority, ProjectRow } from "@riker/core/types";

// A task in a project names it by its short tmux name: the rail's row and
// the go-to list show the same chip.
export function projectChip(project: ProjectRow | null): string | null {
  const name = project?.tmux_session;
  return name ? `◫ ${name.length > 14 ? `${name.slice(0, 13)}…` : name}` : null;
}

export function toneColor(theme: Theme, tone: Tone): ThemeColor {
  switch (tone) {
    case "warning":
      return theme.warning;
    case "success":
      return theme.success;
    case "info":
      return theme.info;
    case "muted":
      return theme.textMuted;
    case "primary":
      return theme.primary;
    case "error":
      return theme.error;
    case "secondary":
      return theme.secondary;
    case "accent":
      return theme.accent;
    default:
      return theme.text;
  }
}

// A lane's look with the marks this terminal's font can draw (nerdFont in
// config, re-read each call so an edit shows without a restart).
export function useLaneMeta(): (lane: Lane) => LaneMeta {
  const riker = useRiker();
  return (lane) => laneMeta(lane, nerdFont(riker.desk.config()));
}

export function priorityColor(
  theme: Theme,
  priority: Priority,
): ThemeColor | undefined {
  if (priority === "urgent") {
    return theme.error;
  }
  if (priority === "important") {
    return theme.secondary;
  }
  return undefined;
}

export const CHANNEL_WORD: Record<Channel, string> = {
  github: "github",
  slack: "slack",
  owner: "you",
  timer: "timer",
};

export function clock(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function dayClock(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? clock(iso)
    : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock(iso)}`;
}

export function duration(
  fromIso: string,
  toIso: string | null,
  now = new Date(),
): string {
  const ms = (toIso ? Date.parse(toIso) : now.getTime()) - Date.parse(fromIso);
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

// "y send · e edit": the moves a card offers, written where they apply.
export function KeyHints(props: { hints: [string, string][] }) {
  const theme = useTheme();
  return (
    <box flexDirection="row" flexShrink={0}>
      <For each={props.hints}>
        {([key, word], i) => (
          <>
            <Show when={i() > 0}>
              <text fg={theme.textMuted}> · </text>
            </Show>
            <text fg={theme.primary}>{key}</text>
            <text fg={theme.textMuted}> {word}</text>
          </>
        )}
      </For>
    </box>
  );
}

// A pill on a header line: " ready to send ".
export function Badge(props: { text: string; color: ThemeColor }) {
  const bg = () => (typeof props.color === "string" ? props.color : "#808080");
  return (
    <text bg={bg()} fg={contrastingForeground(bg())}>
      {` ${props.text} `}
    </text>
  );
}

// A mode switch drawn like opentui-app's palette footer (Context | All): a
// segmented chip with the active mode on the accent. A click on a segment
// goes to that mode.
export function ModeSegments<M extends string>(props: {
  modes: readonly { mode: M; label: string }[];
  active: M;
  onPick?: (mode: M) => void;
}) {
  const theme = useTheme();
  return (
    <box flexDirection="row" flexShrink={0}>
      <For each={props.modes}>
        {(m) => {
          const on = () => props.active === m.mode;
          return (
            <box
              flexDirection="row"
              onMouseDown={onPress(() => props.onPick?.(m.mode))}
            >
              <text fg={theme.accent}>{on() ? "▌" : " "}</text>
              <text
                fg={
                  on() ? contrastingForeground(theme.accent) : theme.textMuted
                }
                bg={on() ? theme.accent : undefined}
                attributes={on() ? TextAttributes.BOLD : 0}
              >
                {` ${m.label} `}
              </text>
              <text fg={theme.accent}>{on() ? "▐" : " "}</text>
            </box>
          );
        }}
      </For>
    </box>
  );
}

// The key that switches the mode, after its segments.
export function ModeKey(props: { keyName: string }) {
  const theme = useTheme();
  return (
    <box flexDirection="row" flexShrink={0}>
      <text fg={theme.text}>{props.keyName}</text>
    </box>
  );
}

// A modal's mode switch: the segments, then the key that switches.
export function ModeToggle<M extends string>(props: {
  modes: readonly { mode: M; label: string }[];
  active: M;
  keyName: string;
}) {
  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      paddingTop={1}
      paddingLeft={2}
      paddingRight={2}
    >
      <ModeSegments modes={props.modes} active={props.active} />
      <ModeKey keyName={props.keyName} />
    </box>
  );
}

// A left press on a row, a tab or a pill does what its key does. It acts as
// the button goes down, and opentui then focuses the pane under it, so the
// pane and the row change together. Other buttons and the wheel pass by.
// opentui has already started selecting the text under the press, and what
// the press changes (a tab, a filter) would stretch that selection over the
// new layout, so a press that acts is a click, never the start of a
// selection.
export function onPress(fn: () => void) {
  return (event: MouseEvent) => {
    if (event.button !== MouseButton.LEFT) {
      return;
    }
    (event.target ?? event.currentTarget)?.ctx.clearSelection();
    fn();
  };
}
