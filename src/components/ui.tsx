// Small shared pieces: tone -> theme color, channel words, the inline key hint.

import { For, Show } from "solid-js";
import {
  contrastingForeground,
  useTheme,
  type Theme,
  type ThemeColor,
} from "@andycmaj/opentui-app";
import type { Tone } from "../core/lanes";
import type { Channel, Priority } from "../core/types";

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
    default:
      return theme.text;
  }
}

export function priorityColor(
  theme: Theme,
  priority: Priority,
): ThemeColor | undefined {
  if (priority === "urgent") return theme.error;
  if (priority === "important") return theme.secondary;
  return undefined;
}

export const CHANNEL_WORD: Record<Channel, string> = {
  github: "github",
  slack: "slack",
  owner: "you",
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
  if (s < 60) return `${s}s`;
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
