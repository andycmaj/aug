// The small dialogs: a line of text, a pick from a list, the Send confirm,
// and the connections status. All on the framework's Modal, so they own the
// keyboard while open and hand focus back on close.

import { createMemo, createSignal, For, Show } from "solid-js";
import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import {
  contrastingForeground,
  copyToClipboard,
  Modal,
  ModalCommands,
  ModalFilterInput,
  ModalHeader,
  modalNavBindings,
  useTheme,
  truncate,
  useListNavigation,
  type BindingSpec,
} from "@andycmaj/opentui-app";
import { useRiker } from "../context/riker";
import type { InfoSection } from "@riker/core/info";
import { actionText, describeAction } from "@riker/core/outbound";
import type { RailItem } from "@riker/core/rail";
import { goToList, searchIndex, type SearchHit } from "@riker/core/search";
import { INBOX_KEY } from "./board-tab";
import { taskRef } from "@riker/core/rows";
import { Kind, type DraftAction } from "@riker/core/types";
import { stateColor, stateGlyph } from "./connector-line";
import { dayClock } from "./ui";

export function PromptModal(props: {
  title: string;
  placeholder?: string;
  hint?: string;
  initial?: string;
  onSubmit: (text: string) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  let value = props.initial ?? "";
  return (
    <Modal
      size="lg"
      onClose={props.onClose}
      bindings={[
        { key: "return", cmd: ModalCommands.MODAL_SELECT, desc: "ok" },
      ]}
      commands={{
        [ModalCommands.MODAL_SELECT]: () => {
          if (!value.trim()) return;
          props.onClose();
          props.onSubmit(value.trim());
        },
      }}
    >
      <ModalHeader title={props.title} hint="↵ ok · esc" />
      <Show when={props.hint}>
        <box paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={theme.textMuted} wrapMode="word">
            {props.hint ?? ""}
          </text>
        </box>
      </Show>
      <ModalFilterInput
        onInput={(v) => (value = v)}
        placeholder={props.placeholder}
        initialValue={props.initial}
      />
    </Modal>
  );
}

export interface Choice {
  label: string;
  hint?: string;
  run: () => void;
}

const CHOICES_SHOWN = 14;

export function ChoiceModal(props: {
  title: string;
  hint?: string;
  choices: Choice[];
  // lg for choices with paths in them.
  wide?: boolean;
  onClose: () => void;
}) {
  const theme = useTheme();
  const [selected, setSelected] = createSignal(0);
  const move = (d: number) =>
    setSelected((s) => Math.max(0, Math.min(props.choices.length - 1, s + d)));
  // A long list (every checkout on disk) shows a window that follows the
  // selection, so the modal never grows past the screen.
  const shown = () => {
    const total = props.choices.length;
    if (total <= CHOICES_SHOWN) return { start: 0, end: total };
    const start = Math.max(0, Math.min(total - CHOICES_SHOWN, selected() - Math.floor(CHOICES_SHOWN / 2)));
    return { start, end: start + CHOICES_SHOWN };
  };
  const bindings: BindingSpec[] = [
    ...modalNavBindings,
    { key: "j", cmd: ModalCommands.MODAL_DOWN, desc: "down" },
    { key: "k", cmd: ModalCommands.MODAL_UP, desc: "up" },
  ];
  return (
    <Modal
      size={props.wide ? "lg" : "md"}
      onClose={props.onClose}
      bindings={bindings}
      commands={{
        [ModalCommands.MODAL_DOWN]: () => move(1),
        [ModalCommands.MODAL_UP]: () => move(-1),
        [ModalCommands.MODAL_SELECT]: () => {
          const choice = props.choices[selected()];
          props.onClose();
          choice?.run();
        },
      }}
    >
      <ModalHeader title={props.title} hint="↵ pick · esc" />
      <Show when={props.hint}>
        <box paddingLeft={2} paddingRight={2} paddingTop={1}>
          <text fg={theme.textMuted} wrapMode="word">
            {props.hint ?? ""}
          </text>
        </box>
      </Show>
      <box
        flexDirection="column"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <Show when={shown().start > 0}>
          <text fg={theme.textMuted}>{`  ↑ ${shown().start} more`}</text>
        </Show>
        <For each={props.choices.slice(shown().start, shown().end)}>
          {(choice, at) => {
            const i = () => at() + shown().start;
            const on = () => i() === selected();
            return (
              <box
                flexDirection="row"
                justifyContent="space-between"
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={on() ? theme.primary : undefined}
              >
                <text
                  fg={on() ? contrastingForeground(theme.primary) : theme.text}
                  attributes={on() ? 1 : 0}
                >
                  {choice.label}
                </text>
                <Show when={choice.hint}>
                  <text
                    fg={
                      on()
                        ? contrastingForeground(theme.primary)
                        : theme.textMuted
                    }
                  >
                    {choice.hint ?? ""}
                  </text>
                </Show>
              </box>
            );
          }}
        </For>
        <Show when={shown().end < props.choices.length}>
          <text fg={theme.textMuted}>{`  ↓ ${props.choices.length - shown().end} more`}</text>
        </Show>
      </box>
    </Modal>
  );
}

// Nothing goes out until this second yes: what, to whom, the exact words.
export function ConfirmSendModal(props: {
  action: DraftAction;
  onSend: () => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  return (
    <Modal
      size="lg"
      onClose={props.onClose}
      bindings={[
        { key: "y", cmd: ModalCommands.MODAL_SELECT, desc: "send" },
        { key: "return", cmd: ModalCommands.MODAL_SELECT, desc: "send" },
        { key: "n", cmd: ModalCommands.MODAL_CLOSE, desc: "cancel" },
      ]}
      commands={{
        [ModalCommands.MODAL_SELECT]: () => {
          props.onClose();
          props.onSend();
        },
      }}
    >
      <ModalHeader
        title={`Send: ${describeAction(props.action)}?`}
        hint="y send · n/esc cancel"
      />
      <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
        <text fg={theme.text} wrapMode="word">
          {actionText(props.action)}
        </text>
      </box>
    </Modal>
  );
}

export function StatusModal(props: {
  onClose: () => void;
  onAdvisor: () => void;
  onPoll: () => void;
}) {
  const theme = useTheme();
  const riker = useRiker();
  const off = { state: "off", detail: "not started", at: null } as const;
  const rows = () => [
    ...riker.engine
      .connections()
      .map((c) => [c.label, riker.status()[c.name] ?? off] as const),
    ["Advisor", riker.status().advisor] as const,
  ];
  const hints = () =>
    riker.engine
      .connections()
      .flatMap((c) => (c.hint ? [c.hint] : []))
      .join(" ");
  return (
    <Modal
      size="lg"
      onClose={props.onClose}
      bindings={[
        { key: "a", cmd: "status.advisor", desc: "run the Advisor now" },
        { key: "r", cmd: "status.poll", desc: "check now" },
      ]}
      commands={{
        "status.advisor": () => {
          props.onClose();
          props.onAdvisor();
        },
        "status.poll": () => {
          props.onClose();
          props.onPoll();
        },
      }}
    >
      <ModalHeader title="Connections" hint="r check now · a advisor · esc" />
      <box
        flexDirection="column"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
      >
        <For each={rows()}>
          {([name, s]) => (
            <box flexDirection="column" marginBottom={1}>
              <text>
                <span
                  style={{ fg: stateColor(theme, s.state), attributes: 1 }}
                >{`${stateGlyph(s.state)} ${name}`}</span>
                <span
                  style={{ fg: theme.textMuted }}
                >{`  ${s.state}${s.at ? ` · ${dayClock(s.at)}` : ""}`}</span>
              </text>
              <text
                fg={theme.textMuted}
                wrapMode="word"
              >{`  ${s.detail}`}</text>
            </box>
          )}
        </For>
        <text
          fg={theme.textMuted}
          wrapMode="word"
        >{hints()}</text>
      </box>
    </Modal>
  );
}

export type { InputRenderable };

// I: what Riker knows about a row. j/k pick a line, c copies its value
// (a session id, a thread key, a path), enter opens a link line.
export function InfoModal(props: {
  title: string;
  sections: InfoSection[];
  onCopied: (label: string, ok: boolean) => void;
  onOpen: (target: string) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const dims = useTerminalDimensions();
  // Each row with its index and the scrollbox line it sits on: every
  // section is a blank line and a title, then its rows.
  const laid = createMemo(() => {
    let i = 0;
    let line = 0;
    return props.sections.map((s) => {
      line += 2;
      return {
        title: s.title,
        rows: s.rows.map((r) => ({ ...r, i: i++, line: line++ })),
      };
    });
  });
  const rows = () => laid().flatMap((s) => s.rows);
  const [selected, setSelected] = createSignal(0);
  let scrollRef: ScrollBoxRenderable | undefined;
  const labelWidth = () =>
    Math.max(4, ...rows().map((r) => r.label.length)) + 2;
  const height = () =>
    Math.max(6, Math.min((rows().at(-1)?.line ?? 0) + 2, dims().height - 10));
  const move = (d: number) => {
    const next = Math.max(0, Math.min(rows().length - 1, selected() + d));
    setSelected(next);
    const line = rows()[next]?.line ?? 0;
    if (!scrollRef) return;
    // Up past the top shows the row's section title too.
    if (line - 1 < scrollRef.scrollTop) scrollRef.scrollTo(Math.max(0, line - 2));
    else if (line >= scrollRef.scrollTop + height())
      scrollRef.scrollTo(line - height() + 1);
  };
  return (
    <Modal
      size="lg"
      onClose={props.onClose}
      bindings={[
        ...modalNavBindings,
        { key: "j", cmd: ModalCommands.MODAL_DOWN, desc: "down" },
        { key: "k", cmd: ModalCommands.MODAL_UP, desc: "up" },
        { key: "c", cmd: "info.copy", desc: "copy the value" },
        { key: "y", cmd: "info.copy", desc: "copy the value" },
      ]}
      commands={{
        [ModalCommands.MODAL_DOWN]: () => move(1),
        [ModalCommands.MODAL_UP]: () => move(-1),
        [ModalCommands.MODAL_SELECT]: () => {
          const target = rows()[selected()]?.open;
          if (target) props.onOpen(target);
          else props.onClose();
        },
        "info.copy": () => {
          const row = rows()[selected()];
          if (!row) return;
          void copyToClipboard(row.value).then((ok) =>
            props.onCopied(row.label, ok),
          );
        },
      }}
    >
      <ModalHeader
        title={props.title}
        hint={
          rows().some((r) => r.open)
            ? "j/k · enter open link · c copy · esc"
            : "j/k · c copy · esc"
        }
      />
      <scrollbox
        ref={(r: ScrollBoxRenderable) => (scrollRef = r)}
        height={height()}
        paddingLeft={2}
        paddingRight={2}
        stickyScroll={false}
      >
        <For each={laid()}>
          {(s) => (
            <box flexDirection="column" marginTop={1}>
              <text fg={theme.accent} attributes={1}>
                {s.title}
              </text>
              <For each={s.rows}>
                {(row) => {
                  const on = () => row.i === selected();
                  const fg = () =>
                    on() ? contrastingForeground(theme.primary) : undefined;
                  return (
                    <box
                      flexDirection="row"
                      backgroundColor={on() ? theme.primary : undefined}
                    >
                      <text
                        width={labelWidth()}
                        flexShrink={0}
                        fg={fg() ?? theme.textMuted}
                      >
                        {row.label}
                      </text>
                      <text
                        flexGrow={1}
                        fg={fg() ?? theme.text}
                        attributes={on() ? 1 : 0}
                        wrapMode="none"
                      >
                        {row.value.replace(/\s+/g, " ")}
                      </text>
                    </box>
                  );
                }}
              </For>
            </box>
          )}
        </For>
        <box height={1} />
      </scrollbox>
    </Modal>
  );
}

const SEARCH_ROWS = 14;
// Rows the go-to modal takes above and below its list (offset, frame, header,
// filter), so a short terminal shrinks the list instead of the frame running
// off the bottom.
const SEARCH_CHROME_ROWS = 10;
const SEARCH_HINT_MAX = 48;

function searchTag(item: RailItem): string {
  switch (item.type) {
    case "task":
      return item.task.kind === Kind.home ? "home" : taskRef(item.task.id);
    case "project":
      return "project";
  }
}

// / and the go-to chord: every row on the rail, folded and For later ones
// too, the ones seen lately first, then done and dropped work that matches
// what is typed. Picking one selects it.
export function SearchModal(props: {
  onPick: (key: string) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const riker = useRiker();
  const dims = useTerminalDimensions();
  let scrollRef: ScrollBoxRenderable | undefined;
  // Read once: list navigation takes a fixed page size.
  const listRows = Math.max(
    4,
    Math.min(SEARCH_ROWS, dims().height - SEARCH_CHROME_ROWS),
  );
  // Re-read only when the store moves, not on every keystroke.
  const docs = createMemo(() => {
    const sections = riker.rail();
    const ids = sections
      .flatMap((s) => s.items)
      .flatMap((i) => (i.type === "task" ? [i.task.id] : []));
    return searchIndex(sections, riker.searchSources(ids), riker.closedTasks());
  });
  const nav = useListNavigation({
    itemCount: () => hits().length,
    scrollRef: () => scrollRef,
    // The scrollbox's bottom padding takes one of its rows.
    visibleItems: listRows - 1,
  });
  // Read once: what was recent when the list opened.
  const recentKeys = riker.recent().map((i) => i.key);
  // The Inbox is no rail row, but the go-to list reaches it too: first when
  // nothing is typed, or when what is typed starts its name.
  const showInbox = () => "inbox".startsWith(nav.filter().trim().toLowerCase());
  const hits = createMemo((): (SearchHit | null)[] => [
    ...(showInbox() ? [null] : []),
    ...goToList(docs(), nav.filter(), recentKeys),
  ]);
  const pick = (hit: SearchHit | null | undefined) => {
    if (hit === undefined) return false;
    props.onClose();
    props.onPick(hit ? hit.item.key : INBOX_KEY);
  };
  return (
    <Modal
      size="lg"
      onClose={props.onClose}
      bindings={modalNavBindings}
      commands={{
        [ModalCommands.MODAL_DOWN]: () => nav.move(1),
        [ModalCommands.MODAL_UP]: () => nav.move(-1),
        [ModalCommands.MODAL_SELECT]: () => {
          pick(hits()[nav.selected()]);
        },
      }}
    >
      <ModalHeader title="Go to" hint="↵ open · esc" />
      <ModalFilterInput
        onInput={nav.setFilter}
        placeholder="words, RIKER-23, #412, @someone (Slack or GitHub)"
      />
      <scrollbox
        ref={(r: ScrollBoxRenderable) => (scrollRef = r)}
        maxHeight={listRows}
        paddingLeft={2}
        paddingRight={2}
        paddingBottom={1}
      >
        <Show
          when={hits().length > 0}
          fallback={
            <text fg={theme.textMuted}>Nothing matches</text>
          }
        >
          <For each={hits()}>
            {(hit, i) => {
              const on = () => i() === nav.selected();
              const fg = () =>
                on() ? contrastingForeground(theme.primary) : undefined;
              if (!hit)
                return (
                  <box
                    flexDirection="row"
                    gap={1}
                    paddingLeft={1}
                    paddingRight={1}
                    backgroundColor={on() ? theme.primary : undefined}
                  >
                    <text width={8} flexShrink={0} fg={fg() ?? theme.accent}>
                      board
                    </text>
                    <box flexGrow={1} flexShrink={1} overflow="hidden">
                      <text wrapMode="none" fg={fg() ?? theme.text} attributes={on() ? 1 : 0}>
                        Inbox
                      </text>
                    </box>
                    <text flexShrink={0} fg={fg() ?? theme.textMuted}>
                      {riker.inboxCount() ? `${riker.inboxCount()} need you` : "messages and ideas"}
                    </text>
                  </box>
                );
              return (
                <box
                  flexDirection="row"
                  gap={1}
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={on() ? theme.primary : undefined}
                >
                  <text width={8} flexShrink={0} fg={fg() ?? theme.accent}>
                    {searchTag(hit.item)}
                  </text>
                  {/* A long title is cut here, not over the hint. */}
                  <box flexGrow={1} flexShrink={1} overflow="hidden">
                    <text
                      wrapMode="none"
                      fg={fg() ?? theme.text}
                      attributes={on() ? 1 : 0}
                    >
                      {hit.title}
                    </text>
                  </box>
                  <text flexShrink={0} fg={fg() ?? theme.textMuted}>
                    {truncate(
                      hit.why
                        ? `${hit.why} · ${hit.section}`
                        : hit.recent
                          ? `recent · ${hit.section}`
                          : hit.section,
                      SEARCH_HINT_MAX,
                    )}
                  </text>
                </box>
              );
            }}
          </For>
        </Show>
      </scrollbox>
    </Modal>
  );
}
