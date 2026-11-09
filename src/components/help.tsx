// The ? dialog: every key in the binding table by scope, then the rail's
// color key. The framework's KeyboardHelp and Modal come in fixed widths with
// fixed padding, so this is their shell with more room on every side.

import { createMemo, For, onMount, type JSX } from "solid-js";
import type { Renderable, ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import {
  BaseCommands,
  getModalTheme,
  getScopeBindings,
  mergeByCommand,
  MODAL_PRIORITY,
  ModalCommands,
  ModalHeader,
  navBindings,
  ThemeContext,
  useKeymapTable,
  useScope,
  useTerminalSurface,
  useTheme,
  useThemeName,
  type BindingSpec,
  type Scope,
} from "@andycmaj/opentui-app";
import { RailLegend } from "./rail";

// The framework's md modal is 60; three more cells on each side.
const HELP_WIDTH = 66;
const TERMINAL_MARGIN = 4;
const SECTION_PAD_X = 4;
const KEY_COLUMN = 12;

const CLOSE_BINDINGS: BindingSpec[] = [
  { key: "escape", cmd: ModalCommands.MODAL_CLOSE, desc: "close" },
  { key: "?", cmd: ModalCommands.MODAL_CLOSE, desc: "close" },
  { key: "q", cmd: ModalCommands.MODAL_CLOSE, desc: "close" },
];

export function HelpModal(props: {
  onClose: () => void;
  scopeLabels: Record<string, string>;
  footer: string;
}) {
  const themeName = useThemeName();
  const terminal = useTerminalSurface();
  const dimensions = useTerminalDimensions();
  const modalTheme = createMemo(() => getModalTheme(themeName(), terminal()));
  const width = () =>
    Math.min(HELP_WIDTH, Math.max(20, dimensions().width - TERMINAL_MARGIN));
  let box: Renderable | undefined;
  let scrollRef: ScrollBoxRenderable | undefined;
  const page = () => scrollRef?.viewport?.height ?? 8;

  useScope(
    "modal",
    {
      [ModalCommands.MODAL_CLOSE]: () => props.onClose(),
      [BaseCommands.NAV_DOWN]: () => scrollRef?.scrollBy(1),
      [BaseCommands.NAV_UP]: () => scrollRef?.scrollBy(-1),
      [BaseCommands.NAV_TOP]: () => scrollRef?.scrollTo(0),
      [BaseCommands.NAV_BOTTOM]: () => scrollRef?.scrollTo(999999),
      [BaseCommands.SCROLL_PAGEDOWN]: () => scrollRef?.scrollBy(page()),
      [BaseCommands.SCROLL_PAGEUP]: () => scrollRef?.scrollBy(-page()),
    },
    {
      target: () => box,
      priority: MODAL_PRIORITY,
      bindings: [...CLOSE_BINDINGS, ...(navBindings() as BindingSpec[])],
    },
  );
  onMount(() => box?.focus());

  return (
    <ThemeContext.Provider value={modalTheme()}>
      <box
        ref={(r: Renderable) => (box = r)}
        focusable
        position="absolute"
        top={2}
        left="50%"
        marginLeft={-Math.floor(width() / 2)}
        width={width()}
        paddingTop={1}
        paddingBottom={1}
        flexDirection="column"
        backgroundColor={modalTheme().contentPane}
      >
        <HelpBody
          scopeLabels={props.scopeLabels}
          footer={props.footer}
          scrollRef={(r) => (scrollRef = r)}
        />
      </box>
    </ThemeContext.Provider>
  );
}

// Under the provider, so useTheme answers with the modal's surface.
function HelpBody(props: {
  scopeLabels: Record<string, string>;
  footer: string;
  scrollRef: (r: ScrollBoxRenderable) => void;
}): JSX.Element {
  const theme = useTheme();
  const table = useKeymapTable();
  const groups = createMemo(() => {
    const scopes = Object.keys(table) as Scope[];
    return ["app", ...scopes.filter((s) => s !== "app")]
      .filter((scope) => (table[scope]?.length ?? 0) > 0)
      .map((scope) => ({
        title: props.scopeLabels[scope] ?? scope,
        items: mergeByCommand(getScopeBindings(table, scope)),
      }));
  });

  return (
    <>
      <box paddingLeft={SECTION_PAD_X - 2} paddingRight={SECTION_PAD_X - 2}>
        <ModalHeader title="Keyboard Shortcuts" hint="j/k scroll · esc/q/?" />
      </box>
      <scrollbox
        ref={props.scrollRef}
        maxHeight={16}
        paddingTop={1}
        paddingLeft={SECTION_PAD_X}
        paddingRight={SECTION_PAD_X}
        paddingBottom={1}
      >
        <For each={groups()}>
          {(group) => (
            <box flexDirection="column" marginBottom={1}>
              <text fg={theme.accent} attributes={1}>
                {group.title}
              </text>
              <For each={group.items}>
                {(item) => (
                  <box flexDirection="row">
                    <box width={KEY_COLUMN} flexShrink={0}>
                      <text fg={theme.primary}>{item.keys}</text>
                    </box>
                    <text fg={theme.textMuted}>{item.desc}</text>
                  </box>
                )}
              </For>
            </box>
          )}
        </For>
      </scrollbox>
      <box
        flexDirection="column"
        paddingTop={1}
        paddingLeft={SECTION_PAD_X}
        paddingRight={SECTION_PAD_X}
        paddingBottom={1}
      >
        <RailLegend />
        <text fg={theme.textMuted} marginTop={1}>
          {props.footer}
        </text>
      </box>
    </>
  );
}
