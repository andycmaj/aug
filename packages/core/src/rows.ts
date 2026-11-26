// What a row says without another query: refs and the JSON columns decoded.
// Kept apart from the store so the views can use them without reaching for
// the database.

import { REF_PREFIX, refNumber } from "./brand";
import {
  TaskStatus,
  TurnRole,
  TurnStatus,
  type NoteRow,
  type ProjectRow,
  type TaskRow,
  type TurnRow,
} from "./types";

export function taskRef(id: number): string {
  return `${REF_PREFIX}${String(id).padStart(4, "0")}`;
}

// Done or dropped: off the rail, and d reopens it.
export function isClosed(task: Pick<TaskRow, "status">): boolean {
  return task.status === TaskStatus.done || task.status === TaskStatus.dropped;
}

// A labeled field: on the label's line when it is one line, under it when
// it has paragraphs of its own, so its first one does not run into the
// label.
export function labeled(label: string, text: string): string {
  return text.includes("\n") ? `${label}:\n${text}` : `${label}: ${text}`;
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

// Each action's last answer on a task, newest first: what the owner can
// read again where the Canvas shows the agent instead of the chat. A pane
// action's turn says only where it opened, so `skip` leaves those out.
export function actionAnswers(
  turns: TurnRow[],
  skip: (name: string) => boolean = () => false,
): TurnRow[] {
  const seen = new Set<string>();
  const answers: TurnRow[] = [];
  for (const turn of [...turns].reverse()) {
    if (turn.role !== TurnRole.action || turn.status !== TurnStatus.done) {
      continue;
    }
    if (!turn.body.trim() || seen.has(turn.author) || skip(turn.author)) {
      continue;
    }
    seen.add(turn.author);
    answers.push(turn);
  }
  return answers;
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
  if (!turn) {
    return null;
  }
  const name = turn.author || "action";
  if (turn.status === TurnStatus.running) {
    return {
      text: `${name}: ${turn.progress ?? "running"}`,
      running: true,
      failed: false,
    };
  }
  if (
    !turn.finished_at ||
    now.getTime() - Date.parse(turn.finished_at) > ACTION_SHOWN_MS
  ) {
    return null;
  }
  const failed = turn.status === TurnStatus.failed;
  return {
    text: `${name} ${failed ? "failed" : "done"}`,
    running: false,
    failed,
  };
}

// What a story or journal reader lists to open, numbered: the task's PR,
// the thread it came from, its links, then its project's docs. One row per
// URL, the first place it is named winning.
export interface DocLink {
  label: string;
  url: string;
}

export function docLinks(parts: {
  pr?: { repo: string; number: number; url: string } | null;
  source?: string | null;
  task?: { url: string; title: string | null }[];
  project?: { url: string; title: string | null }[];
}): DocLink[] {
  const short = (u: string) => u.replace(/^(https?|file):\/\//, "");
  const all: DocLink[] = [
    ...(parts.pr
      ? [{ label: `PR ${parts.pr.repo}#${parts.pr.number}`, url: parts.pr.url }]
      : []),
    ...(parts.source ? [{ label: "thread", url: parts.source }] : []),
    ...(parts.task ?? []).map((l) => ({
      label: l.title ?? short(l.url),
      url: l.url,
    })),
    ...(parts.project ?? []).map((l) => ({
      label: `${l.title ?? short(l.url)} (project)`,
      url: l.url,
    })),
  ];
  const seen = new Set<string>();
  return all.filter((l) => !seen.has(l.url) && Boolean(seen.add(l.url)));
}
