// The embedded terminal on a coding task: a tmux client linked to the
// task's window. Closing it detaches, and the claude keeps running.

import { createEffect } from "solid-js";
import { useToast } from "@andycmaj/opentui-app";
import { useAug } from "../context/aug";
import { useTerminals } from "../context/terminals";
import * as store from "../core/store";
import { Kind } from "../core/types";

// Both modes mount the actions; one viewer attach per task at a time.
const attaching = new Set<number>();
// Tasks whose window aug runs in (no viewer for those), told once.
const refused = new Set<number>();

export const viewerId = (taskId: number) => `view-${taskId}`;

export function useViewer() {
  const aug = useAug();
  const terminals = useTerminals();
  const { showToast } = useToast();
  const desk = aug.desk;

  async function attachViewer(taskId: number): Promise<boolean> {
    if (terminals.forTask(taskId)?.running) return true;
    if (attaching.has(taskId)) return false;
    attaching.add(taskId);
    try {
      const viewer = await desk.viewer(taskId);
      if (viewer && "refused" in viewer) {
        if (!refused.has(taskId)) showToast(viewer.refused, 6000, "error");
        refused.add(taskId);
        return false;
      }
      if (!viewer || terminals.forTask(taskId)?.running) return Boolean(viewer);
      const id = viewerId(taskId);
      terminals.close(id);
      terminals.open({
        id,
        title: store.taskRef(taskId),
        kind: "agent",
        taskId,
        argv: viewer.argv,
      });
      return true;
    } finally {
      attaching.delete(taskId);
    }
  }

  // Keeps the table's terminal in step with tmux: a live claude on the
  // selected task gets a viewer, and a viewer whose claude ended goes.
  createEffect(() => {
    aug.version();
    const item = aug.selected();
    const task = item?.type === "task" ? item.task : null;
    for (const term of terminals.list()) {
      if (term.kind !== "agent" || term.taskId === undefined) continue;
      const row = store.getTask(term.taskId);
      if (!row || !desk.isLive(row)) terminals.close(term.id);
    }
    if (task && task.kind === Kind.coding && desk.isLive(task))
      void attachViewer(task.id);
  });

  return { attachViewer };
}
