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
  type TaskLinkRow,
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

export function linkLine(l: TaskLinkRow): string {
  return l.title ? `${l.title} ${l.url}` : l.url;
}

export function taskDetail(t: TaskRow, turns = 12): string {
  const facts = [
    taskLine(t),
    t.summary ? `Summary: ${t.summary}` : "",
    t.repo ? `Repo: ${t.repo}${t.branch ? ` on ${t.branch}` : ""}` : "",
    t.worktree ? `Worktree: ${t.worktree}` : "",
    t.url ? `Link: ${t.url}` : "",
    ...store.linksForTask(t.id).map((l) => `Link: ${linkLine(l)}`),
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

