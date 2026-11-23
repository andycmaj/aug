// The guide on a review that just arrived: a coding task on pr:N with a repo
// and no worktree. It is offered (the picker, the palette, a configured key),
// never run by itself, and the owner's run makes the worktree first with no
// agent started.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setGuideTool } from "@riker/code-review-plannotator/guide";
import { ANSWER, repo } from "@riker/code-review-plannotator/test/support/repo";
import { setBrain, type BrainResult } from "../src/brain";
import { Engine } from "../src/engine";
import { guideOffer } from "../src/guide-turn";
import { runMove } from "../src/moves";
import { isRunning } from "../src/run-action";
import { setMux, type MadeWorktree, type Worktree } from "../src/mux";
import * as store from "../src/store";
import {
  ActionEvent,
  actionNamed,
  actionsFor,
  makesCheckout,
  triggeredBy,
  whyNot,
} from "../src/task-actions";
import { AgentState, Kind, TurnRole } from "../src/types";
import { FakeMux } from "./support/fake-mux";
import { config, freshHome, testConfig } from "./support/helpers";

// wt on pr:N checks out the PR's head; here, a real repo on its feature
// branch, so the guide reads a real diff.
class PrMux extends FakeMux {
  constructor(private readonly checkout: string) {
    super();
  }
  override async worktree(w: Worktree): Promise<MadeWorktree> {
    this.worktrees.push({ ...w, path: this.checkout });
    return { path: this.checkout, branch: w.branch };
  }
}

let mux: PrMux;
let checkout: string;
let calls: number;
let saved: { pr?: string }[];

beforeEach(() => {
  freshHome({ autostart: false, repos: { "acme/api": "/src/api" } });
  checkout = repo();
  mux = new PrMux(checkout);
  setMux(mux);
  calls = 0;
  saved = [];
  setBrain(async (): Promise<BrainResult> => {
    calls++;
    return {
      text: `\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``,
      structured: null,
      sessionId: null,
      durationMs: 1,
      isError: false,
    };
  });
  setGuideTool({
    async save(_file, _cwd, pr) {
      saved.push({ pr });
      return { id: "1795-add-div" };
    },
  });
});
afterEach(() => setGuideTool(null));

function review(repoName = "acme/api", branch = "pr:40") {
  const engine = new Engine({ config: testConfig() });
  const t = engine.desk.newTask("Review acme/api#40", Kind.coding);
  store.updateTask(t.id, {
    repo: repoName,
    branch,
    url: `https://github.com/${repoName}/pull/40`,
  });
  return { engine, task: store.getTask(t.id)! };
}

describe("the guide on a review with no worktree", () => {
  test("is offered, but cannot run until its worktree is made", () => {
    const { task } = review();
    const guide = actionNamed(config(), "guide")!;
    expect(actionsFor(config(), task).map((a) => a.name)).toContain("guide");
    expect(makesCheckout(guide, task)).toBe(true);
    expect(whyNot(guide, task)).toContain("needs a worktree");
  });

  test("is not offered on a coding task with no repo", () => {
    const engine = new Engine({ config: testConfig() });
    const t = engine.desk.newTask("Sketch", Kind.coding);
    expect(actionsFor(config(), store.getTask(t.id)!).map((a) => a.name)).not.toContain("guide");
  });

  test("a trigger never runs it on arrival, even one configured for reviews", () => {
    freshHome({
      autostart: false,
      repos: { "acme/api": "/src/api" },
      actions: { guide: { on: [{ event: ActionEvent.triaged, kind: Kind.coding }] } },
    });
    const { engine, task } = review();
    expect(triggeredBy(config(), ActionEvent.triaged, task)).toEqual([]);
    expect(engine.desk.fireActions(ActionEvent.triaged, task.id)).toEqual([]);
    expect(calls).toBe(0);
    expect(mux.worktrees).toHaveLength(0);
  });

  test("the owner's run makes the pr worktree with no agent, then the guide runs there", async () => {
    const { engine, task } = review();
    const ready = await engine.desk.prepareAction(task.id, "guide");
    expect(ready).toEqual({ type: "ready" });

    expect(mux.worktrees).toHaveLength(1);
    expect(mux.worktrees[0]).toMatchObject({ repoPath: "/src/api", branch: "pr:40", create: false });
    const made = store.getTask(task.id)!;
    expect(made.worktree).toBe(checkout);
    // No agent: no session, no window, the lifecycle untouched.
    expect(store.latestSession(task.id)).toBeNull();
    expect(mux.windows).toHaveLength(0);
    expect(made.agent_state).toBe(task.agent_state);
    expect(made.agent_state).not.toBe(AgentState.working);
    expect(
      store.turnsForTask(task.id).some((t) => t.role === TurnRole.trigger && t.body?.includes("no agent started")),
    ).toBe(true);

    const started = engine.desk.runAction(task.id, "guide");
    if ("error" in started) throw new Error(started.error);
    const result = await started.done;
    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
    // A local review of the worktree, never the PR on GitHub.
    const argv = result.terminal!.argv.join(" ");
    expect(argv).toContain("plannotator review --base");
    expect(argv).not.toContain("github.com");
    expect(result.terminal!.cwd).toBe(checkout);
    // The PR only labels the saved guide.
    expect(saved).toEqual([{ pr: "https://github.com/acme/api/pull/40" }]);
  });

  test("a second run reuses the worktree", async () => {
    const { engine, task } = review();
    await engine.desk.prepareAction(task.id, "guide");
    expect(await engine.desk.prepareAction(task.id, "guide")).toEqual({ type: "ready" });
    expect(mux.worktrees).toHaveLength(1);
  });

  test("an unmapped repo asks where it is, and makes nothing", async () => {
    const { engine, task } = review("acme/web");
    const ready = await engine.desk.prepareAction(task.id, "guide");
    expect(ready).toMatchObject({
      type: "needs",
      need: { what: "path", repo: "acme/web", problem: { kind: "unmapped" } },
    });
    expect(mux.worktrees).toHaveLength(0);
    expect(calls).toBe(0);
  });

  test("a branch that does not exist yet is refused before a worktree is made", async () => {
    const { engine, task } = review("acme/api", "add-div");
    const ready = await engine.desk.prepareAction(task.id, "guide");
    expect(ready).toMatchObject({ type: "failed" });
    expect((ready as { error: string }).error).toContain("nothing to review yet");
    expect(mux.worktrees).toHaveLength(0);
  });

  test("a branch that exists is checked out as is", async () => {
    mux.branches.add("add-div");
    const { engine, task } = review("acme/api", "add-div");
    expect(await engine.desk.prepareAction(task.id, "guide")).toEqual({ type: "ready" });
    expect(mux.worktrees[0]).toMatchObject({ branch: "add-div", create: false });
  });

  test("the move makes the worktree too, and says when the repo needs a path", async () => {
    const { engine, task } = review();
    const ref = store.taskRef(task.id);
    const said = await runMove(engine.desk, "action", { task: ref, name: "guide" }, "assistant");
    expect(said).toEqual({ ok: true, result: expect.stringContaining("started guide") });
    expect(store.getTask(task.id)!.worktree).toBe(checkout);
    // The move answers at once; the run finishes behind it.
    while (isRunning(task.id, "guide")) await Bun.sleep(5);
    expect(calls).toBe(1);

    const other = review("acme/web").task;
    const refused = await runMove(engine.desk, "action", { task: store.taskRef(other.id), name: "guide" }, "assistant");
    expect(refused.ok).toBe(false);
    expect(refused.result).toContain("needs a path");
    expect(store.getTask(other.id)!.worktree).toBeNull();
  });

  test("the arrival line names the picker and the worktree", () => {
    const { task } = review();
    const line = guideOffer(config(), task)!;
    expect(line).toContain('`.` then "Guided review, with review notes"');
    expect(line).toContain("makes the worktree on pr:40 (no agent starts)");
    freshHome({ actions: { guide: { key: "shift+v" } } });
    expect(guideOffer(config(), task)).toContain("`shift+v`, or `.`");
    freshHome({ actions: { guide: false } });
    expect(guideOffer(config(), task)).toBeNull();
  });
});

test("Start after the guide made the worktree starts in it, and its project gets the repo", async () => {
  const { engine, task } = review();
  await engine.desk.prepareAction(task.id, "guide");
  const started = await engine.desk.startAgent(task.id);
  expect(started.type).toBe("started");
  expect(mux.worktrees).toHaveLength(1);
  expect(mux.windows[0]!.cwd).toBe(checkout);
  const project = store.getProject(store.getTask(task.id)!.project_id!)!;
  expect(project.repos).toContain("acme/api");
});
