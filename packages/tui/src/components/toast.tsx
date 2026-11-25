// The toasts, top-center over everything: the newest error (wrapped, never
// cut) with how to dismiss it and how many wait under it, then the passing
// info toast. Esc dismisses an error through a layer that exists only while
// one is up, above every pane and modal, so that Esc does nothing else. An
// attached agent's passthrough runs ahead of every layer and still gets Esc;
// the hint says to detach first.

import { Show, type Accessor } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import {
  contrastingForeground,
  MODAL_PRIORITY,
  useScope,
  useTheme,
} from "@andycmaj/opentui-app";
import { Commands } from "../commands";
import { useTerminals } from "../context/terminals";
import { useToast, type ErrorToast } from "../context/toast";

const INFO_WIDTH = 30;
const ERROR_WIDTH = 72;
// Above a modal's layer: an error over the palette goes before the palette.
export const TOAST_PRIORITY = MODAL_PRIORITY + 100;

function DismissKey() {
  const toasts = useToast();
  useScope(
    "toast",
    { [Commands.TOAST_DISMISS]: () => toasts.dismissError() },
    { priority: TOAST_PRIORITY },
  );
  return null;
}

export function errorHint(
  error: ErrorToast,
  waiting: number,
  attached: boolean,
): string {
  const parts = [attached ? "ctrl+] then esc dismiss" : "esc dismiss"];
  if (error.times > 1) parts.unshift(`×${error.times}`);
  if (waiting > 0) parts.push(`${waiting} more`);
  return parts.join(" · ");
}

export function Toast() {
  const theme = useTheme();
  const toasts = useToast();
  const terminals = useTerminals();
  const dims = useTerminalDimensions();
  const width = () => Math.max(20, Math.min(ERROR_WIDTH, dims().width - 4));
  const errorBg = () => theme.error ?? theme.primary ?? "#e06c75";
  const infoBg = () => theme.primary ?? "#fab283";
  const newest = () => toasts.errors().at(-1) ?? null;

  return (
    <>
      <Show when={newest()}>
        <DismissKey />
      </Show>
      <Show when={newest() || toasts.info()}>
        <box
          position="absolute"
          top={1}
          left="50%"
          marginLeft={-Math.floor(width() / 2)}
          width={width()}
          flexDirection="column"
          alignItems="center"
          gap={1}
        >
          <Show when={newest()}>
            {(error: Accessor<ErrorToast>) => (
              <box
                width={width()}
                padding={1}
                flexDirection="column"
                backgroundColor={errorBg()}
              >
                <text wrapMode="word" fg={contrastingForeground(errorBg())}>
                  {error().message}
                </text>
                <text fg={contrastingForeground(errorBg())}>
                  {errorHint(
                    error(),
                    toasts.errors().length - 1,
                    terminals.attached() !== null,
                  )}
                </text>
              </box>
            )}
          </Show>
          <Show when={toasts.info()}>
            {(info: Accessor<{ message: string }>) => (
              <box width={INFO_WIDTH} padding={1} backgroundColor={infoBg()}>
                <text wrapMode="word" fg={contrastingForeground(infoBg())}>
                  {info().message}
                </text>
              </box>
            )}
          </Show>
        </box>
      </Show>
    </>
  );
}
