// Context-aware key hints for the active pane, filtered to the moves that
// apply to the item on the table, plus the view switch on the right.

import { createMemo, For, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { useHelpItems, useTheme } from "@andycmaj/opentui-app";
import { useAug, ViewMode } from "../context/aug";
import type { HelpCtx } from "../keymap";

export function AugFooter(props: { ctx: () => HelpCtx; left?: number }) {
  const theme = useTheme();
  const aug = useAug();
  const dims = useTerminalDimensions();
  const items = useHelpItems<HelpCtx>(props.ctx);
  const visible = createMemo(() => {
    // Drop hints from the end until the line fits beside the view switch.
    let budget = dims().width - (props.left ?? 0) - 22;
    const out = [];
    for (const item of items()) {
      const w = item.keys.length + item.text.length + 4;
      if (budget - w < 0) break;
      budget -= w;
      out.push(item);
    }
    return out;
  });

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
            fg: aug.mode() === ViewMode.chat ? theme.primary : theme.textMuted,
            attributes: aug.mode() === ViewMode.chat ? 1 : 0,
          }}
        >
          chat
        </span>
        <span style={{ fg: theme.textMuted }}> | </span>
        <span
          style={{
            fg: aug.mode() === ViewMode.board ? theme.primary : theme.textMuted,
            attributes: aug.mode() === ViewMode.board ? 1 : 0,
          }}
        >
          board
        </span>
        <span style={{ fg: theme.textMuted }}> (v)</span>
      </text>
    </box>
  );
}
