import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { githubRepo, inspect, parseRemotes, scan } from "../src/checkouts";

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "ignore",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  }
}

function checkout(path: string, remotes: Record<string, string> = {}): string {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  for (const [name, url] of Object.entries(remotes)) {
    git(path, "remote", "add", name, url);
  }
  return path;
}

describe("remote URLs", () => {
  test("every GitHub form names owner/repo; other hosts name nothing", () => {
    expect(githubRepo("https://github.com/andycmaj/aug.git")).toBe(
      "andycmaj/aug",
    );
    expect(githubRepo("https://github.com/andycmaj/codediff.nvim")).toBe(
      "andycmaj/codediff.nvim",
    );
    expect(githubRepo("git@github.com:andycmaj/botany")).toBe(
      "andycmaj/botany",
    );
    expect(githubRepo("ssh://git@github.com:22/acme/api.git/")).toBe(
      "acme/api",
    );
    expect(githubRepo("git@github-work:acme/api.git")).toBe("acme/api");
    expect(githubRepo("https://user:tok@github.com/acme/api")).toBe("acme/api");
    expect(githubRepo("https://gitlab.com/acme/api.git")).toBeNull();
    expect(githubRepo("/srv/git/api.git")).toBeNull();
  });

  test("remotes come out of a git config in order", () => {
    const config = [
      "[core]",
      "\tbare = false",
      '[remote "upstream"]',
      "\turl = git@github.com:acme/api.git",
      "\tfetch = +refs/heads/*:refs/remotes/upstream/*",
      '[branch "main"]',
      "\tremote = origin",
      '[remote "origin"]',
      "\turl = https://github.com/me/api",
    ].join("\n");
    expect(parseRemotes(config)).toEqual([
      { name: "upstream", url: "git@github.com:acme/api.git" },
      { name: "origin", url: "https://github.com/me/api" },
    ]);
  });
});

describe("on disk", () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "riker-checkouts-")));
    checkout(join(root, "acme", "api"), {
      upstream: "git@github.com:acme/api.git",
      origin: "https://github.com/me/api.git",
    });
    git(
      join(root, "acme", "api"),
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "first",
    );
    git(
      join(root, "acme", "api"),
      "worktree",
      "add",
      "-q",
      join(root, "acme", "api.fix"),
      "-b",
      "fix",
    );
    checkout(join(root, "acme", "web"), { origin: "git@github.com:acme/web" });
    mkdirSync(join(root, "acme", "web", "packages", "ui"), { recursive: true });
    checkout(join(root, "solo"));
    mkdirSync(join(root, "plain"));
    writeFileSync(join(root, "notes.txt"), "");
    checkout(join(root, "acme", "web", "node_modules", "dep"), {
      origin: "https://github.com/x/dep",
    });
    checkout(join(root, "deep", "a", "b", "c"), {
      origin: "https://github.com/x/deep",
    });
  });

  test("a checkout names its GitHub repos, origin first", () => {
    expect(inspect(join(root, "acme", "api"))).toEqual({
      kind: "checkout",
      repos: ["me/api", "acme/api"],
    });
    expect(inspect(join(root, "solo"))).toEqual({
      kind: "checkout",
      repos: [],
    });
  });

  test("a worktree points at its main checkout; a subfolder at its top", () => {
    expect(inspect(join(root, "acme", "api.fix"))).toEqual({
      kind: "worktree",
      main: join(root, "acme", "api"),
    });
    expect(inspect(join(root, "acme", "web", "packages", "ui"))).toEqual({
      kind: "inside",
      root: join(root, "acme", "web"),
    });
  });

  test("gone and not-git are told apart", () => {
    expect(inspect(join(root, "nope"))).toEqual({ kind: "missing" });
    expect(inspect(join(root, "plain"))).toEqual({ kind: "not-git" });
    expect(inspect(join(root, "notes.txt"))).toEqual({ kind: "not-git" });
  });

  test("a scan finds main checkouts only, depth folders down", async () => {
    const found = await scan([root], 3);
    expect(found).toEqual([
      { path: join(root, "acme", "api"), repos: ["me/api", "acme/api"] },
      { path: join(root, "acme", "web"), repos: ["acme/web"] },
      { path: join(root, "solo"), repos: [] },
    ]);
    const deeper = await scan([root], 4);
    expect(deeper.map((f) => f.path)).toContain(
      join(root, "deep", "a", "b", "c"),
    );
  });
});
