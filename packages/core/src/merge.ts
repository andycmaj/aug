// Whether a task's work has landed: its PR merged on GitHub, or its branch
// merged into the base by hand (rebase and fast-forward, a merge commit, a
// squash). Merged is a phase, not done: the owner cleans it up. Runs on its
// own clock, since a local merge needs no network, and for one task when its
// agent's turn ends (the turn that merged it is the likeliest one).

import type { RikerConfig } from "./config";
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
async function landed(config: RikerConfig, task: TaskRow): Promise<string | false | null> {
  const pr = taskPrStatus(task)?.status ?? null;
  if (pr?.state === PrState.merged) return `(PR #${pr.number})`;
  const path = repoPath(config, task.repo);
  const local = task.branch && path ? await mux().branchMerged(path, task.branch) : null;
  if (local) return `into ${local}`;
  if (local === false) return false;
  return pr && (pr.state === PrState.open || pr.state === PrState.draft) ? false : null;
}

function wantsCheck(task: TaskRow): boolean {
  if (task.status !== TaskStatus.open && task.status !== TaskStatus.later) return false;
  return !!task.branch || !!task.merged_at || !!store.prStatus(task.id);
}

// One task: true when its merged mark changed.
export async function checkMerge(config: RikerConfig, task: TaskRow): Promise<boolean> {
  if (!wantsCheck(task)) return false;
  try {
    const how = await landed(config, task);
    // The clock's sweep and a turn's end can ask at once: what the task says
    // now, not before the await, decides, so the mark is made once.
    const current = store.getTask(task.id);
    if (!current) return false;
    if (how && !current.merged_at) {
      workMerged(task.id, how);
      return true;
    }
    if (how === false && current.merged_at) {
      mergeUndone(task.id);
      return true;
    }
  } catch (err) {
    log.warn("merge check failed", { task: task.id, error: errorMessage(err) });
  }
  return false;
}

// One task at a time: a few git calls each.
export async function checkMerges(config: RikerConfig): Promise<number> {
  let changed = 0;
  for (const task of store.listTasks()) if (await checkMerge(config, task)) changed++;
  return changed;
}
