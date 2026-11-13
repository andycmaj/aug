// The embedded terminal on a coding task: a tmux client linked to the
// task's window. Closing it detaches, and the claude keeps running.

import { createEffect } from "solid-js";
import { useToast } from "@andycmaj/opentui-app";
import { useAug } from "../context/aug";
import { useTerminals, type TermState } from "../context/terminals";
import * as store from "../core/store";
import { Kind } from "../core/types";

// Both modes mount the actions; one viewer attach per task at a time.
const attaching = new Set<number>();
// Tasks whose window aug runs in (no viewer for those), told once.
const refused = new Set<number>();

export const viewerId = (taskId: number) => `view-${taskId}`;
// The warning about the tmux server is said once a run.
let warned = false;

// Viewers that should go: any but the shown task's, and any whose claude
// ended. A hidden one stays a client of the task's window at its old size,
// and two sizes on one window is what hangs tmux 3.7 (mux.viewerMayHang).
// Showing a task again attaches a fresh one.
export function viewersToClose(
  terms: readonly TermState[],
  shownTaskId: number | null,
  live: (taskId: number) => boolean,
): string[] {
  return terms
    .filter((t) => t.kind === "agent" && t.taskId !== undefined)
    .filter((t) => t.taskId !== shownTaskId || !live(t.taskId as number))
    .map((t) => t.id);
}

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
      if (viewer.warning && !warned) showToast(viewer.warning, 10000, "error");
      if (viewer.warning) warned = true;
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
  // selected task gets a viewer, and every other viewer goes.
  createEffect(() => {
    aug.version();
    const item = aug.selected();
    const task = item?.type === "task" ? item.task : null;
    const live = (taskId: number) => {
      const row = store.getTask(taskId);
      return Boolean(row && desk.isLive(row));
    };
    for (const id of viewersToClose(terminals.list(), task?.id ?? null, live))
      terminals.close(id);
    if (task && task.kind === Kind.coding && desk.isLive(task))
      void attachViewer(task.id);
  });

  return { attachViewer };
}
