// What riker-tools' read commands print: tasks and projects as plain lines a
// model reads back. The Assistant and agents look things up here before they
// move anything.

import type { RikerConfig } from "./config";
import { journalSwitch, projectStoryDefault, storySwitch, switchWords } from "./digests";
import { storyBlock } from "./story";
import { transcript } from "./transcript";
import * as store from "./store";
import type { RailProject } from "./rail";
import {
  AgentState,
  GoalStatus,
  ProjectStatus,
  TaskStatus,
  type GoalRow,
  type ProjectLinkRow,
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
  const goal = t.goal_id ? ` for ${store.goalRef(t.goal_id)}` : "";
  return `${store.taskRef(t.id)} [${facts.join(", ")}] ${t.title}${project ? ` (project ${project}${goal})` : ""}`;
}

// What a coding agent's Claude Code status line shows: the task header's
// ref, title and priority, as plain text the prompt tool colors itself.
export const STATUS_TITLE_MAX = 60;

export function statusLine(t: TaskRow): string {
  const title =
    t.title.length > STATUS_TITLE_MAX
      ? `${t.title.slice(0, STATUS_TITLE_MAX - 1)}…`
      : t.title;
  const priority = t.priority !== "regular" ? ` · ${t.priority}` : "";
  return `${store.taskRef(t.id)} ${title}${priority}`;
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

export function linkLine(l: TaskLinkRow | ProjectLinkRow): string {
  return l.title ? `${l.title} ${l.url}` : l.url;
}

// The board drops a task's notes when it closes; its detail keeps the latest.
const TASK_NOTES = 10;

export function taskDetail(t: TaskRow, turns = 12, config?: RikerConfig): string {
  const story = storyBlock(t.id);
  const facts = [
    taskLine(t),
    t.summary ? `Summary: ${t.summary}` : "",
    t.repo ? `Repo: ${t.repo}${t.branch ? ` on ${t.branch}` : ""}` : "",
    t.worktree ? `Worktree: ${t.worktree}` : "",
    t.url ? `Link: ${t.url}` : "",
    ...store.linksForTask(t.id).map((l) => `Link: ${linkLine(l)}`),
    t.waiting_on ? `Waiting on: ${t.waiting_on}` : "",
    t.agent_says ? `Agent says: ${t.agent_says}` : "",
    config ? `Switches: ${switchWords("story", storySwitch(config, t))}` : "",
    story ? `\n${story}\n` : "",
  ].filter(Boolean);
  const notes = store
    .notesForTask(t.id)
    .slice(-TASK_NOTES)
    .map((n) => `Note ${n.created_at.slice(0, 16)} ${n.author} [${n.label}]: ${n.body}`);
  const said = transcript(store.turnsForTask(t.id).slice(-turns));
  return [[...facts, ...notes].join("\n"), said].filter(Boolean).join("\n\n");
}

const isOpen = (t: TaskRow) =>
  t.status === TaskStatus.open || t.status === TaskStatus.later;

export function projectSummary(p: ProjectRow): RailProject {
  const open = store.tasksForProject(p.id).filter(isOpen);
  const goals = store
    .goalsForProject(p.id)
    .filter((g) => g.status !== GoalStatus.dropped);
  return {
    project: p,
    open: open.length,
    working: open.filter((t) => t.agent_state === AgentState.working).length,
    repos: store.projectRepos(p),
    goalsMet: goals.filter((g) => g.status === GoalStatus.met).length,
    goals: goals.length,
  };
}

// Where a project stands against its goals: each goal with the tasks working
// toward it, and the tasks that name no goal. A goal is met when the owner
// says so; its tasks all done only means it is ready to be called.
export interface GoalProgress {
  goal: GoalRow;
  tasks: TaskRow[];
  done: number;
  open: number;
  working: number;
}

export interface ProjectProgress {
  goals: GoalProgress[];
  // Open tasks in the project that serve no goal.
  loose: TaskRow[];
}

export function projectProgress(p: ProjectRow): ProjectProgress {
  const tasks = store.tasksForProject(p.id);
  const goals = store.goalsForProject(p.id).map((goal): GoalProgress => {
    const mine = tasks.filter((t) => t.goal_id === goal.id);
    const open = mine.filter(isOpen);
    return {
      goal,
      tasks: mine,
      done: mine.filter((t) => t.status === TaskStatus.done).length,
      open: open.length,
      working: open.filter((t) => t.agent_state === AgentState.working).length,
    };
  });
  const known = new Set(goals.map((g) => g.goal.id));
  const loose = tasks.filter(
    (t) => isOpen(t) && (t.goal_id === null || !known.has(t.goal_id)),
  );
  return { goals, loose };
}

export function goalLine(g: GoalProgress): string {
  const counts = g.tasks.length
    ? `${g.done}/${g.tasks.length} tasks done${g.working ? `, ${g.working} working` : ""}`
    : "no tasks yet";
  return `${store.goalRef(g.goal.id)} [${g.goal.status}] ${g.goal.title}: ${counts}`;
}

export function railProjects(): RailProject[] {
  return store
    .listProjects()
    .filter((p) => p.status === ProjectStatus.active)
    .map(projectSummary);
}

export function projectLine(p: ProjectRow): string {
  const s = projectSummary(p);
  return `${p.name} [${p.status}${p.solo ? ", solo" : ""}] repos: ${s.repos.length ? s.repos.join(", ") : "none"}; ${s.open} open task${s.open === 1 ? "" : "s"}${s.working ? `, ${s.working} working` : ""}${s.goals ? `; goals ${s.goalsMet}/${s.goals} met` : ""}`;
}

// What `riker-tools project <name>` prints: the brief, the goals and how far
// each has come, the docs, and the open work that names no goal.
export function projectDetail(p: ProjectRow, config?: RikerConfig): string {
  const progress = projectProgress(p);
  const goals = progress.goals.filter((g) => g.goal.status !== GoalStatus.dropped);
  const links = store.linksForProject(p.id);
  return [
    projectLine(p),
    config ? projectSwitches(config, p) : "",
    p.brief ? `\nBrief:\n${p.brief}` : "\nNo brief yet.",
    goals.length
      ? `\nGoals:\n${goals
          .map((g) =>
            [goalLine(g), ...g.tasks.filter(isOpen).map((t) => `  ${taskLine(t)}`)].join("\n"),
          )
          .join("\n")}`
      : "\nNo goals yet.",
    links.length ? `\nDocs:\n${links.map((l) => `- ${linkLine(l)}`).join("\n")}` : "",
    progress.loose.length
      ? `\nOpen tasks for no goal:\n${progress.loose.map((t) => `  ${taskLine(t)}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// What the project's journal and its tasks' stories default to, and why.
export function projectSwitches(config: RikerConfig, p: ProjectRow): string {
  return `Switches: ${switchWords("journal", journalSwitch(config, p))}, ${switchWords("stories", projectStoryDefault(config, p))}`;
}

// A project as the Assistant gets it when the owner names it: the brief,
// the goals and how far each has come, and the docs. Its open work is a
// `project <name>` away.
export function projectBrief(p: ProjectRow): string {
  const goals = projectProgress(p).goals.filter(
    (g) => g.goal.status !== GoalStatus.dropped,
  );
  const links = store.linksForProject(p.id);
  return [
    projectLine(p),
    p.brief ? `\nBrief:\n${p.brief}` : "\nNo brief yet.",
    goals.length ? `\nGoals:\n${goals.map(goalLine).join("\n")}` : "\nNo goals yet.",
    links.length ? `\nDocs:\n${links.map((l) => `- ${linkLine(l)}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// The project a task is in, as its agent's brief tells it: what the project
// is for, the goal this task serves, the others beside it, and the docs.
export function projectContext(task: TaskRow): string {
  const p = task.project_id ? store.getProject(task.project_id) : null;
  if (!p) return "";
  const goals = store
    .goalsForProject(p.id)
    .filter((g) => g.status !== GoalStatus.dropped);
  const links = store.linksForProject(p.id);
  if (!p.brief && !goals.length && !links.length) return "";
  const mine = goals.find((g) => g.id === task.goal_id);
  return [
    `## The project: ${p.name}`,
    p.brief,
    mine ? `This task works toward ${store.goalRef(mine.id)}: ${mine.title}` : "",
    goals.length
      ? `Project goals:\n${goals.map((g) => `- ${store.goalRef(g.id)} [${g.status}] ${g.title}`).join("\n")}`
      : "",
    ...links.map((l) => `Project doc: ${linkLine(l)}`),
  ]
    .filter(Boolean)
    .join("\n");
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

