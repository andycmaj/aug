import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_CONFIG } from "../src/config";
import type { BrainCall } from "../src/brain";
import { runDocPass } from "../src/doc-pass";
import {
  citedPaths,
  entryFacts,
  KNOWLEDGE_DOC,
  type RepoFiles,
} from "../src/knowledge";
import { acceptProposals, rejectProposals, writeReview } from "../src/proposals";
import * as store from "../src/store";
import { Kind, ProposalStatus, TaskStatus } from "../src/types";
import { config, fakeBrain, freshHome } from "./support/helpers";

const REPO = "acme/app";
// The checkout's files, by name: what git ls-files would list.
const files: RepoFiles = (path) =>
  path === "/src/acme-app" ? new Set(["engine.ts", "store.ts", "README.md"]) : null;

const isKnowledgeCall = (c: BrainCall) => c.system?.startsWith("You keep Knowledge") ?? false;

function codingTask(title: string): number {
  return store.createTask({ title, kind: Kind.coding, channel: "owner", repo: REPO }).id;
}

const live = () => store.listKnowledge().map((e) => e.id);
const knowledgeTasks = () =>
  store
    .listTasks()
    .filter((t) => t.kind === Kind.system && t.status === TaskStatus.open && t.title.startsWith("Knowledge"));

describe("what the pass can check about an entry", () => {
  beforeEach(() =>
    freshHome({ github: { ...DEFAULT_CONFIG.github, repos: { [REPO]: "/src/acme-app" } } }),
  );

  test("cited paths are repo paths, not URLs or absolute paths", () => {
    expect(
      citedPaths(
        "See `packages/core/src/engine.ts` and src/old-poller.ts, https://github.com/a/b/blob/main/x.ts, /Users/me/y.ts and ~/z.ts. Also (docs/plan.md).",
      ),
    ).toEqual(["packages/core/src/engine.ts", "src/old-poller.ts", "docs/plan.md"]);
  });

  test("a file gone from its task's repo, a task dropped or missing", () => {
    const t = codingTask("Poller rewrite");
    const moved = store.addKnowledge("engine", "Poller ticks", "src/engine.ts calls lib/old-poller.ts", `agent ${store.taskRef(t)}`);
    expect(entryFacts(moved, config(), files)).toEqual([
      `files it cites are no longer in ${REPO}: lib/old-poller.ts`,
    ]);
    store.updateTask(t, { status: TaskStatus.dropped });
    expect(entryFacts(moved, config(), files)[0]).toBe(`its task ${store.taskRef(t)} was dropped`);
    const orphan = store.addKnowledge("x", "y", "z", "agent AUG-0999");
    expect(entryFacts(orphan, config(), files)).toEqual(["its task RIKER-0999 no longer exists"]);
    // The owner's entry names no task: nothing to check.
    expect(entryFacts(store.addKnowledge("x", "y", "lib/old-poller.ts", "you"), config(), files)).toEqual([]);
  });
});

describe("Knowledge in the daily doc pass", () => {
  let a: number;
  let b: number;
  let stale: number;
  let keep: number;

  beforeEach(() => {
    freshHome({ github: { ...DEFAULT_CONFIG.github, repos: { [REPO]: "/src/acme-app" } } });
    const t = codingTask("Poller rewrite");
    const by = `agent ${store.taskRef(t)}`;
    a = store.addKnowledge("tmux", "Use a private server", "Real tmux checks use -L.", by).id;
    b = store.addKnowledge("tmux", "Never the default tmux server", "Tests run tmux -L riker-test.", by).id;
    stale = store.addKnowledge("engine", "Poller ticks", "lib/old-poller.ts runs every 30s.", by).id;
    keep = store.addKnowledge("sqlite", "data_version", "PRAGMA data_version says another connection wrote.", "you").id;
  });

  const plan = () => ({
    merge: [
      { ids: [a, b], topic: "tmux", title: "Real tmux checks use a private server", body: "Use tmux -L, never the default server.", reason: "same rule twice" },
      // Dropped: one entry is no merge, an unknown id, an id already claimed.
      { ids: [keep], topic: "x", title: "x", body: "x", reason: "" },
      { ids: [keep, 999], topic: "x", title: "x", body: "x", reason: "" },
      { ids: [a, keep], topic: "x", title: "x", body: "x", reason: "" },
    ],
    retire: [
      { id: stale, reason: "lib/old-poller.ts is gone" },
      { id: a, reason: "claimed by the merge" },
    ],
  });

  test("the model reads every entry with its facts; its plan waits on a System task", async () => {
    const calls = fakeBrain((c) => (isKnowledgeCall(c) ? plan() : { edits: [] }));
    const run = await runDocPass(config(), new Date(), true, files);
    expect(run.knowledge).toBe(1);
    const prompt = calls.find(isKnowledgeCall)!.prompt;
    expect(prompt).toContain(`### #${stale} [engine] Poller ticks`);
    expect(prompt).toContain(`Fact: files it cites are no longer in ${REPO}: lib/old-poller.ts`);
    expect(prompt).toContain(`### #${keep} [sqlite] data_version`);

    const [task] = knowledgeTasks();
    expect(task.title).toBe("Knowledge: proposed cleanup");
    expect(task.summary).toContain(`Merge #${a}, #${b} into "Real tmux checks use a private server": same rule twice`);
    expect(task.summary).toContain(`Retire #${stale}: lib/old-poller.ts is gone`);
    expect(task.summary).not.toContain(`#${keep}`);
    // Nothing changes before the owner says so.
    expect(live()).toEqual([stale, keep, a, b]);

    const review = writeReview(task.id)!;
    const diff = readFileSync(review.diff, "utf8");
    expect(diff).toContain(`--- a/${KNOWLEDGE_DOC}.md`);
    expect(diff).toContain(`-## #${stale} [engine] Poller ticks`);
    expect(diff).toContain(`+## new (merges #${a}, #${b}) [tmux] Real tmux checks use a private server`);
  });

  test("accept merges and retires; the old entries are kept out of what agents read", async () => {
    fakeBrain((c) => (isKnowledgeCall(c) ? plan() : { edits: [] }));
    await runDocPass(config(), new Date(), true, files);
    const [task] = knowledgeTasks();
    expect(acceptProposals(task.id)).toBe("wrote Knowledge (2 changes)");
    const merged = store.listKnowledge().find((e) => e.topic === "tmux")!;
    expect(merged.title).toBe("Real tmux checks use a private server");
    expect(merged.author).toMatch(/^riker \(merged #\d+, #\d+ on \d{4}-\d\d-\d\d\)$/);
    expect(live().sort()).toEqual([keep, merged.id].sort());
    expect(store.getKnowledge(a)).toMatchObject({ superseded_by: merged.id, retired_why: `merged into #${merged.id}` });
    expect(store.getKnowledge(stale)).toMatchObject({ superseded_by: null, retired_why: "lib/old-poller.ts is gone" });
    expect(store.getTask(task.id)!.status).toBe(TaskStatus.done);
  });

  test("a step whose entry was retired since is skipped on accept", async () => {
    fakeBrain((c) => (isKnowledgeCall(c) ? plan() : { edits: [] }));
    await runDocPass(config(), new Date(), true, files);
    store.retireKnowledge(b, "the owner retired it by hand");
    const [task] = knowledgeTasks();
    expect(acceptProposals(task.id)).toBe(
      "wrote Knowledge (1 change, 1 skipped: their entries were retired since)",
    );
    expect(store.getKnowledge(a)!.retired_at).toBeNull();
    expect(store.getKnowledge(stale)!.retired_at).not.toBeNull();
  });

  test("reject changes nothing", async () => {
    fakeBrain((c) => (isKnowledgeCall(c) ? plan() : { edits: [] }));
    await runDocPass(config(), new Date(), true, files);
    const [task] = knowledgeTasks();
    rejectProposals(task.id);
    expect(store.proposalsForTask(task.id)[0].status).toBe(ProposalStatus.rejected);
    expect(live()).toEqual([stale, keep, a, b]);
  });

  test("Knowledge unchanged: no call; a new entry: asked again, the open plan revised in place", async () => {
    const calls = fakeBrain((c) => (isKnowledgeCall(c) ? plan() : { edits: [] }));
    await runDocPass(config(), new Date("2026-11-13T09:00:00Z"), false, files);
    expect(calls.filter(isKnowledgeCall)).toHaveLength(1);
    const next = await runDocPass(config(), new Date("2026-11-14T10:00:00Z"), false, files);
    expect(next.skipped).toBe("nothing new");
    expect(calls).toHaveLength(2);

    store.addKnowledge("tmux", "Private tmux server, again", "tmux -L in tests", "you");
    const third = await runDocPass(config(), new Date("2026-11-15T10:00:00Z"), false, files);
    expect(third).toMatchObject({ knowledge: 1, proposed: 0 });
    // Only Knowledge moved: the docs were not sent again.
    expect(calls).toHaveLength(3);
    expect(isKnowledgeCall(calls[2])).toBe(true);
    expect(knowledgeTasks()).toHaveLength(1);
  });

  test("an empty plan proposes nothing", async () => {
    fakeBrain((c) => (isKnowledgeCall(c) ? { merge: [], retire: [] } : { edits: [] }));
    expect((await runDocPass(config(), new Date(), true, files)).knowledge).toBe(0);
    expect(knowledgeTasks()).toHaveLength(0);
  });
});
