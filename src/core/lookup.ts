// What aug-tools' read commands print: tasks and projects as plain lines a
// model reads back. The Assistant and agents look things up here before they
// move anything.

import { transcript } from "./transcript";
import * as store from "./store";
import type { RailProject } from "./rail";
import {
  AgentState,
  ProjectStatus,
  TaskStatus,
  type ProjectRow,
  type TaskRow,
} from "./types";

function projectName(id: number | null): string | null {
  return id ? (store.getProject(id)?.name ?? null) : null;
}

export function taskLine(t: TaskRow): string {
  const facts = [
    t.kind,
    t.status,
    t.watching ? "watching" : "",
    t.status === TaskStatus.later && t.remind_at
      ? `until ${t.remind_at.slice(0, 10)}`
      : "",
    t.priority !== "regular" ? t.priority : "",
    `agent ${t.agent_state}`,
  ].filter(Boolean);
  const project = projectName(t.project_id);
  return `${store.taskRef(t.id)} [${facts.join(", ")}] ${t.title}${project ? ` (project ${project})` : ""}`;
}

export interface TaskFilter {
  all?: boolean;
  project?: string;
  query?: string;
}

export function findTasks(filter: TaskFilter = {}): TaskRow[] {
  const project = filter.project ? findProject(filter.project) : null;
  if (filter.project && !project) return [];
  const words = (filter.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return store.listTasks().filter((t) => {
    if (
      !filter.all &&
      t.status !== TaskStatus.open &&
      t.status !== TaskStatus.later
    )
      return false;
    if (project && t.project_id !== project.id) return false;
    const text = `${store.taskRef(t.id)} ${t.title} ${t.summary}`.toLowerCase();
    return words.every((w) => text.includes(w));
  });
}

export function taskDetail(t: TaskRow, turns = 12): string {
  const facts = [
    taskLine(t),
    t.summary ? `Summary: ${t.summary}` : "",
    t.repo ? `Repo: ${t.repo}${t.branch ? ` on ${t.branch}` : ""}` : "",
    t.worktree ? `Worktree: ${t.worktree}` : "",
    t.url ? `Link: ${t.url}` : "",
    t.waiting_on ? `Waiting on: ${t.waiting_on}` : "",
    t.agent_says ? `Agent says: ${t.agent_says}` : "",
  ].filter(Boolean);
  const said = transcript(store.turnsForTask(t.id).slice(-turns));
  return said ? `${facts.join("\n")}\n\n${said}` : facts.join("\n");
}

export function projectSummary(p: ProjectRow): RailProject {
  const open = store
    .tasksForProject(p.id)
    .filter((t) => t.status === TaskStatus.open || t.status === TaskStatus.later);
  return {
    project: p,
    open: open.length,
    working: open.filter((t) => t.agent_state === AgentState.working).length,
    repos: store.projectRepos(p),
  };
}

export function railProjects(): RailProject[] {
  return store
    .listProjects()
    .filter((p) => p.status === ProjectStatus.active)
    .map(projectSummary);
}

export function projectLine(p: ProjectRow): string {
  const s = projectSummary(p);
  return `${p.name} [${p.status}${p.solo ? ", solo" : ""}] repos: ${s.repos.length ? s.repos.join(", ") : "none"}; ${s.open} open task${s.open === 1 ? "" : "s"}${s.working ? `, ${s.working} working` : ""}`;
}

// By name or tmux session, ignoring case and punctuation.
export function findProject(name: string): ProjectRow | null {
  const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const want = key(name);
  return (
    store
      .listProjects()
      .find((p) => key(p.name) === want || key(p.tmux_session) === want) ??
    null
  );
}

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

export type Mention =
  | { type: "task"; task: TaskRow }
  | { type: "project"; project: ProjectRow };

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
export function mentionAt(before: string): { start: number; query: string } | null {
  const m = before.match(/(?:^|\s)@([\w-]*)$/);
  if (!m) return null;
  return { start: before.length - m[1].length - 1, query: m[1] };
}
