// What a row says without another query: refs and the JSON columns decoded.
// Kept apart from the store so the views can use them without reaching for
// the database.

import { REF_PREFIX, refNumber } from "./brand";
import { TurnStatus, type NoteRow, type ProjectRow, type TurnRow } from "./types";

export function taskRef(id: number): string {
  return `${REF_PREFIX}${String(id).padStart(4, "0")}`;
}

export function parseTaskRef(ref: string): number | null {
  // AUG- too: refs written before the rename never go away.
  return refNumber(ref);
}

export function goalRef(id: number): string {
  return `G${id}`;
}

export function parseGoalRef(ref: string): number | null {
  const m = ref.trim().match(/^g?0*(\d+)$/i);
  return m ? Number(m[1]) : null;
}

export function projectRepos(project: ProjectRow): string[] {
  return JSON.parse(project.repos) as string[];
}

export function turnSteps(turn: TurnRow): string[] {
  return JSON.parse(turn.steps || "[]") as string[];
}

export function noteReadBy(note: NoteRow): string[] {
  return JSON.parse(note.read_by) as string[];
}

// How long the rail keeps saying an action finished or failed.
export const ACTION_SHOWN_MS = 2 * 60_000;

// What the rail says about a task's latest action turn: where a running
// one is, and for a short while that it finished or failed. Null when
// there is nothing to say.
export function actionRailWord(
  turn: TurnRow | undefined,
  now: Date,
): { text: string; running: boolean; failed: boolean } | null {
  if (!turn) return null;
  const name = turn.author || "action";
  if (turn.status === TurnStatus.running)
    return { text: `${name}: ${turn.progress ?? "running"}`, running: true, failed: false };
  if (!turn.finished_at || now.getTime() - Date.parse(turn.finished_at) > ACTION_SHOWN_MS) return null;
  const failed = turn.status === TurnStatus.failed;
  return { text: `${name} ${failed ? "failed" : "done"}`, running: false, failed };
}
