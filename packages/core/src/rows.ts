// What a row says without another query: refs and the JSON columns decoded.
// Kept apart from the store so the views can use them without reaching for
// the database.

import { REF_PREFIX, refNumber } from "./brand";
import type { NoteRow, ProjectRow, TurnRow } from "./types";

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
