// A task's worktree stays at the commit it was made on, so a guide run after
// the PR was pushed to again would review, and pin notes to, code that is
// gone. Before the guide reads it (and before its review opens again), the
// PR's head is asked of GitHub, fetched with its base, and a clean worktree
// on the PR's branch is brought to it. Nothing uncommitted is ever moved: a
// dirty worktree, one on another branch, or a fetch or read that failed is
// left as it is, and the line says the review may be out of date.

import { errorMessage, logger } from "./log";
import type { PrRef } from "./pr";
import type { PrHead, ReviewSource } from "./plugins";

const log = logger("pr-head");

// A fetch that hangs (a dead network, a credential prompt) gives up here.
const FETCH_TIMEOUT_MS = 60_000;

export interface HeadInput {
  pr: PrRef;
  source: Required<Pick<ReviewSource, "head">>;
  // A PR the owner was asked to review holds no work of theirs, so a
  // force-push may move its worktree to the new history; their own PR's
  // worktree is never rewritten.
  rewrite: boolean;
}

export interface HeadSync {
  // The PR's head as GitHub said, null when it could not be read.
  head: string | null;
  // The worktree's HEAD changed: what was read from it before is old.
  moved: boolean;
  // What the review reads may be behind the PR.
  stale: boolean;
  // One line for the run's steps (and the toast when stale).
  line: string;
}

const short = (sha: string) => sha.slice(0, 7);
const MAY_BE_OLD = "the code reviewed may be out of date";

export async function syncPrHead(opts: {
  cwd: string;
  input: HeadInput;
  // The PR's base, fetched too, so the patch's merge base is not an old one.
  base: string;
  // The branches the worktree may be moved on (the task's, the PR's head).
  branches: (string | null | undefined)[];
}): Promise<HeadSync> {
  const { cwd, input } = opts;
  const { pr } = input;
  let want: PrHead;
  try {
    want = await input.source.head(pr);
  } catch (err) {
    log.warn("pr head not read", { pr: pr.url, err });
    return {
      head: null,
      moved: false,
      stale: true,
      line: `PR head not read (${errorMessage(err)}): ${MAY_BE_OLD}`,
    };
  }
  const git = gitIn(cwd);
  const remote = await remoteFor(git, pr.repo);
  const had = (await git("rev-parse", "HEAD")).out.trim();

  const fetched = await git(
    "fetch",
    "--quiet",
    "--no-tags",
    remote,
    `refs/pull/${pr.number}/head`,
  );
  // The base on its own: one gone (merged and deleted) fails only itself.
  const based = await git("fetch", "--quiet", "--no-tags", remote, opts.base);
  if (!based.ok) {
    log.warn("pr base not fetched", { pr: pr.url, base: opts.base });
  }
  const there = (await git("cat-file", "-e", `${want.oid}^{commit}`)).ok;
  if (!there) {
    const why = fetched.ok
      ? `${short(want.oid)} is not in the fetch`
      : `fetch failed: ${fetched.out.split("\n")[0]}`;
    log.warn("pr head not fetched", { pr: pr.url, why });
    return {
      head: want.oid,
      moved: false,
      stale: true,
      line: `PR head ${short(want.oid)} not fetched (${why}): ${MAY_BE_OLD}`,
    };
  }
  const result = await bringTo(git, input, want, had, opts.branches);
  log.info("pr head", { pr: pr.url, line: result.line });
  return { head: want.oid, ...result };
}

async function bringTo(
  git: Git,
  input: HeadInput,
  want: PrHead,
  had: string,
  branches: (string | null | undefined)[],
): Promise<Omit<HeadSync, "head">> {
  const at = (line: string) => ({ moved: false, stale: false, line });
  const leave = (why: string) => ({
    moved: false,
    stale: true,
    line: `worktree left at ${short(had)}, the PR's head is ${short(want.oid)} (${why}): ${MAY_BE_OLD}`,
  });
  if (had === want.oid) {
    return at(`at the PR's head (${short(want.oid)})`);
  }
  if (await isAncestor(git, want.oid, had)) {
    const ahead = (await git("rev-list", "--count", `${want.oid}..${had}`)).out;
    return at(
      `the worktree is ${ahead.trim()} commit(s) ahead of the PR's head (${short(want.oid)}): not pushed yet`,
    );
  }
  const branch = (await git("symbolic-ref", "--quiet", "--short", "HEAD")).out;
  const on = branch.trim();
  const ours = [...branches, want.branch].filter(Boolean);
  if (on && !ours.includes(on)) {
    return leave(`it is on ${on}, not the PR's branch`);
  }
  const dirty = await git("status", "--porcelain", "--untracked-files=no");
  if (!dirty.ok || dirty.out.trim()) {
    return leave("it has uncommitted changes");
  }
  if (await isAncestor(git, had, want.oid)) {
    const merged = await git("merge", "--ff-only", "--quiet", want.oid);
    if (!merged.ok) {
      return leave(`fast-forward failed: ${merged.out.split("\n")[0]}`);
    }
    return {
      moved: true,
      stale: false,
      line: `brought up to the PR's head ${short(want.oid)} (was ${short(had)})`,
    };
  }
  if (!input.rewrite) {
    return leave("they have diverged");
  }
  // --keep refuses rather than drop a change in the way.
  const reset = await git("reset", "--keep", "--quiet", want.oid);
  if (!reset.ok) {
    return leave(`reset failed: ${reset.out.split("\n")[0]}`);
  }
  return {
    moved: true,
    stale: false,
    line: `the PR's history was rewritten: moved to its head ${short(want.oid)} (was ${short(had)})`,
  };
}

// Whether the PR's head is already in what the notes were written against.
export async function contains(
  cwd: string,
  commit: string,
  head: string,
): Promise<boolean> {
  return commit === head || isAncestor(gitIn(cwd), head, commit);
}

function isAncestor(git: Git, older: string, newer: string): Promise<boolean> {
  return git("merge-base", "--is-ancestor", older, newer).then((r) => r.ok);
}

// The remote that is the PR's repo (a fork's checkout has its upstream
// under another name), else origin. The URLs as configured: `remote -v`
// shows them after insteadOf rewrites them out of GitHub's shape.
async function remoteFor(git: Git, repo: string): Promise<string> {
  const list = await git("config", "--get-regexp", "^remote\\..*\\.url$");
  const want = repo.toLowerCase();
  for (const line of list.out.split("\n")) {
    const m = line.match(
      /^remote\.(.+)\.url\s+\S*github\.com[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i,
    );
    if (m?.[2]?.toLowerCase() === want) {
      return m[1]!;
    }
  }
  return "origin";
}

type Git = (...args: string[]) => Promise<{ ok: boolean; out: string }>;

function gitIn(cwd: string): Git {
  return async (...args) => {
    const proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      timeout: FETCH_TIMEOUT_MS,
      // Never wait on a prompt for credentials nobody is there to type.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return code === 0 ? { ok: true, out } : { ok: false, out: err.trim() };
  };
}
