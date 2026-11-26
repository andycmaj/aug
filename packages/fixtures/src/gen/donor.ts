// Where the generator's changes come from: real commits of a donor repo
// (Riker's own history), replayed in order after the commit the lab repo
// was seeded from, so each PR's diff reads like the commit it was.

import type { Change } from "./target";

function git(cwd: string, args: string[]): string {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args[0]}: ${r.stderr.toString().trim()}`);
  }
  return r.stdout.toString();
}

// A commit too big to read as one review, or one with binary files, is
// passed over.
const MAX_FILES = 25;
const MAX_BYTES = 200_000;

// The donor's commits after `seed`, oldest first, merges left out.
export function donorCommits(
  repo: string,
  seed: string,
  ref = "HEAD",
): string[] {
  return git(repo, ["rev-list", "--reverse", "--no-merges", `${seed}..${ref}`])
    .split("\n")
    .filter(Boolean);
}

export function changeOf(repo: string, sha: string): Change | null {
  const numstat = git(repo, [
    "show",
    "--numstat",
    "--format=",
    "--no-renames",
    sha,
  ])
    .split("\n")
    .filter(Boolean);
  if (numstat.length === 0 || numstat.length > MAX_FILES) {
    return null;
  }
  if (numstat.some((l) => l.startsWith("-\t-\t"))) {
    return null;
  }
  const files = git(repo, [
    "show",
    "--name-status",
    "--format=",
    "--no-renames",
    sha,
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, path] = line.split("\t") as [string, string];
      return {
        path,
        content: status === "D" ? null : git(repo, ["show", `${sha}:${path}`]),
      };
    });
  if (files.some((f) => (f.content?.length ?? 0) > MAX_BYTES)) {
    return null;
  }
  const [subject, ...rest] = git(repo, ["show", "-s", "--format=%B", sha])
    .trim()
    .split("\n");
  const body = rest
    .filter((l) => !/^Co-Authored-By:/i.test(l))
    .join("\n")
    .trim();
  return {
    title: subject!.slice(0, 120),
    body: `${body}\n\nReplayed from ${sha.slice(0, 7)} by the review activity generator.`.trim(),
    files,
    source: `commit ${sha.slice(0, 7)}`,
  };
}

// The next replayable commit from `cursor` on, and where to read from next.
export function nextChange(
  repo: string,
  commits: string[],
  cursor: number,
): { change: Change; cursor: number } | null {
  for (let i = cursor; i < commits.length; i++) {
    const change = changeOf(repo, commits[i]!);
    if (change) {
      return { change, cursor: i + 1 };
    }
  }
  return null;
}
