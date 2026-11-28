// The guide reads the PR as pushed, not as its worktree was made: a real
// "GitHub" (a bare repo with refs/pull/40/head), a checkout of it, and the
// task's worktree on the PR's branch, left behind while the author pushes.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readFindings,
  setGuideTool,
} from "@riker/code-review-plannotator/guide";
import { ANSWER, sh } from "@riker/code-review-plannotator/test/support/repo";
import { setBrain, type BrainResult } from "../src/brain";
import { Engine } from "../src/engine";
import { paths } from "../src/paths";
import type { PrHead, ReviewSource } from "../src/plugins";
import { REVIEW_LINK_BY, REVIEW_LINK_TITLE } from "../src/pr";
import { syncPrHead, type HeadInput } from "../src/pr-head";
import { setMux } from "../src/mux";
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

// GitHub (bare, with the PR's ref), the author's clone that pushes to it,
// and the owner's worktree checked out on the PR's branch.
function world() {
  const root = mkdtempSync(join(tmpdir(), "riker-pr-head-"));
  const hub = join(root, "hub.git");
  const author = join(root, "author");
  const mine = join(root, "mine");
  sh(root, "git", "init", "-q", "--bare", "-b", "main", hub);
  sh(root, "git", "clone", "-q", hub, author);
  writeFileSync(
    join(author, "math.ts"),
    "export function add(a: number, b: number) {\n  return a + b;\n}\n",
  );
  git(author, "add", ".");
  git(author, "commit", "-qm", "base");
  git(author, "push", "-q", "origin", "main");
  git(author, "checkout", "-qb", "feature");
  writeFileSync(
    join(author, "math.ts"),
    "export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport function div(a: number, b: number) {\n  return a / b;\n}\n",
  );
  git(author, "commit", "-qam", "div");
  const push = () => {
    git(author, "push", "-q", "-f", "origin", "feature");
    git(author, "push", "-q", "-f", "origin", "feature:refs/pull/40/head");
    return git(author, "rev-parse", "HEAD");
  };
  const first = push();
  sh(root, "git", "clone", "-q", hub, mine);
  git(mine, "checkout", "-q", "feature");
  return {
    hub,
    author,
    mine,
    first,
    push,
    // The author pushes one more commit to the PR.
    more(
      file = "mul.ts",
      text = "export const mul = (a: number, b: number) => a * b;\n",
    ) {
      writeFileSync(join(author, file), text);
      git(author, "add", ".");
      git(author, "commit", "-qm", file);
      return push();
    },
  };
}

// What GitHub says the PR's head is: the hub's ref, read as gh would.
function hubHead(hub: string): HeadInput["source"] {
  return {
    head: async (): Promise<PrHead> => ({
      oid: sh(hub, "git", "rev-parse", "refs/pull/40/head").trim(),
      branch: "feature",
    }),
  };
}

const input = (source: HeadInput["source"], rewrite = false): HeadInput => ({
  pr,
  source,
  rewrite,
});

describe("bringing a worktree to the PR's head", () => {
  test("behind and clean: fast-forwarded to the head, its base fetched too", async () => {
    const w = world();
    const head = w.more();
    // main moves on GitHub too: the patch's merge base should see it.
    git(w.author, "checkout", "-q", "main");
    writeFileSync(join(w.author, "notes.md"), "main moved\n");
    git(w.author, "add", ".");
    git(w.author, "commit", "-qm", "main moved");
    git(w.author, "push", "-q", "origin", "main");
    const mainTip = git(w.author, "rev-parse", "HEAD");

    const synced = await syncPrHead({
      cwd: w.mine,
      input: input(hubHead(w.hub)),
      base: "main",
      branches: ["feature"],
    });
    expect(synced).toEqual({
      head,
      moved: true,
      stale: false,
      line: `brought up to the PR's head ${head.slice(0, 7)} (was ${w.first.slice(0, 7)})`,
    });
    expect(git(w.mine, "rev-parse", "HEAD")).toBe(head);
    expect(git(w.mine, "symbolic-ref", "--short", "HEAD")).toBe("feature");
    expect(existsSync(join(w.mine, "mul.ts"))).toBe(true);
    expect(git(w.mine, "rev-parse", "origin/main")).toBe(mainTip);
  });

  test("already at the head: nothing moves", async () => {
    const w = world();
    const synced = await syncPrHead({
      cwd: w.mine,
      input: input(hubHead(w.hub)),
      base: "main",
      branches: ["feature"],
    });
    expect(synced).toMatchObject({ moved: false, stale: false });
    expect(synced.line).toBe(`at the PR's head (${w.first.slice(0, 7)})`);
  });

  test("uncommitted changes: the worktree is not moved, nothing is lost, and it says the review may be old", async () => {
    const w = world();
    const head = w.more();
    writeFileSync(join(w.mine, "math.ts"), "// my edit\n");
    const synced = await syncPrHead({
      cwd: w.mine,
      input: input(hubHead(w.hub)),
      base: "main",
      branches: ["feature"],
    });
    expect(synced).toMatchObject({ head, moved: false, stale: true });
    expect(synced.line).toBe(
      `worktree left at ${w.first.slice(0, 7)}, the PR's head is ${head.slice(0, 7)} (it has uncommitted changes): the code reviewed may be out of date`,
    );
    expect(git(w.mine, "rev-parse", "HEAD")).toBe(w.first);
    expect(readFileSync(join(w.mine, "math.ts"), "utf8")).toBe("// my edit\n");
  });

  test("local commits not pushed yet: left alone, not out of date", async () => {
    const w = world();
    writeFileSync(join(w.mine, "wip.ts"), "export {};\n");
    git(w.mine, "add", ".");
    git(w.mine, "commit", "-qm", "wip");
    const local = git(w.mine, "rev-parse", "HEAD");
    const synced = await syncPrHead({
      cwd: w.mine,
      input: input(hubHead(w.hub)),
      base: "main",
      branches: ["feature"],
    });
    expect(synced).toMatchObject({ moved: false, stale: false });
    expect(synced.line).toContain("1 commit(s) ahead of the PR's head");
    expect(git(w.mine, "rev-parse", "HEAD")).toBe(local);
  });

  test("on some other branch: never moved", async () => {
    const w = world();
    w.more();
    git(w.mine, "checkout", "-q", "main");
    const before = git(w.mine, "rev-parse", "HEAD");
    const synced = await syncPrHead({
      cwd: w.mine,
      input: input(hubHead(w.hub)),
      base: "main",
      branches: ["feature"],
    });
    expect(synced).toMatchObject({ moved: false, stale: true });
    expect(synced.line).toContain("it is on main, not the PR's branch");
    expect(git(w.mine, "rev-parse", "HEAD")).toBe(before);
  });

  test("a force-push: a review asked of the owner moves to the new history; their own work is left", async () => {
    const w = world();
    git(w.author, "commit", "-q", "--amend", "-m", "div, reworded");
    const rewritten = w.push();

    const own = await syncPrHead({
      cwd: w.mine,
      input: input(hubHead(w.hub), false),
      base: "main",
      branches: ["feature"],
    });
    expect(own).toMatchObject({ moved: false, stale: true });
    expect(own.line).toContain("(they have diverged)");
    expect(git(w.mine, "rev-parse", "HEAD")).toBe(w.first);

    const asked = await syncPrHead({
      cwd: w.mine,
      input: input(hubHead(w.hub), true),
      base: "main",
      branches: ["feature"],
    });
    expect(asked).toMatchObject({ head: rewritten, moved: true, stale: false });
    expect(asked.line).toContain("the PR's history was rewritten");
    expect(git(w.mine, "rev-parse", "HEAD")).toBe(rewritten);
  });

  test("GitHub not answering: carries on as is, and says the code may be out of date", async () => {
    const w = world();
    w.more();
    const synced = await syncPrHead({
      cwd: w.mine,
      input: input({
        head: async () => {
          throw new Error("rate limited until 14:05");
        },
      }),
      base: "main",
      branches: ["feature"],
    });
    expect(synced).toEqual({
      head: null,
      moved: false,
      stale: true,
      line: "PR head not read (rate limited until 14:05): the code reviewed may be out of date",
    });
    expect(git(w.mine, "rev-parse", "HEAD")).toBe(w.first);
  });

  test("a fetch that fails: carries on as is, and says so", async () => {
    const w = world();
    const head = w.more();
    git(w.mine, "remote", "set-url", "origin", join(w.hub, "..", "gone.git"));
    const synced = await syncPrHead({
      cwd: w.mine,
      input: input(hubHead(w.hub)),
      base: "main",
      branches: ["feature"],
    });
    expect(synced).toMatchObject({ head, moved: false, stale: true });
    expect(synced.line).toStartWith(
      `PR head ${head.slice(0, 7)} not fetched (fetch failed:`,
    );
    expect(synced.line).toEndWith("the code reviewed may be out of date");
    expect(git(w.mine, "rev-parse", "HEAD")).toBe(w.first);
  });

  test("fetches from the remote that is the PR's repo, not a fork's origin", async () => {
    const w = world();
    const head = w.more();
    // origin is the owner's fork (gone here); upstream is acme/api.
    git(w.mine, "remote", "rename", "origin", "upstream");
    git(w.mine, "remote", "add", "origin", join(w.hub, "..", "fork.git"));
    git(
      w.mine,
      "config",
      "url." + w.hub + ".insteadOf",
      "git@github.com:acme/api.git",
    );
    git(w.mine, "remote", "set-url", "upstream", "git@github.com:acme/api.git");
    const synced = await syncPrHead({
      cwd: w.mine,
      input: input(hubHead(w.hub)),
      base: "main",
      branches: ["feature"],
    });
    expect(synced).toMatchObject({ head, moved: true });
  });
});

// The whole guide on a PR whose worktree was made before its last push.
describe("the guide on a PR pushed to since its worktree was made", () => {
  let prompts: string[];
  let w: ReturnType<typeof world>;

  beforeEach(() => {
    freshHome({ autostart: false });
    setMux(new FakeMux());
    w = world();
    prompts = [];
    setBrain(async (req): Promise<BrainResult> => {
      prompts.push(req.prompt);
      return {
        text: `\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``,
        structured: null,
        sessionId: null,
        durationMs: 1,
        isError: false,
      };
    });
    setGuideTool({ save: async () => ({ id: "1795-add-div" }) });
  });
  afterEach(() => setGuideTool(null));

  function asked(head: ReviewSource["head"]) {
    const source: ReviewSource = {
      context: async () => ({ text: "PR words", lastReviewed: null }),
      ...(head ? { head } : {}),
    };
    const engine = new Engine({
      config: testConfig(),
      plugins: [{ name: "gh", reviews: source }],
    });
    const t = engine.desk.newTask("Review acme/api#40", Kind.coding);
    store.updateTask(t.id, {
      repo: "acme/api",
      branch: "feature",
      worktree: w.mine,
      url: pr.url,
    });
    store.addTaskLink(t.id, pr.url, REVIEW_LINK_TITLE, REVIEW_LINK_BY);
    return { engine, task: store.getTask(t.id)! };
  }

  async function guide(engine: Engine, taskId: number) {
    const started = engine.desk.runAction(taskId, "guide");
    if ("error" in started) {
      throw new Error(started.error);
    }
    const result = await started.done;
    const turn = store
      .turnsForTask(taskId)
      .filter((t) => t.role === TurnRole.action)
      .at(-1)!;
    return { result, turn };
  }

  test("reviews the PR's head, and keeps that commit with its findings", async () => {
    const head = w.more();
    const { engine, task } = asked(hubHead(w.hub).head);
    const { result, turn } = await guide(engine, task.id);
    expect(result.ok).toBe(true);
    // The commit pushed after the worktree was made is what it read.
    expect(prompts[0]).toContain("export const mul");
    expect(turn.steps).toContain(
      `brought up to the PR's head ${head.slice(0, 7)} (was ${w.first.slice(0, 7)})`,
    );
    expect(turn.body).not.toContain("Warning");
    expect(readFindings(paths.work(task.id))!.head).toBe(head);
  });

  test("with no source that can tell the head (the sim): the worktree as it is, nothing said", async () => {
    w.more();
    const { engine, task } = asked(undefined);
    const { turn } = await guide(engine, task.id);
    expect(prompts[0]).not.toContain("export const mul");
    expect(turn.steps ?? "").not.toContain("PR's head");
    expect(readFindings(paths.work(task.id))!.head).toBe(w.first);
  });

  test("GitHub failing: the guide still runs, on the worktree, and its turn and toast say it may be old", async () => {
    w.more();
    const { engine, task } = asked(async () => {
      throw new Error("rate limited until 14:05");
    });
    const { result, turn } = await guide(engine, task.id);
    expect(result.ok).toBe(true);
    expect(prompts[0]).not.toContain("export const mul");
    const line =
      "PR head not read (rate limited until 14:05): the code reviewed may be out of date";
    expect(turn.steps).toContain(line);
    expect(turn.body).toContain(`Warning: ${line}.`);
    expect(result.text).toContain(line);
  });

  test("reopened after the PR moved on: its notes are left out as outdated, and the worktree is brought up", async () => {
    const { engine, task } = asked(hubHead(w.hub).head);
    const { result } = await guide(engine, task.id);
    expect(result.terminal!.comments!.list.length).toBeGreaterThan(0);

    const head = w.more();
    const again = await engine.desk.guideReview(task.id);
    if ("error" in again) {
      throw new Error(again.error);
    }
    expect(again.terminal!.comments!.list).toEqual([]);
    expect(again.text).toBe(
      `Add div: opening Plannotator without its 2 notes: the PR moved on since the guide (${w.first.slice(0, 7)} → ${head.slice(0, 7)}), run the guide again for notes on the code as it is`,
    );
    expect(git(w.mine, "rev-parse", "HEAD")).toBe(head);

    // Run again, the guide is written against the new head, and reopens
    // with its notes.
    await guide(engine, task.id);
    const fresh = await engine.desk.guideReview(task.id);
    if ("error" in fresh) {
      throw new Error(fresh.error);
    }
    expect(fresh.terminal!.comments!.list.length).toBeGreaterThan(0);
    expect(readFindings(paths.work(task.id))!.head).toBe(head);
  });

  test("reopened with the PR unchanged: its notes as before", async () => {
    const { engine, task } = asked(hubHead(w.hub).head);
    const { result } = await guide(engine, task.id);
    const again = await engine.desk.guideReview(task.id);
    if ("error" in again) {
      throw new Error(again.error);
    }
    expect(again.terminal!.comments!.list).toEqual(
      result.terminal!.comments!.list,
    );
    expect(again.text).toBe("Add div: opening Plannotator");
  });

  test("reopened with GitHub failing: its notes as saved, and it says the code may be old", async () => {
    let fail = false;
    const { engine, task } = asked(async (p) => {
      if (fail) {
        throw new Error("offline");
      }
      return hubHead(w.hub).head(p);
    });
    await guide(engine, task.id);
    fail = true;
    const again = await engine.desk.guideReview(task.id);
    if ("error" in again) {
      throw new Error(again.error);
    }
    expect(again.terminal!.comments!.list.length).toBeGreaterThan(0);
    expect(again.text).toBe(
      "Add div: opening Plannotator (PR head not read (offline): the code reviewed may be out of date)",
    );
  });
});
