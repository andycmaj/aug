// The one look for a connection (core/link-state.ts): an animated mark
// while connecting, a still one once connected or failed, the reason beside
// a failure. Each mark ticks its own timer only while it is mounted and
// connecting, so a settled or hidden one never redraws. Motion off (config
// `motion`, RIKER_MOTION=0, bun test) draws the still mark instead.

import { createEffect, createSignal, onCleanup, Show, type Accessor } from "solid-js";
import { useTheme } from "@andycmaj/opentui-app";
import {
  LINK_FRAME_MS,
  LINK_FRAMES,
  LinkPhase,
  linkMark,
  type Link,
} from "@riker/core/link-state";
import { useMotion } from "../context/motion";
import { toneColor } from "./ui";

// A frame counter that runs only while `active` and motion is on.
export function useLinkFrame(active: Accessor<boolean>): Accessor<number> {
  const motion = useMotion();
  const [frame, setFrame] = createSignal(0);
  createEffect(() => {
    if (!active() || !motion()) return;
    const timer = setInterval(
      () => setFrame((f) => (f + 1) % LINK_FRAMES.length),
      LINK_FRAME_MS,
    );
    onCleanup(() => clearInterval(timer));
  });
  return frame;
}

// Spans, so it sits inside a caller's <text>: `● github`, `◝ slack`,
// `✕ github · rate limited` (with `reason`).
export function LinkMark(props: {
  link: Link;
  label?: string;
  reason?: boolean;
  bold?: boolean;
}) {
  const theme = useTheme();
  const motion = useMotion();
  const frame = useLinkFrame(() => props.link.phase === LinkPhase.connecting);
  const look = () => linkMark(props.link, frame(), motion());
  return (
    <>
      <span
        style={{ fg: toneColor(theme, look().tone), attributes: props.bold ? 1 : 0 }}
      >{props.label ? `${look().mark} ${props.label}` : look().mark}</span>
      <Show when={props.reason && props.link.phase === LinkPhase.failed && props.link.reason}>
        <span style={{ fg: theme.textMuted }}>{` · ${props.link.reason}`}</span>
      </Show>
    </>
  );
}
