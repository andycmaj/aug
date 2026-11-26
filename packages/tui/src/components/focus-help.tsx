// The ? help: every key that does something where focus is, for the item
// under it, grouped innermost scope first. The same bindings as the footer
// (`useFocusBindings`), with their long descriptions; keys for other panes
// and other rows show when you are there.

import { createMemo, For, Show, type Accessor, type JSX } from "solid-js";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import {
  BaseCommands,
  Modal,
  ModalCommands,
  ModalHeader,
  modalListRows,
  mergeByCommand,
  navBindings,
  useTheme,
  type BindingSpec,
  type HelpRow,
} from "@andycmaj/opentui-app";
import { SCOPE_LABELS, type HelpCtx } from "../keymap";
import { useFocusBindings } from "./footer";

// Rows that say the same thing are one row: the rail's filter digits are
// "1-8", not eight lines.
function mergeByDesc(rows: HelpRow[]): HelpRow[] {
  const out: HelpRow[] = [];
  for (const row of rows) {
    const same = out.find((r) => r.desc === row.desc);
    if (same) {
      same.keys = `${same.keys}/${row.keys}`;
    } else {
      out.push({ ...row });
    }
  }
  return out.map((r) => ({ ...r, keys: digitRange(r.keys) }));
}

function digitRange(keys: string): string {
  const parts = keys.split("/");
  const digits = parts.map(Number);
  const run =
    parts.length > 2 &&
    parts.every((p) => /^[0-9]$/.test(p)) &&
    digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  return run ? `${parts[0]}-${parts[parts.length - 1]}` : keys;
}

// The card's rows besides its scrollbox: padding and header. The list takes
// the rest of the screen, so the frame's bottom edge stays on it.
const OTHER_ROWS = 4;
// Most of the screen, so long descriptions sit on one line.
const WIDTH_SHARE = 0.8;

const CLOSE_BINDINGS: BindingSpec[] = [
  { key: "?", cmd: ModalCommands.MODAL_CLOSE, desc: "close" },
  { key: "q", cmd: ModalCommands.MODAL_CLOSE, desc: "close" },
];

export function FocusHelp(props: {
  ctx: Accessor<HelpCtx>;
  onClose: () => void;
  // Above the keys (the rail's colors) and below them (a closing note).
  header?: JSX.Element;
  footer?: JSX.Element;
}) {
  const theme = useTheme();
  const bindings = useFocusBindings(() => props.ctx());
  const dims = useTerminalDimensions();
  let scrollRef: ScrollBoxRenderable | undefined;

  const groups = createMemo(() => {
    const byScope = new Map<string, ReturnType<typeof bindings>>();
    for (const b of bindings()) {
      const scope = b.scope ?? "app";
      byScope.set(scope, [...(byScope.get(scope) ?? []), b]);
    }
    return [...byScope].map(([scope, list]) => ({
      title: SCOPE_LABELS[scope] ?? scope,
      rows: mergeByDesc(mergeByCommand(list)),
    }));
  });

  const page = () => scrollRef?.viewport?.height ?? 8;

  return (
    <Modal
      width={Math.floor(dims().width * WIDTH_SHARE)}
      padding={{ y: 1 }}
      onClose={props.onClose}
      bindings={[...navBindings(), ...CLOSE_BINDINGS]}
      commands={{
        [BaseCommands.NAV_DOWN]: () => scrollRef?.scrollBy(1),
        [BaseCommands.NAV_UP]: () => scrollRef?.scrollBy(-1),
        [BaseCommands.NAV_TOP]: () => scrollRef?.scrollTo(0),
        [BaseCommands.NAV_BOTTOM]: () => scrollRef?.scrollTo(999999),
        [BaseCommands.SCROLL_PAGEDOWN]: () => scrollRef?.scrollBy(page()),
        [BaseCommands.SCROLL_PAGEUP]: () => scrollRef?.scrollBy(-page()),
      }}
    >
      <ModalHeader title="Keys here" hint="j/k scroll · esc/q/?" paddingX={4} />
      <scrollbox
        ref={(r: ScrollBoxRenderable) => (scrollRef = r)}
        maxHeight={modalListRows(Infinity, OTHER_ROWS, dims().height)}
        paddingLeft={4}
        paddingRight={4}
      >
        <Show when={props.header}>
          <box marginBottom={1}>{props.header}</box>
        </Show>
        <For each={groups()}>
          {(group) => (
            <box flexDirection="column" marginBottom={1}>
              <text fg={theme.accent} attributes={TextAttributes.BOLD}>
                {group.title}
              </text>
              <For each={group.rows}>
                {(row) => (
                  <box flexDirection="row">
                    <box width={12} flexShrink={0}>
                      <text fg={theme.primary}>{row.keys}</text>
                    </box>
                    <text fg={theme.textMuted}>{row.desc}</text>
                  </box>
                )}
              </For>
            </box>
          )}
        </For>
        <text fg={theme.textMuted}>
          Only the keys for where you are and what is under the cursor.
        </text>
        <box paddingTop={1}>{props.footer}</box>
      </scrollbox>
    </Modal>
  );
}
