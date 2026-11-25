// The simulator's repository: a scratch clone of Riker itself, so a PR's diff
// is real code an agent can read. It shares the source's objects (cheap)
// and has no remote, so nothing in it can be pushed. main sits a few
// commits back; each PR branch is one commit after it, laid over main.

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
  // The plain commits after main, newest first: each PR is one of them.
  commits: string[];
  work: { branch: string; path: string };
}

export const WORK_BRANCH = "sim/work";

export function repoRoot(from: string): string {
  return git(from, ["rev-parse", "--show-toplevel"]);
}

export function makeCheckout(source: string, home: string): SimCheckout {
  const path = join(home, "repos", "riker");
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
  run(["checkout", "-q", "-B", "main", `${head}~${depth}`]);
  // Each PR is one plain commit's change (a merge is a whole PR's).
  const commits = run(["rev-list", "--no-merges", `main..${head}`]).split("\n").filter(Boolean);
  const work = join(home, "worktrees", "work");
  run(["worktree", "add", "-q", "-b", WORK_BRANCH, work, head]);
  return {
    path,
    base: "main",
    commits,
    work: { branch: WORK_BRANCH, path: work },
  };
}

// A PR branch is one commit's change laid over main, so its diff is that
// commit's and no more (main sits several commits back; the commit itself
// would carry every one between). `commits` are tried from `from` on, until
// one lays over cleanly; with none, the first is kept as it is.
export function makeBranch(
  checkout: string,
  branch: string,
  commits: string[],
  from: number,
  base = "main",
): void {
  for (let i = 0; i < commits.length; i++) {
    const sha = commits[(from + i) % commits.length]!;
    const merged = Bun.spawnSync(
      ["git", "-C", checkout, "merge-tree", "--write-tree", `--merge-base=${sha}^1`, base, sha],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (merged.exitCode !== 0) continue;
    const tree = merged.stdout.toString().split("\n")[0]!.trim();
    if (tree === git(checkout, ["rev-parse", `${base}^{tree}`])) continue;
    layOver(checkout, branch, sha, tree, base);
    return;
  }
  git(checkout, ["branch", "-f", branch, commits[from % commits.length]!]);
}

function layOver(checkout: string, branch: string, sha: string, tree: string, base: string): void {
  const subject = git(checkout, ["log", "-1", "--format=%s", sha]);
  const commit = git(checkout, [
    "-c",
    "user.name=sim",
    "-c",
    "user.email=sim@riker.invalid",
    "commit-tree",
    tree,
    "-p",
    base,
    "-m",
    subject,
  ]);
  git(checkout, ["branch", "-f", branch, commit]);
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
