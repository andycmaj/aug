// Key hints for the focused pane: the bindings reachable from it that apply
// to the item under it (`helpBindings`), plus the view switch on the right.

import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
  type Accessor,
} from "solid-js";
import type { TerminalCapabilities } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import {
  getHelpItems,
  useReachableBindings,
  useTheme,
  type HelpBinding,
  type HelpItem,
  type HelpItemOptions,
} from "@andycmaj/opentui-app";
import { useRiker, ViewMode } from "../context/riker";
import { helpBindings, type HelpCtx } from "../keymap";

// "escape" reads better as "esc" in a hint line.
const KEY_WORDS: Record<string, string> = { escape: "esc" };
export const keyLabel = (keys: string) => KEY_WORDS[keys] ?? keys;

// Whether the terminal sends ctrl+[ apart from Esc: only one speaking the
// kitty keyboard protocol to Riker does (tmux folds the two into Esc). The
// answer to opentui's query comes after start.
function useKittyKeys(): Accessor<boolean> {
  const renderer = useRenderer();
  const [kitty, setKitty] = createSignal(
    renderer.capabilities?.kitty_keyboard ?? false,
  );
  const update = (caps: TerminalCapabilities | null) =>
    setKitty(caps?.kitty_keyboard ?? false);
  renderer.on("capabilities", update);
  onCleanup(() => renderer.off("capabilities", update));
  return kitty;
}

// The reachable bindings that apply here, recomputed on focus, keymap and
// context changes. The footer and the ? help both read this.
export function useFocusBindings(
  ctx: Accessor<HelpCtx>,
): Accessor<HelpBinding[]> {
  const reachable = useReachableBindings();
  const kittyKeys = useKittyKeys();
  return () =>
    helpBindings(reachable(), { ...ctx(), kittyKeys: kittyKeys() }).map((b) => ({
      ...b,
      keys: keyLabel(b.keys),
    }));
}

// Drop hints from the end until the line fits, but keep "? help" last: it is
// how to see the rest.
export function fitHints(items: HelpItem[], width: number): HelpItem[] {
  const cost = (item: HelpItem) => item.keys.length + item.text.length + 4;
  const help = items.find((item) => item.text === "help");
  let budget = width - (help ? cost(help) : 0);
  const out: HelpItem[] = [];
  for (const item of items) {
    if (item === help) continue;
    if (budget - cost(item) < 0) break;
    budget -= cost(item);
    out.push(item);
  }
  return help ? [...out, help] : out;
}

export function RikerFooter(props: {
  ctx: Accessor<HelpCtx>;
  left?: number;
  options?: HelpItemOptions;
}) {
  const theme = useTheme();
  const riker = useRiker();
  const dims = useTerminalDimensions();
  const bindings = useFocusBindings(() => props.ctx());
  const visible = createMemo(() =>
    fitHints(
      getHelpItems(bindings(), props.options),
      dims().width - (props.left ?? 0) - 22,
    ),
  );

  return (
    <box
      paddingLeft={2}
      paddingRight={2}
      flexShrink={0}
      flexDirection="row"
      justifyContent="space-between"
    >
      <box flexDirection="row" flexShrink={1}>
        <For each={visible()}>
          {(item, index) => (
            <>
              <Show when={index() > 0}>
                <text fg={theme.textMuted}> · </text>
              </Show>
              <text fg={theme.primary}>{item.keys}</text>
              <text fg={theme.textMuted}> {item.text}</text>
            </>
          )}
        </For>
      </box>
      <text flexShrink={0}>
        <span
          style={{
            fg: riker.mode() === ViewMode.chat ? theme.primary : theme.textMuted,
            attributes: riker.mode() === ViewMode.chat ? 1 : 0,
          }}
        >
          chat
        </span>
        <span style={{ fg: theme.textMuted }}> | </span>
        <span
          style={{
            fg: riker.mode() === ViewMode.board ? theme.primary : theme.textMuted,
            attributes: riker.mode() === ViewMode.board ? 1 : 0,
          }}
        >
          board
        </span>
        <span style={{ fg: theme.textMuted }}> (v)</span>
      </text>
    </box>
  );
}
