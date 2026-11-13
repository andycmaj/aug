// Chat: the rail beside the table. The regular workflow - walk what waits,
// one item at a time, each task one chat.

import { createEffect, createMemo, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { useFocus, useTheme } from "@andycmaj/opentui-app";
import { useAug } from "../context/aug";
import { useTerminals } from "../context/terminals";
import { taskPr } from "../core/pr";
import * as store from "../core/store";
import { AgentState, Kind } from "../core/types";
import type { HelpCtx } from "../keymap";
import { Canvas } from "./canvas";
import { AugFooter } from "./footer";
import { Rail, RAIL_WIDTH } from "./rail";
import { useShell } from "./shell";

export function ChatMode() {
  const aug = useAug();
  const theme = useTheme();
  const terminals = useTerminals();
  const dims = useTerminalDimensions();
  const { sidebarVisible, isPaneFocused, setActivePane } = useFocus();
  const shell = useShell({ typing: () => isPaneFocused("input") });

  // `a` from anywhere (the Board too) lands in Home's box.
  createEffect(() => {
    if (!aug.wantsInput() || aug.selectedKey() !== `t${aug.homeId}`) return;
    aug.setWantsInput(false);
    setActivePane("input");
  });

  // A key on the rail acts on the row under the cursor; on the table, on the
  // row on the table.
  const tableActions = shell.actions.taskActions(aug.selected, () =>
    setActivePane("input"),
  );
  const railActions = shell.actions.taskActions(aug.cursorItem, () => {
    aug.select(aug.cursorKey());
    setActivePane("input");
  });

  const onSay = (text: string) => {
    const item = aug.selected();
    if (item?.type !== "task") return;
    const task = store.getTask(item.task.id);
    if (task) shell.actions.say(task, text);
  };

  const onCompose = (initial: string, keep: (text: string) => void) => {
    const item = aug.selected();
    if (item?.type !== "task") return;
    const task = store.getTask(item.task.id);
    if (task) shell.actions.compose(task, initial, keep);
  };

  const baseCtx = createMemo((): HelpCtx => {
    aug.version();
    const item = isPaneFocused("rail") ? aug.cursorItem() : aug.selected();
    if (!item)
      return {
        item: null,
        kind: null,
        hasDraft: false,
        live: false,
        coding: false,
        watching: false,
        started: false,
        pr: false,
      };
    if (item.type !== "task")
      return {
        item: item.type,
        kind: null,
        hasDraft: false,
        live: false,
        coding: false,
        watching: false,
        started: false,
        pr: false,
      };
    const t = item.task;
    const live =
      t.agent_state === AgentState.working ||
      Boolean(terminals.forTask(t.id)?.running) ||
      aug.desk.isLive(t);
    return {
      item: "task",
      kind: t.kind,
      hasDraft: aug.pending().has(t.id),
      live,
      coding: t.kind === Kind.coding,
      watching: Boolean(t.watching),
      started: !aug.desk.briefEditable(t.id),
      pr: taskPr(t) !== null,
    };
  });

  const ctx = createMemo(
    (): HelpCtx => ({
      ...baseCtx(),
      typing: isPaneFocused("input"),
      filtered: aug.railFilter().size > 0,
    }),
  );

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={theme.background}
    >
      <box ref={shell.layoutRef} flexDirection="row" flexGrow={1}>
        <Show when={sidebarVisible()}>
          <Rail actions={railActions} />
        </Show>
        <box flexDirection="column" flexGrow={1}>
          <Canvas actions={tableActions} onSay={onSay} onCompose={onCompose} />
          <AugFooter ctx={ctx} left={sidebarVisible() ? RAIL_WIDTH + 2 : 0} />
          <box height={1} flexShrink={0} />
        </box>
      </box>
      <shell.Modals />
      <Show when={dims().width < 80}>
        <text fg={theme.warning}>widen the terminal for the full rail</text>
      </Show>
    </box>
  );
}
