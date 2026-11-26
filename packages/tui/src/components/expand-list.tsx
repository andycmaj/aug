// The Board's list views (Inbox, Wins, Docs) share this: one wide list,
// a cursor that keeps its row in view, one row open at a time under it,
// headings between groups, a row of filter pills and a search prompt. Each
// view brings its rows' cells and what an open row shows.

import { createEffect, createSignal, For, on, Show, type JSX } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import {
  contrastingForeground,
  useTheme,
  type ThemeColor,
} from "@andycmaj/opentui-app";
import type { Dialogs } from "./actions";
import { PromptModal } from "./modals";

// Where the cursor is and which row is open. Made at module level by each
// view, so both survive a switch of Board tab.
export function listCursor() {
  const [at, setAt] = createSignal(0);
  const [openKey, setOpenKey] = createSignal<string | null>(null);
  return {
    at,
    openKey,
    // The cursor within n rows: a list that shrank keeps it on its last.
    index: (n: number) => Math.min(at(), n - 1),
    // Moving closes the open row: only the one you are on opens.
    move(d: number, n: number) {
      setAt((i) => Math.max(0, Math.min(n - 1, i + d)));
      setOpenKey(null);
    },
    reset() {
      setAt(0);
      setOpenKey(null);
    },
    toggle(key: string) {
      setOpenKey((k) => (k === key ? null : key));
    },
    open(key: string) {
      setOpenKey(key);
    },
  };
}

export type ListCursor = ReturnType<typeof listCursor>;

// The search prompt; / again with a search shown clears it.
export function askSearch(
  dialogs: Dialogs,
  current: string,
  set: (text: string) => void,
  words: { title: string; hint: string },
): void {
  if (current) {
    set("");
    return;
  }
  dialogs.show(() => (
    <PromptModal
      title={words.title}
      hint={words.hint}
      onSubmit={set}
      onClose={dialogs.close}
    />
  ));
}

// Today's time, else the day: a list read top-down by recency.
export function when(iso: string, now: Date): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toTimeString().slice(0, 5)
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export interface Pill {
  word: string;
  count?: number;
  on: boolean;
}

// A row of filter pills, the key that cycles them, and the search shown.
export function FilterPills(props: {
  pills: Pill[];
  hint?: string;
  query?: string;
  children?: JSX.Element;
}) {
  const theme = useTheme();
  return (
    <box flexDirection="row" gap={1} flexShrink={0}>
      <For each={props.pills}>
        {(p) => (
          <text
            fg={p.on ? contrastingForeground(theme.secondary) : theme.textMuted}
            bg={p.on ? theme.secondary : undefined}
          >{` ${p.word}${p.count === undefined ? "" : ` ${p.count}`} `}</text>
        )}
      </For>
      <Show when={props.hint}>
        <text fg={theme.textMuted}>{props.hint}</text>
      </Show>
      {props.children}
      <Show when={props.query}>
        <text fg={theme.accent}>{`/ "${props.query}"`}</text>
      </Show>
    </box>
  );
}

// A heading between groups, or a selectable row.
export type ListEntry<T> =
  | { heading: () => JSX.Element; key: string }
  | { row: T };

// Colors on the cursor row read against its background.
export function selColor(theme: ReturnType<typeof useTheme>, on: boolean) {
  return (c: ThemeColor): ThemeColor =>
    on ? contrastingForeground(theme.primary) : c;
}

export function ExpandList<T>(props: {
  // Unique per view: rows are found by id to scroll them into view.
  id: string;
  entries: ListEntry<T>[];
  rowKey: (row: T) => string;
  selected: string | null;
  openKey: string | null;
  // The row's cells, laid out in a line; `on` is the cursor row.
  row: (row: T, on: boolean) => JSX.Element;
  detail: (row: T) => JSX.Element;
  indent?: number;
  paddingRight?: number;
}) {
  const theme = useTheme();
  let scrollRef: ScrollBoxRenderable | undefined;
  const rowId = (key: string) => `${props.id}-${key}`;

  createEffect(
    on(
      () => [props.selected, props.openKey] as const,
      ([selected]) => {
        if (!selected) {
          return;
        }
        // After layout, so the row (and what opened under it) has its place.
        setTimeout(() => scrollRef?.scrollChildIntoView(rowId(selected)), 0);
      },
    ),
  );

  return (
    <scrollbox
      ref={(r: ScrollBoxRenderable) => (scrollRef = r)}
      flexGrow={1}
      flexBasis={0}
      paddingRight={props.paddingRight}
    >
      <For each={props.entries}>
        {(entry) => {
          if ("heading" in entry) {
            return entry.heading();
          }
          const key = () => props.rowKey(entry.row);
          const sel = () => props.selected === key();
          return (
            <box
              id={rowId(key())}
              flexDirection="column"
              paddingLeft={props.indent}
            >
              <box
                flexDirection="row"
                gap={1}
                backgroundColor={sel() ? theme.primary : undefined}
              >
                {props.row(entry.row, sel())}
              </box>
              <Show when={props.openKey === key()}>
                {props.detail(entry.row)}
              </Show>
            </box>
          );
        }}
      </For>
    </scrollbox>
  );
}
