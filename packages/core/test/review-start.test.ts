// Starting the agent on a PR asked of the owner: wt makes its worktree from
// the refs on disk and fetches nothing, so a checkout that last fetched when
// the PR's branch was new (still at main) gave a worktree with no change at
// all. A real "GitHub" (a bare repo with refs/pull/40/head), the owner's
// clone of it, and a mux whose worktree is `git worktree add` from
// origin/<branch>, as wt does.

import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchFor } from "@riker/code-review-plannotator/guide";
import { sh } from "@riker/code-review-plannotator/test/support/repo";
import { Engine } from "../src/engine";
import type { MadeWorktree, Worktree } from "../src/mux";
import { setMux } from "../src/mux";
import type { PrHead, ReviewSource } from "../src/plugins";
import { REVIEW_LINK_BY, REVIEW_LINK_TITLE } from "../src/pr";
import * as store from "../src/store";
import { Kind, TurnRole } from "../src/types";
import { FakeMux } from "./support/fake-mux";
import { freshHome, testConfig } from "./support/helpers";

const pr = {
  repo: "acme/api",
  number: 40,
  url: "https://github.com/acme/api/pull/40",
};

const git = (cwd: string, ...a: string[]) =>
  sh(cwd, "git", "-c", "user.email=t@t", "-c", "user.name=t", ...a).trim();
const short = (sha: string) => sha.slice(0, 7);

// The author opens the branch at main and pushes it, the owner's clone
// fetches then, and only after that does the author push the PR's commit.
function world() {
  const root = mkdtempSync(join(tmpdir(), "riker-review-start-"));
  const hub = join(root, "hub.git");
  const author = join(root, "author");
  const mine = join(root, "mine");
  sh(root, "git", "init", "-q", "--bare", "-b", "main", hub);
  sh(root, "git", "clone", "-q", hub, author);
  writeFileSync(join(author, "math.ts"), "export const add = 1;\n");
  git(author, "add", ".");
  git(author, "commit", "-qm", "base");
  git(author, "push", "-q", "origin", "main");
  git(author, "checkout", "-qb", "feature");
  git(author, "push", "-q", "origin", "feature");
  sh(root, "git", "clone", "-q", hub, mine);
  writeFileSync(join(author, "div.ts"), "export const div = 2;\n");
  git(author, "add", ".");
  git(author, "commit", "-qm", "div");
  git(author, "push", "-q", "origin", "feature");
  git(author, "push", "-q", "origin", "feature:refs/pull/40/head");
  return {
    root,
    hub,
    mine,
    base: git(mine, "rev-parse", "origin/main"),
    head: git(author, "rev-parse", "HEAD"),
    author,
  };
}

// wt switch pr:40: the PR's branch, made from origin/feature as it is on
// disk, with no fetch.
class GitWorktrees extends FakeMux {
  made: { path: string; empty: boolean }[] = [];
  override async worktree(w: Worktree): Promise<MadeWorktree> {
    const branch = w.branch === "pr:40" ? "feature" : w.branch;
    const path = `${w.repoPath}.${branch}`;
    git(
      w.repoPath,
      "worktree",
      "add",
      "-q",
      "-b",
      branch,
      path,
      `origin/${branch}`,
    );
    const patch = patchFor(path, "main");
    this.made.push({ path, empty: "error" in patch });
    this.worktrees.push({ ...w, path });
    this.checkouts.set(path, { kind: "worktree", main: w.repoPath });
    return { path, branch };
  }
}

let w: ReturnType<typeof world>;
let mux: GitWorktrees;

beforeEach(() => {
  w = world();
  freshHome({ autostart: false, repos: { "acme/api": w.mine } });
  mux = new GitWorktrees();
  mux.checkouts.set(w.mine, { kind: "checkout", repos: ["acme/api"] });
  setMux(mux);
});

// What GitHub says the PR's head is: the hub's ref.
const hubHead = async (): Promise<PrHead> => ({
  oid: sh(w.hub, "git", "rev-parse", "refs/pull/40/head").trim(),
  branch: "feature",
});

function asked(head: ReviewSource["head"] | undefined, reviewed = true) {
  const source: ReviewSource = {
    context: async () => ({ text: "PR words", lastReviewed: null }),
    ...(head ? { head } : {}),
  };
  const engine = new Engine({
    config: testConfig(),
    plugins: [{ name: "gh", reviews: source }],
  });
  const t = engine.desk.newTask("Review acme/api#40", Kind.coding);
  store.updateTask(t.id, { repo: "acme/api", branch: "pr:40", url: pr.url });
  if (reviewed) {
    store.addTaskLink(t.id, pr.url, REVIEW_LINK_TITLE, REVIEW_LINK_BY);
  }
  return { engine, task: store.getTask(t.id)! };
}

const triggers = (taskId: number) =>
  store
    .turnsForTask(taskId)
    .filter((t) => t.role === TurnRole.trigger)
    .map((t) => t.body);

const worktree = () => `${w.mine}.feature`;

describe("starting the agent on a PR asked of the owner", () => {
  test("a worktree made from a stale origin/<branch> is brought to the PR's head, with its base fetched", async () => {
    // main moves on GitHub after the owner's last fetch.
    git(w.author, "checkout", "-q", "main");
    writeFileSync(join(w.author, "notes.md"), "main moved\n");
    git(w.author, "add", ".");
    git(w.author, "commit", "-qm", "main moved");
    git(w.author, "push", "-q", "origin", "main");
    const mainTip = git(w.author, "rev-parse", "HEAD");

    const { engine, task } = asked(hubHead);
    const started = await engine.desk.startAgent(task.id, { branch: "pr:40" });

    // As wt made it, the worktree had nothing to review: the bug.
    expect(mux.made).toEqual([{ path: worktree(), empty: true }]);
    expect(started).toMatchObject({ type: "started" });
    expect(started).not.toHaveProperty("warning");
    expect(git(worktree(), "rev-parse", "HEAD")).toBe(w.head);
    expect(git(worktree(), "symbolic-ref", "--short", "HEAD")).toBe("feature");
    expect(git(w.mine, "rev-parse", "origin/main")).toBe(mainTip);
    const patch = patchFor(worktree(), "main");
    if ("error" in patch) {
      throw new Error(patch.error);
    }
    expect(patch.text).toContain("div.ts");
    expect(patch.text).not.toContain("notes.md");
    expect(triggers(task.id)).toContain(
      `Before the review started: brought up to the PR's head ${short(w.head)} (was ${short(w.base)}).`,
    );
  });

  test("the fetch failing: it starts anyway, on the worktree as it is, and says the diff may be out of date", async () => {
    sh(w.mine, "git", "remote", "set-url", "origin", join(w.root, "gone.git"));
    const { engine, task } = asked(hubHead);
    const started = await engine.desk.startAgent(task.id, { branch: "pr:40" });

    expect(started.type).toBe("started");
    expect(git(worktree(), "rev-parse", "HEAD")).toBe(w.base);
    const notFetched = `PR head ${short(w.head)} not fetched (fetch failed:`;
    const warning = started.type === "started" ? started.warning : undefined;
    expect(warning).toStartWith(
      "nothing to review: the worktree shows no change against main after fetching (",
    );
    expect(warning).toContain(notFetched);
    expect(warning).toEndWith("the code reviewed may be out of date)");
    const said = triggers(task.id).find((b) => b.startsWith("Before"));
    expect(said).toContain(notFetched);
    expect(said).toContain("no change against main after fetching");
  });

  test("GitHub not answering: it starts, and says the code may be out of date", async () => {
    const { engine, task } = asked(async () => {
      throw new Error("rate limited until 14:05");
    });
    const started = await engine.desk.startAgent(task.id, { branch: "pr:40" });
    expect(started.type).toBe("started");
    expect(started.type === "started" && started.warning).toContain(
      "PR head not read (rate limited until 14:05): the code reviewed may be out of date",
    );
  });

  test("uncommitted changes in the worktree are never touched", async () => {
    const { engine, task } = asked(hubHead);
    git(
      w.mine,
      "worktree",
      "add",
      "-q",
      "-b",
      "feature",
      worktree(),
      "origin/feature",
    );
    writeFileSync(join(worktree(), "math.ts"), "export const add = 3;\n");
    mux.checkouts.set(worktree(), { kind: "worktree", main: w.mine });
    store.updateTask(task.id, { branch: "feature", worktree: worktree() });

    const started = await engine.desk.startAgent(task.id);
    expect(started.type).toBe("started");
    expect(git(worktree(), "rev-parse", "HEAD")).toBe(w.base);
    expect(git(worktree(), "status", "--porcelain")).toBe("M math.ts");
    expect(started.type === "started" && started.warning).toBe(
      `worktree left at ${short(w.base)}, the PR's head is ${short(w.head)} (it has uncommitted changes): the code reviewed may be out of date`,
    );
  });

  test("a PR with nothing in it after fetching: it says so plainly", async () => {
    git(w.author, "push", "-q", "-f", "origin", `${w.base}:refs/pull/40/head`);
    git(w.author, "push", "-q", "-f", "origin", `${w.base}:feature`);
    const { engine, task } = asked(hubHead);
    const started = await engine.desk.startAgent(task.id, { branch: "pr:40" });
    expect(started.type === "started" && started.warning).toBe(
      "nothing to review: the worktree shows no change against main after fetching",
    );
    expect(triggers(task.id)).toContain(
      `Before the review started: at the PR's head (${short(w.base)}); the worktree shows no change against main after fetching.`,
    );
  });

  test("the owner's own work, or a source that cannot read the head (the sim): no fetch, nothing said", async () => {
    for (const [head, reviewed] of [
      [hubHead, false],
      [undefined, true],
    ] as const) {
      const { engine, task } = asked(head, reviewed);
      const started = await engine.desk.startAgent(task.id, {
        branch: "pr:40",
      });
      expect(started).toMatchObject({ type: "started" });
      expect(started).not.toHaveProperty("warning");
      expect(git(worktree(), "rev-parse", "HEAD")).toBe(w.base);
      expect(triggers(task.id).some((b) => b.startsWith("Before"))).toBe(false);
      await engine.desk.close(task.id);
      git(w.mine, "worktree", "remove", "--force", worktree());
      git(w.mine, "branch", "-q", "-D", "feature");
    }
    expect(existsSync(worktree())).toBe(false);
  });
});
