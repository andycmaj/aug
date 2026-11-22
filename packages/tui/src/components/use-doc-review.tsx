// A System task's proposals in revdiff, on the Canvas: your doc against the
// proposed one. Notes left in revdiff go back to be redrafted when it quits.
// Without revdiff, the diff in a pager.

import { existsSync, readFileSync } from "node:fs";
import { useFocus, useToast } from "@andycmaj/opentui-app";
import { useRiker, ViewMode } from "../context/riker";
import { useTerminals } from "../context/terminals";
import { writeReview } from "@riker/core/proposals";
import { taskRef } from "@riker/core/rows";
import { Kind, type TaskRow } from "@riker/core/types";

export const docReviewId = (taskId: number) => `review-${taskId}`;

export function useDocReview() {
  const riker = useRiker();
  const terminals = useTerminals();
  const { setActivePane } = useFocus();
  const { showToast } = useToast();

  function argv(diff: string, out: string, title: string): string[] {
    const revdiff = Bun.which("revdiff");
    if (revdiff)
      return [
        "sh",
        "-c",
        `exec "$0" --stdin --stdin-name=proposal.diff --wrap --description="$3" -o "$2" < "$1"`,
        revdiff,
        diff,
        out,
        title,
      ];
    return ["sh", "-c", `exec "\${PAGER:-less}" "$0"`, diff];
  }

  function reviewDocs(task: TaskRow): false | void {
    if (task.kind !== Kind.system) return false;
    const files = writeReview(task.id);
    if (!files) {
      showToast("nothing to review here: y accepts, x rejects", 3000);
      return;
    }
    if (files.empty) {
      showToast("the proposal is the same as your doc", 3000);
      return;
    }
    const id = docReviewId(task.id);
    terminals.close(id);
    riker.setMode(ViewMode.chat);
    riker.selectTask(task.id);
    terminals.open({
      id,
      title: `${taskRef(task.id)} ${task.title}`,
      kind: "review",
      taskId: task.id,
      argv: argv(
        files.diff,
        files.out,
        files.stale.length
          ? `${task.title}. ${files.stale.join(", ")} changed since where the proposal edits it, so this is the proposal against the text it was drafted on; y keeps it waiting, x rejects.`
          : `${task.title}. Left: your doc. Right: the proposal. Notes you leave are sent back to redraft it; y accepts, x rejects.`,
      ),
      cwd: files.dir,
      onExit: () => {
        const state = terminals.get(id);
        if (!state || state.running) return;
        terminals.close(id);
        if (riker.selectedKey() === `t${task.id}`) setActivePane("canvas");
        const notes = existsSync(files.out)
          ? readFileSync(files.out, "utf8").trim()
          : "";
        if (!notes) return;
        showToast("redrafting from your notes…", 3000);
        void riker.desk.redraftDocs(task.id, notes).then((line) => {
          showToast(line, 4000);
        });
      },
    });
    setTimeout(() => setActivePane("canvas"), 0);
  }

  return { reviewDocs };
}
