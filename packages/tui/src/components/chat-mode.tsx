// Chat: the rail beside the Canvas. The regular workflow - walk what waits,
// one item at a time, each task one chat.

import { createEffect, createMemo, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { useFocus, useTheme } from "@andycmaj/opentui-app";
import { useAug } from "../context/aug";
import { useTerminals } from "../context/terminals";
import { taskRef } from "@aug/core/rows";
import { AgentState, Kind } from "@aug/core/types";
import type { HelpCtx } from "../keymap";
import { Canvas } from "./canvas";
import { AugFooter } from "./footer";
import { Rail, RAIL_WIDTH } from "./rail";
import { useShell } from "./shell";
import { PaletteGroup, type PaletteExtra } from "../palette";
import { actionsFor } from "@aug/core/task-actions";
import { OPEN_REVIEW_TITLE } from "@aug/core/guide";

export function ChatMode() {
  const aug = useAug();
  const theme = useTheme();
  const terminals = useTerminals();
  const dims = useTerminalDimensions();
  const { sidebarVisible, isPaneFocused, setActivePane } = useFocus();
  const shell = useShell({
    typing: () => isPaneFocused("input"),
    extraPalette: () => taskActionEntries(),
  });

  // Every action that applies to the row the keys act on, one entry each.
  const taskActionEntries = (): PaletteExtra[] => {
    const item = isPaneFocused("rail") ? aug.cursorItem() : aug.selected();
    if (item?.type !== "task") return [];
    const task = aug.task(item.task.id);
    if (!task) return [];
    return actionsFor(aug.desk.config(), task).map((a) => ({
      id: `action-${a.name}`,
      group: PaletteGroup.row,
      label: `Action: ${a.title}`,
      hint: a.key ?? ".",
      inContext: true,
      run: () => shell.actions.runAction(task, a.name),
    })).concat(
      aug.desk.hasGuideReview(task.id)
        ? [{
            id: "action-guide-review",
            group: PaletteGroup.row,
            label: `Action: ${OPEN_REVIEW_TITLE}`,
            hint: ".",
            inContext: true,
            run: () => shell.actions.openGuideReview(task),
          }]
        : [],
    );
  };

  // `a` from anywhere (the Board too) lands in Home's box.
  createEffect(() => {
    if (!aug.wantsInput() || aug.selectedKey() !== `t${aug.homeId}`) return;
    aug.setWantsInput(false);
    setActivePane("input");
  });

  // A key on the rail acts on the row under the cursor; on the Canvas, on the
  // selected row.
  const canvasActions = shell.actions.taskActions(aug.selected, () =>
    setActivePane("input"),
  );
  const railActions = shell.actions.taskActions(aug.cursorItem, () => {
    aug.select(aug.cursorKey());
    setActivePane("input");
  });

  const onSay = (text: string) => {
    const item = aug.selected();
    if (item?.type !== "task") return;
    const task = aug.task(item.task.id);
    if (task) shell.actions.say(task, text);
  };

  const onCompose = (initial: string, keep: (text: string) => void) => {
    const item = aug.selected();
    if (item?.type !== "task") return;
    const task = aug.task(item.task.id);
    if (task) shell.actions.compose(task, initial, keep);
  };

  const baseCtx = createMemo((): HelpCtx => {
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
      aug.isLive(t);
    return {
      item: "task",
      kind: t.kind,
      hasDraft: aug.pending().has(t.id),
      live,
      coding: t.kind === Kind.coding,
      watching: Boolean(t.watching),
      started: !aug.briefEditable(t.id),
      pr: aug.taskPr(t) !== null,
    };
  });

  // What the palette's context mode is about: the row the keys act on.
  const subject = (): string | null => {
    const item = isPaneFocused("rail") ? aug.cursorItem() : aug.selected();
    if (!item) return null;
    if (item.type === "project") return `project ${item.project.name}`;
    return `${taskRef(item.task.id)} ${item.task.title}`;
  };

  const ctx = createMemo(
    (): HelpCtx => ({
      ...baseCtx(),
      typing: isPaneFocused("input"),
      filtered: aug.railFilter().size > 0,
      attached: terminals.attached() !== null,
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
          <Canvas actions={canvasActions} onSay={onSay} onCompose={onCompose} />
          <AugFooter ctx={ctx} left={sidebarVisible() ? RAIL_WIDTH + 2 : 0} />
          <box height={1} flexShrink={0} />
        </box>
      </box>
      <shell.Modals ctx={ctx} subject={subject} />
      <Show when={dims().width < 80}>
        <text fg={theme.warning}>widen the terminal for the full rail</text>
      </Show>
    </box>
  );
}
