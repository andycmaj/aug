// The small dialogs: a line of text, a pick from a list, the Send confirm,
// and the connections status. All on the framework's Modal, so they own the
// keyboard while open and hand focus back on close.

import { createMemo, createSignal, For, Show, type Accessor } from "solid-js";
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
  Markdown,
  useTheme,
  truncate,
  useListNavigation,
  type BindingSpec,
} from "@andycmaj/opentui-app";
import { useRiker } from "../context/riker";
import type { InfoSection } from "@riker/core/info";
import type { RailItem } from "@riker/core/rail";
import { goToList, searchIndex, type SearchHit } from "@riker/core/search";
import { INBOX_KEY } from "./board-tab";
import { taskRef, type DocLink } from "@riker/core/rows";
import { Kind, type DraftAction, type TurnRow } from "@riker/core/types";
import { ActionTurn } from "./chat-turn";
import { stateColor, stateGlyph } from "./connector-line";
import { dayClock, ModeToggle } from "./ui";

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
  const riker = useRiker();
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
        title={`Send: ${riker.desk.drafts.describe(props.action)}?`}
        hint="y send · n/esc cancel"
      />
      <box paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
        <text fg={theme.text} wrapMode="word">
          {riker.desk.drafts.text(props.action)}
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

// A task action's answer, read over the Canvas: a coding task with a live
// agent shows the agent there, not the chat its answer is a turn in. Read
// from the turn as it is now, so one still running fills in.
export function ActionAnswerModal(props: {
  taskId: number;
  turnId: number;
  onCopied: (ok: boolean) => void;
  onClose: () => void;
}) {
  const riker = useRiker();
  const dims = useTerminalDimensions();
  const turn = createMemo(() => riker.turns(props.taskId).find((t) => t.id === props.turnId));
  const width = () => Math.min(100, dims().width - 8);
  const height = () => Math.max(6, dims().height - 12);
  let scrollRef: ScrollBoxRenderable | undefined;
  const scroll = (by: number) => scrollRef?.scrollBy(by);
  return (
    <Modal
      size="lg"
      onClose={props.onClose}
      bindings={[
        ...modalNavBindings,
        { key: "j", cmd: ModalCommands.MODAL_DOWN, desc: "down" },
        { key: "k", cmd: ModalCommands.MODAL_UP, desc: "up" },
        { key: "space", cmd: "answer.page", desc: "page down" },
        { key: "c", cmd: "answer.copy", desc: "copy the answer" },
        { key: "y", cmd: "answer.copy", desc: "copy the answer" },
      ]}
      commands={{
        [ModalCommands.MODAL_DOWN]: () => scroll(2),
        [ModalCommands.MODAL_UP]: () => scroll(-2),
        [ModalCommands.MODAL_SELECT]: () => props.onClose(),
        "answer.page": () => scrollRef?.scrollBy(0.8, "viewport"),
        "answer.copy": () => {
          const body = turn()?.body;
          if (body) void copyToClipboard(body).then(props.onCopied);
        },
      }}
    >
      <ModalHeader
        title={`${taskRef(props.taskId)} ${riker.task(props.taskId)?.title ?? ""}`.trim()}
        hint="j/k scroll · space page · c copy · esc"
      />
      <scrollbox
        ref={(r: ScrollBoxRenderable) => (scrollRef = r)}
        height={height()}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        stickyScroll={false}
      >
        <Show
          when={turn()}
          fallback={<text fg={useTheme().textMuted}>That answer is gone.</text>}
        >
          {(t: Accessor<TurnRow>) => <ActionTurn turn={t()} width={width()} />}
        </Show>
      </scrollbox>
    </Modal>
  );
}

// A story or a journal, read as markdown over the Canvas. text is read
// each time it renders, so a write-up landing while it is open shows. e
// hands it to $EDITOR (closing this first); empty says what would fill it.
export function ReaderModal(props: {
  title: string;
  // A muted line over the text: when it was written, and by whom.
  note?: string;
  // Listed over the text, 1-9 opening each.
  links?: () => DocLink[];
  onOpen?: (url: string) => void;
  text: () => string | null;
  empty: string;
  onEdit?: () => void;
  onCopied: (ok: boolean) => void;
  onClose: () => void;
}) {
  const theme = useTheme();
  const dims = useTerminalDimensions();
  const width = () => Math.min(100, dims().width - 8);
  const height = () => Math.max(6, dims().height - 12);
  let scrollRef: ScrollBoxRenderable | undefined;
  const scroll = (by: number) => scrollRef?.scrollBy(by);
  const links = () => props.links?.() ?? [];
  const keys = () =>
    ["j/k", "space page", links().length ? `1-${Math.min(9, links().length)} open` : null, "c copy", props.onEdit ? "e edit" : null, "esc"]
      .filter(Boolean)
      .join(" · ");
  const openNth = (n: number) => {
    const link = links()[n - 1];
    if (!link || !props.onOpen) return false;
    props.onOpen(link.url);
  };
  const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  return (
    <Modal
      size="lg"
      onClose={props.onClose}
      bindings={[
        ...modalNavBindings,
        { key: "j", cmd: ModalCommands.MODAL_DOWN, desc: "down" },
        { key: "k", cmd: ModalCommands.MODAL_UP, desc: "up" },
        { key: "space", cmd: "reader.page", desc: "page down" },
        { key: "c", cmd: "reader.copy", desc: "copy it" },
        { key: "y", cmd: "reader.copy", desc: "copy it" },
        { key: "e", cmd: "reader.edit", desc: "open it in $EDITOR" },
        ...DIGITS.map((n) => ({ key: String(n), cmd: `reader.open.${n}`, desc: `open link ${n}` })),
      ]}
      commands={{
        [ModalCommands.MODAL_DOWN]: () => scroll(2),
        [ModalCommands.MODAL_UP]: () => scroll(-2),
        [ModalCommands.MODAL_SELECT]: () => props.onClose(),
        "reader.page": () => scrollRef?.scrollBy(0.8, "viewport"),
        "reader.copy": () => {
          const text = props.text();
          if (text) void copyToClipboard(text).then(props.onCopied);
        },
        "reader.edit": () => {
          if (!props.onEdit) return false;
          props.onEdit();
        },
        ...Object.fromEntries(DIGITS.map((n) => [`reader.open.${n}`, () => openNth(n)])),
      }}
    >
      <ModalHeader title={props.title} hint={keys()} />
      <scrollbox
        ref={(r: ScrollBoxRenderable) => (scrollRef = r)}
        height={height()}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        stickyScroll={false}
      >
        <Show when={props.note}>
          <text fg={theme.textMuted} marginBottom={1}>
            {props.note ?? ""}
          </text>
        </Show>
        <Show when={links().length > 0}>
          <box flexDirection="column" marginBottom={1}>
            <For each={links()}>
              {(link, i) => (
                <text wrapMode="none">
                  <span style={{ fg: i() < 9 ? theme.primary : theme.textMuted }}>{`${i() < 9 ? i() + 1 : "·"}  `}</span>
                  <span style={{ fg: theme.text }}>{truncate(link.label, Math.max(10, Math.floor(width() / 2)))}</span>
                  <span style={{ fg: theme.textMuted }}>{`  ${truncate(link.url, Math.max(10, width() - link.label.length - 12))}`}</span>
                </text>
              )}
            </For>
          </box>
        </Show>
        <Show
          when={props.text()?.trim()}
          fallback={<text fg={theme.textMuted} wrapMode="word">{props.empty}</text>}
        >
          <Markdown text={props.text() ?? ""} width={width() - 4} />
        </Show>
        <box height={1} />
      </scrollbox>
    </Modal>
  );
}

const SEARCH_ROWS = 14;
// Rows the go-to modal takes above and below its list (offset, frame, header,
// filter, the Open | All toggle), so a short terminal shrinks the list instead
// of the frame running off the bottom.
const SEARCH_CHROME_ROWS = 11;
const SEARCH_HINT_MAX = 48;
const SEARCH_TOGGLE_DONE = "search.toggleDone";
const SEARCH_MODES = [
  { mode: "open", label: "Open" },
  { mode: "all", label: "All" },
] as const;
// Fits a task ref (RIKER-0023) whole.
const SEARCH_TAG_WIDTH = 10;

function searchTag(item: RailItem): string {
  switch (item.type) {
    case "task":
      return item.task.kind === Kind.home ? "home" : taskRef(item.task.id);
    case "project":
      return "project";
  }
}

// / and the go-to chord: every row on the rail, folded and For later ones
// too, the ones seen lately first. Done and dropped work joins it while tab
// has it shown (typing is the filter's, so the toggle is a key that types
// nothing). Picking one selects it.
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
    visibleItems: listRows,
  });
  // Read once: what was recent when the list opened.
  const recentKeys = riker.recent().map((i) => i.key);
  // The Inbox is no rail row, but the go-to list reaches it too: first when
  // nothing is typed, or when what is typed starts its name.
  const showInbox = () => "inbox".startsWith(nav.filter().trim().toLowerCase());
  const hits = createMemo((): (SearchHit | null)[] => [
    ...(showInbox() ? [null] : []),
    ...goToList(docs(), nav.filter(), recentKeys, riker.searchShowsDone()),
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
      bindings={[
        ...modalNavBindings,
        { key: "tab", cmd: SEARCH_TOGGLE_DONE, desc: "show or hide done" },
      ]}
      commands={{
        [ModalCommands.MODAL_DOWN]: () => nav.move(1),
        [ModalCommands.MODAL_UP]: () => nav.move(-1),
        [ModalCommands.MODAL_SELECT]: () => {
          pick(hits()[nav.selected()]);
        },
        [SEARCH_TOGGLE_DONE]: () => {
          riker.setSearchShowsDone(!riker.searchShowsDone());
          nav.setSelected(0);
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
                    <text width={SEARCH_TAG_WIDTH} flexShrink={0} fg={fg() ?? theme.accent}>
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
                  <text width={SEARCH_TAG_WIDTH} flexShrink={0} fg={fg() ?? theme.accent}>
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
      <ModeToggle
        modes={SEARCH_MODES}
        active={riker.searchShowsDone() ? "all" : "open"}
        keyName="tab"
      />
    </Modal>
  );
}
