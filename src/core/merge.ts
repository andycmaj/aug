// Whether a task's work has landed: its PR merged on GitHub, or its branch
// merged into the base by hand (rebase and fast-forward, a merge commit, a
// squash). Merged is a phase, not done: the owner cleans it up. Runs on its
// own clock, since a local merge needs no network.

import type { AugConfig } from "./config";
import { mergeUndone, workMerged } from "./lifecycle";
import { errorMessage, logger } from "./log";
import { mux } from "./mux";
import { taskPrStatus } from "./pr";
import { repoPath } from "./repos";
import * as store from "./store";
import { PrState, TaskStatus, type TaskRow } from "./types";

const log = logger("merge");

// The words for how it landed, false when it has not, null when nothing
// can say.
async function landed(config: AugConfig, task: TaskRow): Promise<string | false | null> {
  const pr = taskPrStatus(task)?.status ?? null;
  if (pr?.state === PrState.merged) return `(PR #${pr.number})`;
  const path = repoPath(config, task.repo);
  const local = task.branch && path ? await mux().branchMerged(path, task.branch) : null;
  if (local) return `into ${local}`;
  if (local === false) return false;
  return pr && (pr.state === PrState.open || pr.state === PrState.draft) ? false : null;
}

// One task at a time: a few git calls each.
export async function checkMerges(config: AugConfig): Promise<number> {
  let changed = 0;
  for (const task of store.listTasks()) {
    if (task.status !== TaskStatus.open && task.status !== TaskStatus.later) continue;
    if (!task.branch && !task.merged_at && !store.prStatus(task.id)) continue;
    try {
      const how = await landed(config, task);
      if (how && !task.merged_at) {
        workMerged(task.id, how);
        changed++;
      } else if (how === false && task.merged_at) {
        mergeUndone(task.id);
        changed++;
      }
    } catch (err) {
      log.warn("merge check failed", { task: task.id, error: errorMessage(err) });
    }
  }
  return changed;
}
