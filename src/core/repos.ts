// Which repos aug knows and where they are checked out (github.repos in
// config), and the repo a task works in. The answers a coding start needs
// before it can make a worktree live here.

import { loadConfig, saveConfig } from "./config";
import * as store from "./store";
import type { TaskRow } from "./types";

export class RepoError extends Error {}

// owner/repo, as GitHub names it.
export function checkRepo(repo: string): string {
  const clean = repo.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(clean))
    throw new RepoError(`${clean || "that"} is not owner/repo`);
  return clean;
}

export function repoPath(repo: string | null): string | null {
  if (!repo) return null;
  return loadConfig().github.repos[repo] ?? null;
}

export function mapRepo(repo: string, path: string): void {
  const config = loadConfig();
  saveConfig({
    ...config,
    github: {
      ...config.github,
      repos: { ...config.github.repos, [repo]: path },
    },
  });
}

// A coding task you made yourself has no repo yet: offer its project's repos
// first, then every mapped one.
export function repoChoices(task: TaskRow): string[] {
  const project = task.project_id ? store.getProject(task.project_id) : null;
  const ours = project ? store.projectRepos(project) : [];
  const mapped = Object.keys(loadConfig().github.repos);
  return [...new Set([...ours, ...mapped])];
}

export function setTaskRepo(taskId: number, repo: string): void {
  store.updateTask(taskId, { repo: checkRepo(repo) });
}
