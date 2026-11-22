// Which repos Riker knows and where they are checked out (repos in
// config), and the repo a task works in. The answers a coding start needs
// before it can make a worktree live here: a path is checked (is it there, a
// checkout, its own top, of this repo) before wt ever sees it, and what is
// wrong comes back in words with the checkouts found on disk to pick from.
// Nothing is mapped without the owner picking it.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FoundCheckout } from "./checkouts";
import type { RikerConfig, ConfigSource } from "./config";
import { mux } from "./mux";
import * as store from "./store";
import { TaskStatus, type TaskRow } from "./types";

export class RepoError extends Error {}

// owner/repo, as GitHub names it.
export function checkRepo(repo: string): string {
  const clean = repo.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(clean))
    throw new RepoError(`${clean || "that"} is not owner/repo`);
  return clean;
}

const sameRepo = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function expandHome(path: string): string {
  const clean = path.trim();
  return clean === "~" || clean.startsWith("~/") ? homedir() + clean.slice(1) : clean;
}

export function tildePath(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

export function repoPath(config: RikerConfig, repo: string | null): string | null {
  if (!repo) return null;
  return config.repos[repo] ?? null;
}

// Written through the source, so a start that asked for the path and runs
// again next reads it.
function saveRepos(
  config: ConfigSource,
  change: (repos: Record<string, string>) => Record<string, string>,
): void {
  config.update((c) => ({ ...c, repos: change(c.repos) }));
}

// ── what is wrong with a path ─────────────────────────────────────────────

export type CheckoutProblem =
  | { kind: "unmapped" }
  | { kind: "missing"; path: string }
  | { kind: "not-git"; path: string }
  | { kind: "worktree"; path: string; main: string | null }
  | { kind: "inside"; path: string; root: string }
  // The checkout's remotes name other repos: the first is what to rename to.
  | { kind: "mismatch"; path: string; remotes: string[] };

const anywayKey = (repo: string) => `repo-anyway:${repo}`;

// Null when a worktree of the repo can be made from the path. A checkout
// with no GitHub remote passes: there is nothing to compare.
export function checkPath(repo: string, path: string): CheckoutProblem | null {
  const state = mux().inspectCheckout(path);
  switch (state.kind) {
    case "missing":
    case "not-git":
      return { kind: state.kind, path };
    case "worktree":
      return { kind: "worktree", path, main: state.main };
    case "inside":
      return { kind: "inside", path, root: state.root };
    case "checkout":
      if (state.repos.length === 0 || state.repos.some((r) => sameRepo(r, repo)))
        return null;
      if (store.kvGet(anywayKey(repo)) === path) return null;
      return { kind: "mismatch", path, remotes: state.repos };
  }
}

export function checkMapped(config: RikerConfig, repo: string): CheckoutProblem | null {
  const path = repoPath(config, repo);
  return path ? checkPath(repo, path) : { kind: "unmapped" };
}

export function describeProblem(repo: string, p: CheckoutProblem): string {
  switch (p.kind) {
    case "unmapped":
      return `${repo} has no checkout yet`;
    case "missing":
      return `${tildePath(p.path)} is gone`;
    case "not-git":
      return `${tildePath(p.path)} is not a git checkout`;
    case "worktree":
      return `${tildePath(p.path)} is a worktree${p.main ? ` of ${tildePath(p.main)}` : ""}, not a main checkout`;
    case "inside":
      return `${tildePath(p.path)} is inside the checkout ${tildePath(p.root)}`;
    case "mismatch":
      return `${tildePath(p.path)} is ${p.remotes.join(", ")}, not ${repo}`;
  }
}

// The checkout a problem points at instead: a worktree's main, a subfolder's top.
export function problemFix(p: CheckoutProblem): string | null {
  if (p.kind === "worktree") return p.main;
  if (p.kind === "inside") return p.root;
  return null;
}

// ── discovery ─────────────────────────────────────────────────────────────

const DEFAULT_ROOTS = ["~/workspace", "~/src", "~/code", "~/projects", "~/dev", "~/git"];
// ~/workspace/owner/repo is 2; one more for a group folder.
const SCAN_DEPTH = 3;
const SCAN_TTL_MS = 60_000;

export function repoRoots(config: RikerConfig): string[] {
  return (config.repoRoots ?? DEFAULT_ROOTS)
    .map(expandHome)
    .filter((p) => existsSync(p));
}

// Kept a minute, per Mux (a test's fake never sees another's scan).
let scanned: { by: object; at: number; found: FoundCheckout[] } | null = null;

export async function findCheckouts(config: RikerConfig, fresh = false): Promise<FoundCheckout[]> {
  const by = mux();
  if (!fresh && scanned?.by === by && Date.now() - scanned.at < SCAN_TTL_MS)
    return scanned.found;
  const found = await by.findCheckouts(repoRoots(config), SCAN_DEPTH);
  scanned = { by, at: Date.now(), found };
  return found;
}

export function forgetScan(): void {
  scanned = null;
}

export interface Candidate {
  path: string;
  // Its remotes do not say: only its folder's name matches.
  guess: boolean;
}

// Checkouts of the repo on disk: by remote, then (no GitHub remote) by
// folder name. The one already mapped is left out.
export async function candidates(
  config: RikerConfig,
  repo: string,
  fresh = false,
): Promise<Candidate[]> {
  const found = await findCheckouts(config, fresh);
  const mapped = repoPath(config, repo);
  const name = repo.split("/")[1]?.toLowerCase();
  const byRemote = found
    .filter((f) => f.repos.some((r) => sameRepo(r, repo)))
    .map((f) => ({ path: f.path, guess: false }));
  const byName = found
    .filter((f) => f.repos.length === 0 && f.path.split("/").pop()?.toLowerCase() === name)
    .map((f) => ({ path: f.path, guess: true }));
  return [...byRemote, ...byName].filter((c) => c.path !== mapped);
}

// Where Clone puts it: the first root, as owner/name (the layout
// ~/workspace/andycmaj/aug already has).
export function cloneDest(config: RikerConfig, repo: string): string {
  const root = repoRoots(config)[0] ?? join(homedir(), "workspace");
  return join(root, ...repo.split("/"));
}

// What a coding start asks the owner when the repo's checkout will not do.
export interface PathNeed {
  what: "path";
  repo: string;
  problem: CheckoutProblem;
  candidates: Candidate[];
  clone: string;
}

export async function pathNeed(
  config: RikerConfig,
  repo: string,
  problem: CheckoutProblem,
): Promise<PathNeed> {
  return {
    what: "path",
    repo,
    problem,
    candidates: await candidates(config, repo),
    clone: cloneDest(config, repo),
  };
}

// ── what the owner changes ────────────────────────────────────────────────

// Saved only when worktrees can be made from it. A checkout of another repo
// is saved: the start that follows asks whether to rename or use it anyway.
export function mapRepo(config: ConfigSource, repo: string, path: string): void {
  const clean = checkRepo(repo);
  const full = expandHome(path);
  const problem = checkPath(clean, full);
  if (problem && problem.kind !== "mismatch")
    throw new RepoError(describeProblem(clean, problem));
  saveRepos(config, (repos) => ({ ...repos, [clean]: full }));
}

export function unmapRepo(config: ConfigSource, repo: string): void {
  saveRepos(config, ({ [repo]: _gone, ...rest }) => rest);
}

// The owner's "use it anyway" for a checkout whose remote names another repo.
export function allowMismatch(repo: string, path: string): void {
  store.kvSet(anywayKey(repo), path);
}

// A repo renamed on GitHub (or mistyped): the new name everywhere Riker keeps
// it, the mapping, projects and open tasks. Closed tasks keep the old name
// as history.
export function renameRepo(config: ConfigSource, from: string, to: string): string {
  const next = checkRepo(to);
  if (from === next) return next;
  saveRepos(config, ({ [from]: path, ...rest }) =>
    path === undefined ? rest : { ...rest, [next]: rest[next] ?? path },
  );
  store.batch(() => {
    for (const p of store.listProjects()) {
      const list = store.projectRepos(p);
      if (!list.includes(from)) continue;
      const renamed = [...new Set(list.map((r) => (r === from ? next : r)))];
      store.updateProject(p.id, { repos: JSON.stringify(renamed) });
    }
    for (const t of store.tasksWithRepo(from))
      if (t.status === TaskStatus.open) store.updateTask(t.id, { repo: next });
  });
  return next;
}

export async function cloneRepo(
  config: ConfigSource,
  repo: string,
  dest?: string,
): Promise<string> {
  const clean = checkRepo(repo);
  const target = expandHome(dest ?? cloneDest(config.get(), clean));
  if (existsSync(target)) throw new RepoError(`${tildePath(target)} is already there`);
  await mux().clone(clean, target);
  forgetScan();
  mapRepo(config, clean, target);
  return target;
}

// A coding task you made yourself has no repo yet: offer its project's repos
// first, then every mapped one.
export function repoChoices(config: RikerConfig, task: TaskRow): string[] {
  const project = task.project_id ? store.getProject(task.project_id) : null;
  const ours = project ? store.projectRepos(project) : [];
  const mapped = Object.keys(config.repos);
  return [...new Set([...ours, ...mapped])];
}

export function setTaskRepo(taskId: number, repo: string): void {
  store.updateTask(taskId, { repo: checkRepo(repo) });
}

// ── the whole picture, for the Repos list and riker-tools repos ─────────────

export interface RepoState {
  repo: string;
  path: string | null;
  problem: CheckoutProblem | null;
  projects: string[];
  // Other checkouts of it on disk.
  others: Candidate[];
  clone: string;
}

export interface RepoReport {
  repos: RepoState[];
  // GitHub checkouts on disk whose repo Riker has no path for.
  unmapped: FoundCheckout[];
}

export async function repoReport(config: RikerConfig, fresh = false): Promise<RepoReport> {
  const mapped = config.repos;
  const projectsOf = new Map<string, string[]>();
  for (const p of store.listProjects())
    for (const r of store.projectRepos(p))
      projectsOf.set(r, [...(projectsOf.get(r) ?? []), p.name]);
  const names = [...new Set([...Object.keys(mapped), ...projectsOf.keys()])].sort();
  const found = await findCheckouts(config, fresh);
  const repos = await Promise.all(
    names.map(async (repo) => ({
      repo,
      path: mapped[repo] ?? null,
      problem: checkMapped(config, repo),
      projects: projectsOf.get(repo) ?? [],
      others: await candidates(config, repo),
      clone: cloneDest(config, repo),
    })),
  );
  const known = names.map((n) => n.toLowerCase());
  // The owners of repos Riker already knows come first: likely the owner's own.
  const owners = new Set(known.map((n) => n.split("/")[0]));
  const ownFirst = (f: FoundCheckout) => (owners.has(f.repos[0].split("/")[0].toLowerCase()) ? 0 : 1);
  const unmapped = found
    .filter((f) => f.repos.length > 0 && !f.repos.some((r) => known.includes(r.toLowerCase())))
    .sort((a, b) => ownFirst(a) - ownFirst(b));
  return { repos, unmapped };
}

export function repoStateLine(s: RepoState): string {
  const where = s.path ? tildePath(s.path) : "no path";
  const state = s.problem && s.problem.kind !== "unmapped" ? describeProblem(s.repo, s.problem) : s.path ? "ok" : "";
  const projects = s.projects.length ? ` [${s.projects.join(", ")}]` : "";
  const others = s.others.length
    ? `; also at ${s.others.map((c) => `${tildePath(c.path)}${c.guess ? " (no remote)" : ""}`).join(", ")}`
    : "";
  return `${s.repo}  ${where}${state ? `  ${state}` : ""}${projects}${others}`;
}

export function reportText(r: RepoReport): string {
  const lines = r.repos.map(repoStateLine);
  if (lines.length === 0) lines.push("no repos");
  if (r.unmapped.length) {
    lines.push("", "On disk, not mapped:");
    for (const f of r.unmapped) lines.push(`${f.repos[0]}  ${tildePath(f.path)}`);
  }
  return lines.join("\n");
}
