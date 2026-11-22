import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { Lane, laneOf } from "../src/lanes";
import { checkMerges } from "../src/merge";
import { setMux, TmuxMux } from "../src/mux";
import * as store from "../src/store";
import { Kind, TaskStatus, TurnRole } from "../src/types";
import { FakeMux } from "./support/fake-mux";
import { config, freshHome } from "./support/helpers";

let fake: FakeMux;

beforeEach(() => {
  freshHome({ github: { ...DEFAULT_CONFIG.github, repos: { "acme/api": "/src/api" } } });
  fake = new FakeMux();
  setMux(fake);
});

function branchTask(branch = "fix-export") {
  const t = store.createTask({ title: "Fix export", kind: Kind.coding, channel: "owner", repo: "acme/api", branch });
  return t.id;
}

const triggers = (id: number) =>
  store.turnsForTask(id).filter((t) => t.role === TurnRole.trigger).map((t) => t.body);

describe("merged", () => {
  test("a branch merged by hand marks the task merged, once, and it is not done", async () => {
    const id = branchTask();
    fake.merged.set("fix-export", false);
    expect(await checkMerges(config())).toBe(0);
    fake.merged.set("fix-export", "main");
    expect(await checkMerges(config())).toBe(1);
    expect(await checkMerges(config())).toBe(0);
    const task = store.getTask(id)!;
    expect(task.merged_at).not.toBeNull();
    expect(task.status).toBe(TaskStatus.open);
    expect(laneOf(task, { hasPendingAction: false })).toBe(Lane.merged);
    expect(triggers(id).at(-1)).toContain("Merged into main");
  });

  test("new work on its branch undoes it; git that cannot say changes nothing", async () => {
    const id = branchTask();
    fake.merged.set("fix-export", "main");
    await checkMerges(config());
    fake.merged.delete("fix-export");
    expect(await checkMerges(config())).toBe(0);
    expect(store.getTask(id)!.merged_at).not.toBeNull();
    fake.merged.set("fix-export", false);
    expect(await checkMerges(config())).toBe(1);
    expect(store.getTask(id)!.merged_at).toBeNull();
  });

  test("a merged PR is merged, squash or not", async () => {
    const id = branchTask();
    const url = "https://github.com/acme/api/pull/12";
    store.updateTask(id, { url });
    store.setPrStatus({
      task_id: id,
      repo: "acme/api",
      number: 12,
      url,
      state: "merged",
      checks: "pass",
      review: "approved",
      mergeable: "unknown",
      queue: "none",
      queue_position: null,
      queue_reason: null,
      fetched_at: new Date().toISOString(),
      error: null,
    });
    expect(await checkMerges(config())).toBe(1);
    expect(triggers(id).at(-1)).toContain("(PR #12)");
  });
});

describe("branchMerged (real git)", () => {
  async function sh(cwd: string, ...argv: string[]) {
    const proc = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
    if ((await proc.exited) !== 0) throw new Error(`${argv.join(" ")}: ${await new Response(proc.stderr).text()}`);
  }

  test("no work, unmerged, fast-forwarded and squashed", async () => {
    const repo = mkdtempSync(join(tmpdir(), "riker-merge-"));
    const git = (...a: string[]) => sh(repo, "git", ...a);
    const commit = async (file: string) => {
      await Bun.write(join(repo, file), file);
      await git("add", file);
      await git("commit", "-qm", file);
    };
    await git("init", "-q", "-b", "main");
    await commit("a");
    const mux = new TmuxMux();
    await git("branch", "idle");
    expect(await mux.branchMerged(repo, "idle")).toBe(false);
    await git("checkout", "-qb", "ff");
    await commit("b");
    await git("checkout", "-q", "main");
    expect(await mux.branchMerged(repo, "ff")).toBe(false);
    await git("merge", "-q", "--ff-only", "ff");
    expect(await mux.branchMerged(repo, "ff")).toBe("main");
    await git("checkout", "-qb", "sq");
    await commit("c");
    await commit("d");
    await git("checkout", "-q", "main");
    await git("merge", "-q", "--squash", "sq");
    await git("commit", "-qm", "squashed");
    expect(await mux.branchMerged(repo, "sq")).toBe("main");
    expect(await mux.branchMerged(repo, "nope")).toBeNull();
  });
});
