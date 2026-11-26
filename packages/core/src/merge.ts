// Whether a task's work has landed: its PR merged on GitHub, or its branch
// merged into the base by hand (rebase and fast-forward, a merge commit, a
// squash). Merged is a phase, not done: the owner cleans it up. Runs on its
// own clock, since a local merge needs no network, and for one task when its
// agent's turn ends (the turn that merged it is the likeliest one).

import type { RikerConfig } from "./config";
import { mergeUndone, workMerged } from "./lifecycle";
import { errorMessage, logger } from "./log";
import { type Mux, mux } from "./mux";
import { taskPrStatus, unmergedPr } from "./pr";
import { repoPath } from "./repos";
import * as store from "./store";
import { PrState, TaskStatus, type TaskRow } from "./types";

const log = logger("merge");

// One repo's merge keys (mux.mergeKeys), read once per sweep; undefined
// reads them for the one branch.
type Keys = Map<string, string> | null | undefined;

// branchMerged is a handful of git calls, and the sweep runs every couple of
// minutes on every task with a branch. Its answer moves only with the refs
// it reads, so it is asked again only where a branch's key moved. Kept per
// Mux, so a test's fresh fake starts empty. Null (git could not say, maybe a
// timeout) is never kept.
const verdicts = new WeakMap<
  Mux,
  Map<string, { key: string; verdict: string | false }>
>();

function verdictsOf(
  m: Mux,
): Map<string, { key: string; verdict: string | false }> {
  let v = verdicts.get(m);
  if (!v) {
    v = new Map();
    verdicts.set(m, v);
  }
  return v;
}

const slot = (path: string, branch: string) => `${path}\0${branch}`;

async function branchLanded(
  path: string,
  branch: string,
  keys: Keys,
): Promise<string | false | null> {
  const m = mux();
  const read = keys === undefined ? await m.mergeKeys(path, [branch]) : keys;
  const key = read?.get(branch);
  if (!key) {
    return null;
  }
  const known = verdictsOf(m);
  const at = slot(path, branch);
  const hit = known.get(at);
  if (hit?.key === key) {
    return hit.verdict;
  }
  const verdict = await m.branchMerged(path, branch);
  if (verdict === null) {
    known.delete(at);
  } else {
    known.set(at, { key, verdict });
  }
  return verdict;
}

// The words for how it landed, false when it has not, null when nothing
// can say.
async function landed(
  config: RikerConfig,
  task: TaskRow,
  keys: Keys,
): Promise<string | false | null> {
  const pr = taskPrStatus(task)?.status ?? null;
  if (pr?.state === PrState.merged) {
    return `(PR #${pr.number})`;
  }
  const path = repoPath(config, task.repo);
  const local =
    task.branch && path ? await branchLanded(path, task.branch, keys) : null;
  if (local) {
    return `into ${local}`;
  }
  if (local === false) {
    return false;
  }
  return pr && (pr.state === PrState.open || pr.state === PrState.draft)
    ? false
    : null;
}

function wantsCheck(task: TaskRow): boolean {
  if (task.status !== TaskStatus.open && task.status !== TaskStatus.later) {
    return false;
  }
  return !!task.branch || !!task.merged_at || !!store.prStatus(task.id);
}

// One task: true when its merged mark changed.
export function checkMerge(
  config: RikerConfig,
  task: TaskRow,
): Promise<boolean> {
  return checkOne(config, task, undefined);
}

async function checkOne(
  config: RikerConfig,
  task: TaskRow,
  keys: Keys,
): Promise<boolean> {
  if (!wantsCheck(task)) {
    return false;
  }
  try {
    const how = await landed(config, task, keys);
    // The clock's sweep and a turn's end can ask at once: what the task says
    // now, not before the await, decides, so the mark is made once.
    const current = store.getTask(task.id);
    if (!current) {
      return false;
    }
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

// Every task: one git call per repo for the keys, then branchMerged only
// for a branch whose key moved, one task at a time.
export async function checkMerges(config: RikerConfig): Promise<number> {
  const tasks = store.listTasks().filter(wantsCheck);
  const branches = new Map<string, string[]>();
  for (const task of tasks) {
    const path = repoPath(config, task.repo);
    if (path && task.branch) {
      branches.set(path, [...(branches.get(path) ?? []), task.branch]);
    }
  }
  const keys = new Map<string, Map<string, string> | null>();
  for (const [path, names] of branches) {
    try {
      keys.set(path, await mux().mergeKeys(path, [...new Set(names)]));
    } catch (err) {
      log.warn("merge keys failed", { error: errorMessage(err) });
      keys.set(path, null);
    }
  }
  // A branch no task asks about any more is forgotten.
  const known = verdictsOf(mux());
  const asked = new Set(
    [...branches].flatMap(([path, names]) => names.map((b) => slot(path, b))),
  );
  for (const at of known.keys()) {
    if (!asked.has(at)) {
      known.delete(at);
    }
  }
  let changed = 0;
  for (const task of tasks) {
    const path = repoPath(config, task.repo);
    if (await checkOne(config, task, path ? keys.get(path) : undefined)) {
      changed++;
    }
  }
  return changed;
}

// Whether the task's work has merged, for the owner's yes before done: null
// when it has (merged_at, or its PR or branch landed before the sweep marked
// it), else why not. Every other task asks, with or without a PR or branch;
// `why` is what its PR (read first: open, a draft, closed) or its branch
// (commits not in the base) says, null when neither says more. Git failing
// leaves `why` empty and never holds up done.
export interface NotMerged {
  why: string | null;
}

export async function unmergedWork(
  config: RikerConfig,
  task: TaskRow,
): Promise<NotMerged | null> {
  if (task.merged_at) {
    return null;
  }
  const pr = taskPrStatus(task)?.status ?? null;
  if (pr?.state === PrState.merged) {
    return null;
  }
  if (pr?.state === PrState.closed) {
    return { why: `PR #${pr.number} was closed, not merged` };
  }
  if (pr) {
    return { why: unmergedPr(task) };
  }
  const path = repoPath(config, task.repo);
  if (!task.branch || !path) {
    return { why: null };
  }
  try {
    if (await branchLanded(path, task.branch, undefined)) {
      return null;
    }
    const ahead = await mux().branchAhead(path, task.branch);
    if (!ahead) {
      return { why: null };
    }
    return {
      why: `Branch ${task.branch} has ${ahead} commit${ahead === 1 ? "" : "s"} not merged`,
    };
  } catch (err) {
    log.warn("unmerged check failed", {
      task: task.id,
      error: errorMessage(err),
    });
    return { why: null };
  }
}
