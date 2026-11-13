// ghdash (the PR dashboard) on the table, in place of the task's chat or
// agent terminal: one embedded terminal per task, on the task's PR. q in
// ghdash or the key again gives the table back.

import { existsSync } from "node:fs";
import { useFocus, useToast } from "@andycmaj/opentui-app";
import { useAug, ViewMode } from "../context/aug";
import { useTerminals } from "../context/terminals";
import { taskPr } from "../core/pr";
import * as store from "../core/store";
import type { TaskRow } from "../core/types";

export const prDashId = (taskId: number) => `ghdash-${taskId}`;

export function usePrDash() {
  const aug = useAug();
  const terminals = useTerminals();
  const { setActivePane } = useFocus();
  const { showToast } = useToast();

  function closeOthers(keep: number | null) {
    for (const t of terminals.list())
      if (t.kind === "ghdash" && t.taskId !== keep) terminals.close(t.id);
  }

  function togglePrDash(task: TaskRow): false | void {
    const pr = taskPr(task);
    if (!pr) return false;
    const id = prDashId(task.id);
    if (terminals.get(id)?.running) {
      terminals.close(id);
      return;
    }
    const bin = Bun.which("ghdash");
    if (!bin) {
      showToast("ghdash is not on PATH", 4000, "error");
      return;
    }
    aug.setMode(ViewMode.chat);
    aug.selectTask(task.id);
    closeOthers(task.id);
    terminals.open({
      id,
      title: `${store.taskRef(task.id)} ${pr.repo}#${pr.number}`,
      kind: "ghdash",
      taskId: task.id,
      argv: [bin, pr.url],
      // ghdash reads the local checkout for history when it has one.
      cwd:
        task.worktree && existsSync(task.worktree) ? task.worktree : undefined,
      onExit: (code) => {
        // Gone already: closed from here (the key, the table moving on), or
        // a newer one runs under the same id.
        const state = terminals.get(id);
        if (!state || state.running) return;
        terminals.close(id);
        if (code) showToast(`ghdash exited ${code}`, 4000, "error");
        if (aug.selectedKey() === `t${task.id}`) setActivePane("task");
      },
    });
    setTimeout(() => setActivePane("task"), 0);
  }

  return { togglePrDash, closeOthers };
}
