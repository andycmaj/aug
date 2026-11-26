import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/config";
import { Lane, laneOf } from "../src/lanes";
import { Engine } from "../src/engine";
import { checkMerges, unmergedWork } from "../src/merge";
import { setMux, TmuxMux } from "../src/mux";
import type { Connector } from "../src/plugins";
import * as store from "../src/store";
import {
  AgentState,
  Kind,
  TaskStatus,
  TurnRole,
  type TaskRow,
} from "../src/types";
import { FakeMux } from "./support/fake-mux";
import { config, freshHome, testConfig } from "./support/helpers";

let fake: FakeMux;

beforeEach(() => {
  freshHome({ repos: { "acme/api": "/src/api" } });
  fake = new FakeMux();
  setMux(fake);
});

function branchTask(branch = "fix-export") {
  const t = store.createTask({
    title: "Fix export",
    kind: Kind.coding,
    channel: "owner",
    repo: "acme/api",
    branch,
  });
  return t.id;
}

const triggers = (id: number) =>
  store
    .turnsForTask(id)
    .filter((t) => t.role === TurnRole.trigger)
    .map((t) => t.body);

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

// The turn that merges a PR is the one to look after: the clocks are minutes
// away, and GitHub's may be paused by a rate limit (RIKER-0223's merge sat
// unmarked behind one).
describe("a turn's end", () => {
  class Refresher implements Connector {
    readonly name = "refresher";
    readonly label = "Refresher";
    asked: number[] = [];
    attach() {}
    start() {}
    async refreshTask(task: TaskRow) {
      this.asked.push(task.id);
    }
  }

  function engineWith(c: Connector) {
    return new Engine({
      config: testConfig(),
      offline: true,
      plugins: [{ name: "p", connectors: [c] }],
    });
  }

  test("an agent leaving working is a turn end; the first look and staying put are not", () => {
    const id = branchTask();
    const other = branchTask("other");
    store.updateTask(id, { agent_state: AgentState.working });
    store.updateTask(other, { agent_state: AgentState.working });
    const e = engineWith(new Refresher());
    expect(e.turnEnds()).toEqual([]);
    expect(e.turnEnds()).toEqual([]);
    store.updateTask(id, { agent_state: AgentState.idle });
    expect(e.turnEnds()).toEqual([id]);
    expect(e.turnEnds()).toEqual([]);
    store.updateTask(other, { agent_state: AgentState.ready });
    store.updateTask(id, { agent_state: AgentState.working });
    expect(e.turnEnds()).toEqual([other]);
    store.updateTask(id, { agent_state: AgentState.waiting });
    expect(e.turnEnds()).toEqual([id]);
  });

  test("marks it merged right away: its PR read first, then its branch", async () => {
    const id = branchTask();
    const refresher = new Refresher();
    const e = engineWith(refresher);
    store.updateTask(id, { agent_state: AgentState.working });
    e.turnEnds();
    fake.merged.set("fix-export", "origin/main");
    store.updateTask(id, { agent_state: AgentState.ready });
    const [ended] = e.turnEnds();
    expect(await e.recheckMerge(ended)).toBe(true);
    expect(refresher.asked).toEqual([id]);
    expect(store.getTask(id)!.merged_at).not.toBeNull();
    expect(triggers(id).at(-1)).toContain("Merged into origin/main");
    // Once: the clock's sweep after it finds nothing new.
    expect(await checkMerges(config())).toBe(0);
  });

  test("a task with neither branch nor PR costs no git call", async () => {
    const t = store.createTask({
      title: "Chat",
      kind: Kind.general,
      channel: "owner",
    });
    const e = engineWith(new Refresher());
    fake.merged.set("fix-export", "main");
    expect(await e.recheckMerge(t.id)).toBe(false);
    expect(store.getTask(t.id)!.merged_at).toBeNull();
  });
});

// RIKER-0182: the sweep ran branchMerged (a handful of git calls) on every
// task with a branch every couple of minutes and every GitHub poll, 14.6k a
// day. Its answer moves only with the refs it reads, so a sweep reads them
// once per repo and asks only where they moved.
describe("a sweep's cost", () => {
  const seed = (n: number) =>
    Array.from({ length: n }, (_, i) => {
      fake.merged.set(`b${i}`, false);
      return branchTask(`b${i}`);
    });

  test("bounded by the branches that moved, not the tasks", async () => {
    seed(200);
    await checkMerges(config());
    expect(fake.mergedAsked.length).toBe(200);
    expect(fake.keysRead).toBe(1);
    fake.mergedAsked = [];
    for (let i = 0; i < 5; i++) {
      await checkMerges(config());
    }
    expect(fake.mergedAsked).toEqual([]);
    expect(fake.keysRead).toBe(6);
    fake.merged.set("b7", "main");
    fake.merged.set("b42", false);
    expect(await checkMerges(config())).toBe(1);
    expect(fake.mergedAsked).toEqual(["b7"]);
  });

  test("the base moving asks every branch again", async () => {
    seed(3);
    await checkMerges(config());
    fake.mergedAsked = [];
    fake.baseTip++;
    await checkMerges(config());
    expect(fake.mergedAsked.sort()).toEqual(["b0", "b1", "b2"]);
  });

  test("git that cannot say is asked again next time", async () => {
    branchTask("lost");
    await checkMerges(config());
    await checkMerges(config());
    expect(fake.mergedAsked).toEqual(["lost", "lost"]);
  });

  test("a closed task's branch is forgotten and asked afresh if it reopens", async () => {
    const [id] = seed(1);
    await checkMerges(config());
    store.updateTask(id, { status: TaskStatus.done });
    await checkMerges(config());
    store.updateTask(id, { status: TaskStatus.open });
    await checkMerges(config());
    expect(fake.mergedAsked).toEqual(["b0", "b0"]);
  });

  test("a turn's end reuses what the sweep learned", async () => {
    const [id] = seed(1);
    await checkMerges(config());
    const e = new Engine({ config: testConfig(), offline: true, plugins: [] });
    expect(await e.recheckMerge(id)).toBe(false);
    expect(fake.mergedAsked).toEqual(["b0"]);
  });
});

describe("unmerged work at done", () => {
  function withPr(id: number, state: "open" | "closed" | "merged") {
    store.linkThread(id, "github:acme/api#7");
    store.setPrStatus({
      task_id: id,
      repo: "acme/api",
      number: 7,
      url: "https://github.com/acme/api/pull/7",
      state,
      checks: "pass",
      review: "none",
      mergeable: "clean",
      queue: "none",
      queue_position: null,
      queue_reason: null,
      fetched_at: "",
      error: null,
    });
  }
  const ask = (id: number) => unmergedWork(config(), store.getTask(id)!);

  test("every task not merged asks, with or without a PR or branch", async () => {
    const chat = store.createTask({
      title: "Reply to Sam",
      kind: Kind.general,
      channel: "owner",
    });
    expect(await ask(chat.id)).toEqual({ why: null });
    const id = branchTask();
    fake.merged.set("fix-export", false);
    fake.ahead.set("fix-export", 0);
    expect(await ask(id)).toEqual({ why: null });
    fake.ahead.delete("fix-export");
    expect(await ask(id)).toEqual({ why: null });
    const unmapped = store.createTask({
      title: "x",
      kind: Kind.coding,
      channel: "owner",
      repo: "acme/unmapped",
      branch: "y",
    });
    expect(await ask(unmapped.id)).toEqual({ why: null });
  });

  test("a branch with commits not in the base says how many", async () => {
    const id = branchTask();
    fake.merged.set("fix-export", false);
    fake.ahead.set("fix-export", 4);
    expect(await ask(id)).toEqual({
      why: "Branch fix-export has 4 commits not merged",
    });
    fake.ahead.set("fix-export", 1);
    expect(await ask(id)).toEqual({
      why: "Branch fix-export has 1 commit not merged",
    });
  });

  test("merged, by mark, PR or branch: nothing to ask", async () => {
    const marked = branchTask("a");
    store.updateTask(marked, { merged_at: new Date().toISOString() });
    expect(await ask(marked)).toBeNull();
    const landed = branchTask("b");
    fake.merged.set("b", "main");
    fake.ahead.set("b", 4);
    expect(await ask(landed)).toBeNull();
    const viaPr = branchTask("c");
    withPr(viaPr, "merged");
    expect(await ask(viaPr)).toBeNull();
  });

  test("its PR speaks first: open or closed, whatever the branch holds", async () => {
    const id = branchTask();
    fake.merged.set("fix-export", false);
    fake.ahead.set("fix-export", 4);
    withPr(id, "open");
    expect(await ask(id)).toEqual({ why: "PR #7 is open, not merged" });
    const closed = branchTask("other");
    withPr(closed, "closed");
    expect(await ask(closed)).toEqual({ why: "PR #7 was closed, not merged" });
  });
});

describe("branchMerged (real git)", () => {
  async function sh(cwd: string, ...argv: string[]) {
    const proc = Bun.spawn(argv, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@t",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@t",
      },
    });
    if ((await proc.exited) !== 0) {
      throw new Error(
        `${argv.join(" ")}: ${await new Response(proc.stderr).text()}`,
      );
    }
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

  test("branchAhead counts the branch's commits not in the base", async () => {
    const repo = mkdtempSync(join(tmpdir(), "riker-merge-"));
    const git = (...a: string[]) => sh(repo, "git", ...a);
    const commit = async (file: string) => {
      await Bun.write(join(repo, file), file);
      await git("add", file);
      await git("commit", "-qm", file);
    };
    await git("init", "-q", "-b", "main");
    await commit("a");
    await git("update-ref", "refs/remotes/origin/main", "main");
    const mux = new TmuxMux();
    await git("branch", "idle");
    expect(await mux.branchAhead(repo, "idle")).toBe(0);
    await git("checkout", "-qb", "work");
    await commit("b");
    await commit("c");
    await git("checkout", "-q", "main");
    expect(await mux.branchAhead(repo, "work")).toBe(2);
    // Merged on origin while the local main is behind: origin is the base.
    await git("update-ref", "refs/remotes/origin/main", "work");
    expect(await mux.branchAhead(repo, "work")).toBe(0);
    expect(await mux.branchAhead(repo, "nope")).toBeNull();
  });

  // A PR merged on GitHub reaches origin/main with any fetch; the checkout's
  // own main waits for the owner's pull (RIKER-0223: main not pulled).
  test("merged on origin while the local main is behind", async () => {
    const repo = mkdtempSync(join(tmpdir(), "riker-merge-"));
    const git = (...a: string[]) => sh(repo, "git", ...a);
    const commit = async (file: string) => {
      await Bun.write(join(repo, file), file);
      await git("add", file);
      await git("commit", "-qm", file);
    };
    await git("init", "-q", "-b", "main");
    await commit("a");
    await git("update-ref", "refs/remotes/origin/main", "main");
    const mux = new TmuxMux();
    await git("checkout", "-qb", "pr");
    await commit("b");
    await git("checkout", "-qb", "squashed", "main");
    await commit("c");
    await commit("d");
    expect(await mux.branchMerged(repo, "pr")).toBe(false);
    // GitHub merges pr with a merge commit, then squashes the other.
    await git("checkout", "-qb", "github", "main");
    await git("merge", "-q", "--no-ff", "-m", "Merge pr", "pr");
    await git("merge", "-q", "--squash", "squashed");
    await git("commit", "-qm", "squashed (#2)");
    await git("update-ref", "refs/remotes/origin/main", "github");
    await git("checkout", "-q", "main");
    expect(await mux.branchMerged(repo, "pr")).toBe("origin/main");
    expect(await mux.branchMerged(repo, "squashed")).toBe("origin/main");
    // Pulled: the local main says so, as it always did.
    await git("merge", "-q", "--ff-only", "github");
    expect(await mux.branchMerged(repo, "pr")).toBe("main");
    // Local work past origin: the local main is the one to read.
    await commit("e");
    expect(await mux.branchMerged(repo, "pr")).toBe("main");
  });

  test("a branch named like a ref under main is not main", async () => {
    const repo = mkdtempSync(join(tmpdir(), "riker-merge-"));
    const git = (...a: string[]) => sh(repo, "git", ...a);
    await Bun.write(join(repo, "a"), "a");
    await git("init", "-q", "-b", "trunk");
    await git("add", "a");
    await git("commit", "-qm", "a");
    await git("branch", "main/x");
    expect(await new TmuxMux().branchMerged(repo, "main/x")).toBeNull();
  });

  test("a merge key moves with the branch and the base, and only then", async () => {
    const repo = mkdtempSync(join(tmpdir(), "riker-merge-"));
    const git = (...a: string[]) => sh(repo, "git", ...a);
    const commit = async (file: string) => {
      await Bun.write(join(repo, file), file);
      await git("add", file);
      await git("commit", "-qm", file);
    };
    await git("init", "-q", "-b", "main");
    await commit("a");
    await git("update-ref", "refs/remotes/origin/main", "main");
    await git("branch", "one");
    await git("branch", "two");
    const mux = new TmuxMux();
    const keys = () => mux.mergeKeys(repo, ["one", "two", "nope", "main"]);
    const first = (await keys())!;
    expect([...first.keys()].sort()).toEqual(["main", "one", "two"]);
    expect(await keys()).toEqual(first);
    await git("checkout", "-q", "one");
    await commit("b");
    const moved = (await keys())!;
    expect(moved.get("one")).not.toBe(first.get("one"));
    expect(moved.get("two")).toBe(first.get("two"));
    await git("update-ref", "refs/remotes/origin/main", "one");
    const based = (await keys())!;
    expect(based.get("two")).not.toBe(moved.get("two"));
    expect(await mux.mergeKeys(join(repo, "missing"), ["one"])).toBeNull();
  });
});
