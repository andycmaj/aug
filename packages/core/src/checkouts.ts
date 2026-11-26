// What is on disk: whether a path is a git checkout, which GitHub repos its
// remotes name, and the checkouts under a few root folders. Plain fs reads
// of .git, no git process per folder, so a scan of ~/workspace stays cheap.
// Only mux.ts calls this; everything else asks the Mux, which tests fake.

import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export type CheckoutState =
  | { kind: "missing" }
  | { kind: "not-git" }
  // A linked worktree (wt's sibling folders): its main checkout is the one
  // worktrees are made from.
  | { kind: "worktree"; main: string | null }
  // A folder inside a checkout, not its top.
  | { kind: "inside"; root: string }
  // repos: owner/repo of each GitHub remote, origin first, then upstream.
  | { kind: "checkout"; repos: string[] };

export interface FoundCheckout {
  path: string;
  repos: string[];
}

// Folders a scan never enters: they hold no checkouts of the owner's, and
// node_modules alone can be thousands of entries.
const SKIP = new Set([
  "node_modules",
  "Library",
  "vendor",
  "target",
  "dist",
  "build",
]);

// owner/repo from a GitHub remote URL: https, ssh://, scp-style git@host:
// and ssh host aliases (git@github-work:owner/repo) alike.
export function githubRepo(url: string): string | null {
  const clean = url.trim();
  const scheme = clean.match(
    /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i,
  );
  const scp = scheme ? null : clean.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/);
  const m = scheme ?? scp;
  if (!m || !/github/i.test(m[1])) {
    return null;
  }
  const parts = m[2]
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .split("/");
  if (parts.length < 2) {
    return null;
  }
  const [owner, name] = parts.slice(-2);
  return /^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(name)
    ? `${owner}/${name}`
    : null;
}

// The remotes in a git config file, in its order.
export function parseRemotes(config: string): { name: string; url: string }[] {
  const remotes: { name: string; url: string }[] = [];
  let current: string | null = null;
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    const section = line.match(/^\[\s*remote\s+"([^"]+)"\s*\]$/);
    if (section) {
      current = section[1];
      continue;
    }
    if (line.startsWith("[")) {
      current = null;
      continue;
    }
    const url = current ? line.match(/^url\s*=\s*(.+)$/) : null;
    if (url && current) {
      remotes.push({ name: current, url: url[1].trim() });
    }
  }
  return remotes;
}

const RANK: Record<string, number> = { origin: 0, upstream: 1 };

function reposOf(gitDir: string): string[] {
  let text = "";
  try {
    text = readFileSync(join(gitDir, "config"), "utf8");
  } catch {
    return [];
  }
  const ranked = parseRemotes(text)
    .map((r) => ({ rank: RANK[r.name] ?? 2, repo: githubRepo(r.url) }))
    .filter((r): r is { rank: number; repo: string } => r.repo !== null)
    .sort((a, b) => a.rank - b.rank)
    .map((r) => r.repo);
  return [...new Set(ranked)];
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// A .git file points at the real git dir: a linked worktree's lives under
// <main>/.git/worktrees/<name>, a submodule's under .git/modules.
function linkedGitDir(dotGit: string): string | null {
  try {
    const m = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m);
    return m ? resolve(dirname(dotGit), m[1].trim()) : null;
  } catch {
    return null;
  }
}

function mainOfWorktree(gitDir: string): string | null {
  let common = join(gitDir, "..", "..");
  try {
    common = resolve(
      gitDir,
      readFileSync(join(gitDir, "commondir"), "utf8").trim(),
    );
  } catch {
    // no commondir: the usual <main>/.git/worktrees/<name> layout
  }
  return basename(common) === ".git" ? dirname(common) : null;
}

export function inspect(path: string): CheckoutState {
  if (!existsSync(path)) {
    return { kind: "missing" };
  }
  if (!isDir(path)) {
    return { kind: "not-git" };
  }
  const dotGit = join(path, ".git");
  if (isDir(dotGit)) {
    return { kind: "checkout", repos: reposOf(dotGit) };
  }
  if (existsSync(dotGit)) {
    const gitDir = linkedGitDir(dotGit);
    if (!gitDir) {
      return { kind: "not-git" };
    }
    if (basename(dirname(gitDir)) === "worktrees") {
      return { kind: "worktree", main: mainOfWorktree(gitDir) };
    }
    return { kind: "checkout", repos: reposOf(gitDir) };
  }
  for (let up = dirname(path); up !== dirname(up); up = dirname(up)) {
    if (existsSync(join(up, ".git"))) {
      return { kind: "inside", root: up };
    }
  }
  return { kind: "not-git" };
}

// Main checkouts under the roots, `depth` folders down (~/workspace/owner/repo
// is 2). A checkout is not entered, and worktrees are left out: each is a
// branch of a checkout found on its own.
export async function scan(
  roots: string[],
  depth: number,
): Promise<FoundCheckout[]> {
  const found: FoundCheckout[] = [];
  const seen = new Set<string>();
  async function walk(dir: string, left: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP.has(e.name)) {
        continue;
      }
      const path = join(dir, e.name);
      if (seen.has(path)) {
        continue;
      }
      seen.add(path);
      const dotGit = join(path, ".git");
      if (isDir(dotGit)) {
        found.push({ path, repos: reposOf(dotGit) });
      } else if (!existsSync(dotGit) && left > 1) {
        subdirs.push(path);
      }
    }
    await Promise.all(subdirs.map((d) => walk(d, left - 1)));
  }
  await Promise.all(roots.map((r) => walk(r, depth)));
  return found.sort((a, b) => a.path.localeCompare(b.path));
}
