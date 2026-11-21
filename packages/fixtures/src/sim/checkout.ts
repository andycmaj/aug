// The simulator's repository: a scratch clone of aug itself, so a PR's diff
// is real code an agent can read. It shares the source's objects (cheap)
// and has no remote, so nothing in it can be pushed. main sits a few
// commits back; each PR branch is one of the commits after it.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

function git(cwd: string, args: string[]): string {
  const proc = Bun.spawnSync(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString().trim()}`);
  return proc.stdout.toString().trim();
}

// How far back main is: the PRs' diffs are these last commits.
const DEPTH = 5;

export interface SimCheckout {
  path: string;
  base: string;
  // First-parent commits after main, newest first.
  commits: string[];
  work: { branch: string; path: string };
}

export const WORK_BRANCH = "sim/work";

export function repoRoot(from: string): string {
  return git(from, ["rev-parse", "--show-toplevel"]);
}

export function makeCheckout(source: string, home: string): SimCheckout {
  const path = join(home, "repos", "aug");
  mkdirSync(dirname(path), { recursive: true });
  const run = (args: string[]) => git(path, args);
  Bun.spawnSync([
    "git",
    "clone",
    "-q",
    "--shared",
    "--no-checkout",
    source,
    path,
  ]);
  if (!existsSync(join(path, ".git")))
    throw new Error(`could not clone ${source}`);
  run(["remote", "remove", "origin"]);
  const head = run(["rev-parse", "HEAD"]);
  const count = Number(run(["rev-list", "--count", "--first-parent", "HEAD"]));
  const depth = Math.max(1, Math.min(DEPTH, count - 1));
  const commits = run([
    "rev-list",
    "--first-parent",
    `-n${depth}`,
    "HEAD",
  ]).split("\n");
  run(["checkout", "-q", "-B", "main", `${head}~${depth}`]);
  const work = join(home, "worktrees", "work");
  run(["worktree", "add", "-q", "-b", WORK_BRANCH, work, head]);
  return {
    path,
    base: "main",
    commits,
    work: { branch: WORK_BRANCH, path: work },
  };
}

export function makeBranch(
  checkout: string,
  branch: string,
  sha: string,
): void {
  git(checkout, ["branch", "-f", branch, sha]);
}

// A worktree on the branch, made once; the branch's own when it has one.
export function worktreeFor(
  checkout: string,
  home: string,
  branch: string,
): string {
  const listed = git(checkout, ["worktree", "list", "--porcelain"]).split(
    "\n\n",
  );
  for (const entry of listed) {
    const lines = entry.split("\n");
    if (lines.includes(`branch refs/heads/${branch}`))
      return lines[0].replace("worktree ", "");
  }
  const path = join(home, "worktrees", branch.replaceAll("/", "-"));
  git(checkout, ["worktree", "add", "-q", path, branch]);
  return path;
}

export interface DiffLines {
  files: string[];
  lines: { path: string; line: number }[];
}

// The new side of each hunk: where a line comment can sit.
export function diffLines(
  checkout: string,
  base: string,
  head: string,
): DiffLines {
  const out = git(checkout, ["diff", "-U0", "--no-color", `${base}...${head}`]);
  const files: string[] = [];
  const lines: DiffLines["lines"] = [];
  let path: string | null = null;
  for (const row of out.split("\n")) {
    if (row.startsWith("+++ ")) {
      path = row === "+++ /dev/null" ? null : row.slice(6);
      if (path) files.push(path);
      continue;
    }
    const hunk = row.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!hunk || !path) continue;
    const start = Number(hunk[1]);
    const size = hunk[2] === undefined ? 1 : Number(hunk[2]);
    for (let i = 0; i < size; i++) lines.push({ path, line: start + i });
  }
  return { files, lines };
}
