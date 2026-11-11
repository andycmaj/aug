// `@` in a chat box: which tasks and projects it offers as you type, how a
// pick is written into the text, and how the Assistant reads them back.

import { findProject, findTasks } from "./lookup";
import * as store from "./store";
import { ProjectStatus, type ProjectRow, type TaskRow } from "./types";

export type Mention =
  | { type: "task"; task: TaskRow }
  | { type: "project"; project: ProjectRow };

// How well a typed @query names something: lower is better, null is no match.
// Words match the name, best when they are all of it or begin it.
function nameScore(name: string, q: string): number | null {
  const text = name.toLowerCase();
  if (text === q) return 0;
  if (text.startsWith(q)) return 1;
  if (text.split(/[^a-z0-9]+/).some((w) => w.startsWith(q))) return 2;
  if (text.includes(q)) return 3;
  // Scattered letters only mean something once there are a few of them.
  if (q.length < 3) return null;
  let at = 0;
  for (const ch of text) if (ch === q[at]) at++;
  return at === q.length ? 4 : null;
}

// A number matches a task's ref and nothing else. "aug" alone may be a ref
// on its way or the start of a project's name; the name ranks first.
function mentionScore(m: Mention, query: string): number | null {
  if (!query) return 0;
  if (m.type === "project") {
    const q = query.toLowerCase();
    return /^(aug-?)?\d+$/.test(q) ? null : nameScore(m.project.name, q);
  }
  const q = query.toLowerCase().replace(/^aug-?/, "");
  if (!q) return 2;
  if (/^\d+$/.test(q))
    return String(m.task.id).startsWith(q.replace(/^0+/, "") || "0") ? 0 : null;
  return nameScore(m.task.title, q);
}

// What `@` puts in the text. A project's name loses what `mentionAt` would
// stop at; findProject ignores punctuation, so the ref still finds it.
export function mentionRef(m: Mention): string {
  if (m.type === "task") return store.taskRef(m.task.id);
  return (
    m.project.name.replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") ||
    m.project.tmux_session
  );
}

// What `@` offers in a chat box: open work and active projects. Finished
// work would crowd the short list and is rarely what you mean. Within a
// score tasks come first, newest first, then projects.
export function suggestMentions(query: string, limit = 6): Mention[] {
  const candidates: Mention[] = [
    ...findTasks().map((task) => ({ type: "task" as const, task })),
    ...store
      .listProjects()
      .filter((p) => p.status === ProjectStatus.active)
      .map((project) => ({ type: "project" as const, project })),
  ];
  const order = (m: Mention) =>
    m.type === "task" ? -m.task.id : Number.MAX_SAFE_INTEGER - m.project.id;
  return candidates
    .map((m) => ({ m, score: mentionScore(m, query) }))
    .filter((s): s is { m: Mention; score: number } => s.score !== null)
    .sort((a, b) => a.score - b.score || order(a.m) - order(b.m))
    .slice(0, limit)
    .map((s) => s.m);
}

// The `@query` being typed at the end of `before` (the text left of the
// cursor), or null when the cursor is not in one.
export function mentionAt(
  before: string,
): { start: number; query: string } | null {
  const m = before.match(/(?:^|\s)@([\w-]*)$/);
  if (!m) return null;
  return { start: before.length - m[1].length - 1, query: m[1] };
}

// @AUG-0012 (or a bare AUG-0012) in what the owner typed.
export function mentionedTasks(text: string): TaskRow[] {
  const ids = new Set<number>();
  for (const m of text.matchAll(/@?\bAUG-(\d{1,6})\b/gi)) ids.add(Number(m[1]));
  return [...ids]
    .map((id) => store.getTask(id))
    .filter((t): t is TaskRow => Boolean(t));
}

// @aug-bootstrap in what the owner typed: an @word that names a project.
export function mentionedProjects(text: string): ProjectRow[] {
  const found = new Map<number, ProjectRow>();
  for (const m of text.matchAll(/(?:^|\s)@([\w-]+)/g)) {
    const project = findProject(m[1]);
    if (project) found.set(project.id, project);
  }
  return [...found.values()];
}
