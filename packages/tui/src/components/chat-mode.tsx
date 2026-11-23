// Chat: the rail beside the Canvas. The regular workflow - walk what waits,
// one item at a time, each task one chat.

import { createEffect, createMemo, Show } from "solid-js";
import { useTerminalDimensions } from "@opentui/solid";
import { useFocus, useTheme } from "@andycmaj/opentui-app";
import { useRiker } from "../context/riker";
import { useTerminals } from "../context/terminals";
import { isClosed, taskRef } from "@riker/core/rows";
import { AgentState, Kind } from "@riker/core/types";
import type { HelpCtx } from "../keymap";
import { Canvas } from "./canvas";
import { RikerFooter } from "./footer";
import { Rail, RAIL_WIDTH } from "./rail";
import { useShell } from "./shell";
import { PaletteGroup, type PaletteExtra } from "../palette";
import { actionsFor } from "@riker/core/task-actions";
import { OPEN_REVIEW_TITLE } from "@riker/core/guide-turn";

export function ChatMode() {
  const riker = useRiker();
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
    const item = isPaneFocused("rail") ? riker.cursorItem() : riker.selected();
    if (item?.type !== "task") return [];
    const task = riker.task(item.task.id);
    if (!task) return [];
    return actionsFor(riker.desk.config(), task).map((a) => ({
      id: `action-${a.name}`,
      group: PaletteGroup.row,
      label: `Action: ${a.title}`,
      hint: a.key ?? ".",
      inContext: true,
      run: () => shell.actions.runAction(task, a.name),
    })).concat(
      riker.desk.hasGuideReview(task.id)
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
    if (!riker.wantsInput() || riker.selectedKey() !== `t${riker.homeId}`) return;
    riker.setWantsInput(false);
    setActivePane("input");
  });

  // A key on the rail acts on the row under the cursor; on the Canvas, on the
  // selected row.
  const canvasActions = shell.actions.taskActions(riker.selected, () =>
    setActivePane("input"),
  );
  const railActions = shell.actions.taskActions(riker.cursorItem, () => {
    riker.select(riker.cursorKey());
    setActivePane("input");
  });

  const onSay = (text: string) => {
    const item = riker.selected();
    if (item?.type !== "task") return;
    const task = riker.task(item.task.id);
    if (task) shell.actions.say(task, text);
  };

  const onCompose = (initial: string, keep: (text: string) => void) => {
    const item = riker.selected();
    if (item?.type !== "task") return;
    const task = riker.task(item.task.id);
    if (task) shell.actions.compose(task, initial, keep);
  };

  const baseCtx = createMemo((): HelpCtx => {
    const item = isPaneFocused("rail") ? riker.cursorItem() : riker.selected();
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
      riker.isLive(t);
    return {
      item: "task",
      kind: t.kind,
      hasDraft: riker.pending().has(t.id),
      live,
      coding: t.kind === Kind.coding,
      watching: Boolean(t.watching),
      started: !riker.briefEditable(t.id),
      pr: riker.taskPr(t) !== null,
      closed: isClosed(t),
      actions: actionsFor(riker.desk.config(), riker.task(t.id) ?? t).map((a) => a.name),
    };
  });

  // What the palette's context mode is about: the row the keys act on.
  const subject = (): string | null => {
    const item = isPaneFocused("rail") ? riker.cursorItem() : riker.selected();
    if (!item) return null;
    if (item.type === "project") return `project ${item.project.name}`;
    return `${taskRef(item.task.id)} ${item.task.title}`;
  };

  const ctx = createMemo(
    (): HelpCtx => ({
      ...baseCtx(),
      typing: isPaneFocused("input"),
      filtered: riker.railFilter().size > 0,
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
          <RikerFooter ctx={ctx} left={sidebarVisible() ? RAIL_WIDTH + 2 : 0} />
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
