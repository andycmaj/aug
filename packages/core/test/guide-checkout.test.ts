// The guide on a review that just arrived: a coding task on pr:N with a repo
// and no worktree. It is offered (the picker, the palette, a configured key),
// never run by itself, and the owner's run makes the worktree first with no
// agent started.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setGuideTool } from "@riker/code-review-plannotator/guide";
import {
  ANSWER,
  repo,
  sh,
} from "@riker/code-review-plannotator/test/support/repo";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewSource } from "../src/plugins";
import { setBrain, type BrainResult } from "../src/brain";
import { Engine } from "../src/engine";
import { guideOffer, reviewExit } from "../src/guide-turn";
import { REVIEW_LINK_BY, REVIEW_LINK_TITLE } from "../src/pr";
import { runMove } from "../src/moves";
import { isRunning, setGuidePrReviews } from "../src/run-action";
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
    expect(
      actionsFor(config(), store.getTask(t.id)!).map((a) => a.name),
    ).not.toContain("guide");
  });

  test("a trigger never runs it on arrival, even one configured for reviews", () => {
    freshHome({
      autostart: false,
      repos: { "acme/api": "/src/api" },
      actions: {
        guide: { on: [{ event: ActionEvent.triaged, kind: Kind.coding }] },
      },
    });
    const { engine, task } = review();
    expect(triggeredBy(config(), ActionEvent.triaged, task)).toEqual([]);
    expect(engine.desk.fireActions(ActionEvent.triaged, task.id)).toEqual([]);
    expect(calls).toBe(0);
    expect(mux.worktrees).toHaveLength(0);
  });

  test("the owner's run makes the pr worktree with no agent, then the guide runs there (their own PR: reviewed locally)", async () => {
    const { engine, task } = review();
    const ready = await engine.desk.prepareAction(task.id, "guide");
    expect(ready).toEqual({ type: "ready" });

    expect(mux.worktrees).toHaveLength(1);
    expect(mux.worktrees[0]).toMatchObject({
      repoPath: "/src/api",
      branch: "pr:40",
      create: false,
    });
    const made = store.getTask(task.id)!;
    expect(made.worktree).toBe(checkout);
    // No agent: no session, no window, the lifecycle untouched.
    expect(store.latestSession(task.id)).toBeNull();
    expect(mux.windows).toHaveLength(0);
    expect(made.agent_state).toBe(task.agent_state);
    expect(made.agent_state).not.toBe(AgentState.working);
    expect(
      store
        .turnsForTask(task.id)
        .some(
          (t) =>
            t.role === TurnRole.trigger && t.body?.includes("no agent started"),
        ),
    ).toBe(true);

    const started = engine.desk.runAction(task.id, "guide");
    if ("error" in started) {
      throw new Error(started.error);
    }
    const result = await started.done;
    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
    // Not marked as a PR to review: a local review of the worktree, whose
    // notes go to the agent, never the PR on GitHub.
    const argv = result.terminal!.argv.join(" ");
    expect(argv).toContain("plannotator review --json --base");
    expect(argv).not.toContain("github.com");
    expect(result.terminal!.posts).toBeUndefined();
    expect(result.terminal!.cwd).toBe(checkout);
    // The PR only labels the saved guide.
    expect(saved).toEqual([{ pr: "https://github.com/acme/api/pull/40" }]);
  });

  test("a PR the owner was asked to review opens in Plannotator's PR mode, which posts to GitHub", async () => {
    const { engine, task } = review();
    store.addTaskLink(
      task.id,
      "https://github.com/acme/api/pull/40",
      REVIEW_LINK_TITLE,
      REVIEW_LINK_BY,
    );
    await engine.desk.prepareAction(task.id, "guide");
    const started = engine.desk.runAction(task.id, "guide");
    if ("error" in started) {
      throw new Error(started.error);
    }
    const result = await started.done;
    const run = result.terminal!;
    expect(run.argv.slice(3)).toEqual([
      "plannotator",
      "https://github.com/acme/api/pull/40",
      run.feedback!,
    ]);
    expect(run.argv[2]).not.toContain("--base");
    expect(run.posts).toBe("github");
    // Riker's findings still go into the review it opens.
    expect(run.comments!.list.length).toBeGreaterThan(0);

    // Opened again with no run: the same PR mode.
    const again = engine.desk.guideReview(task.id);
    if ("error" in again) {
      throw new Error(again.error);
    }
    expect(again.terminal!.argv).toContain(
      "https://github.com/acme/api/pull/40",
    );
    expect(again.terminal!.posts).toBe("github");
  });

  test("where PRs are not on GitHub (the sim), a review opens on the worktree", async () => {
    setGuidePrReviews(false);
    try {
      const { engine, task } = review();
      store.addTaskLink(
        task.id,
        "https://github.com/acme/api/pull/40",
        REVIEW_LINK_TITLE,
        REVIEW_LINK_BY,
      );
      await engine.desk.prepareAction(task.id, "guide");
      const started = engine.desk.runAction(task.id, "guide");
      if ("error" in started) {
        throw new Error(started.error);
      }
      const run = (await started.done).terminal!;
      expect(run.argv.join(" ")).toContain("plannotator review --json --base");
      expect(run.posts).toBeUndefined();
    } finally {
      setGuidePrReviews(true);
    }
  });

  test("a second run reuses the worktree", async () => {
    const { engine, task } = review();
    await engine.desk.prepareAction(task.id, "guide");
    expect(await engine.desk.prepareAction(task.id, "guide")).toEqual({
      type: "ready",
    });
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
    expect((ready as { error: string }).error).toContain(
      "nothing to review yet",
    );
    expect(mux.worktrees).toHaveLength(0);
  });

  test("a branch that exists is checked out as is", async () => {
    mux.branches.add("add-div");
    const { engine, task } = review("acme/api", "add-div");
    expect(await engine.desk.prepareAction(task.id, "guide")).toEqual({
      type: "ready",
    });
    expect(mux.worktrees[0]).toMatchObject({
      branch: "add-div",
      create: false,
    });
  });

  test("the move makes the worktree too, and says when the repo needs a path", async () => {
    const { engine, task } = review();
    const ref = store.taskRef(task.id);
    const said = await runMove(
      engine.desk,
      "action",
      { task: ref, name: "guide" },
      "assistant",
    );
    expect(said).toEqual({
      ok: true,
      result: expect.stringContaining("started guide"),
    });
    expect(store.getTask(task.id)!.worktree).toBe(checkout);
    // The move answers at once; the run finishes behind it.
    while (isRunning(task.id, "guide")) {
      await Bun.sleep(5);
    }
    expect(calls).toBe(1);

    const other = review("acme/web").task;
    const refused = await runMove(
      engine.desk,
      "action",
      { task: store.taskRef(other.id), name: "guide" },
      "assistant",
    );
    expect(refused.ok).toBe(false);
    expect(refused.result).toContain("needs a path");
    expect(store.getTask(other.id)!.worktree).toBeNull();
  });

  test("the arrival line names the picker and the worktree", () => {
    const { task } = review();
    const line = guideOffer(config(), task)!;
    expect(line).toContain('`.` then "Guided review, with review notes"');
    expect(line).toContain("makes the worktree on pr:40 (no agent starts)");
    expect(line).toContain("goes to the agent, not GitHub");
    store.addTaskLink(
      task.id,
      "https://github.com/acme/api/pull/40",
      REVIEW_LINK_TITLE,
      REVIEW_LINK_BY,
    );
    expect(guideOffer(config(), task)).toContain(
      "Post to GitHub there sends your review",
    );
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

describe("the guide on a PR asked of the owner reads the PR and what changed since their last review", () => {
  let prompts: string[];
  const git = (...a: string[]) =>
    sh(checkout, "git", "-c", "user.email=t@t", "-c", "user.name=t", ...a);

  function asked(source: ReviewSource) {
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
    const engine = new Engine({
      config: testConfig(),
      plugins: [{ name: "gh", reviews: source }],
    });
    const t = engine.desk.newTask("Review acme/api#40", Kind.coding);
    store.updateTask(t.id, {
      repo: "acme/api",
      branch: "pr:40",
      url: "https://github.com/acme/api/pull/40",
    });
    store.addTaskLink(
      t.id,
      "https://github.com/acme/api/pull/40",
      REVIEW_LINK_TITLE,
      REVIEW_LINK_BY,
    );
    return { engine, task: store.getTask(t.id)! };
  }

  async function guide(engine: Engine, taskId: number, whole = false) {
    await engine.desk.prepareAction(taskId, "guide");
    const started = engine.desk.runAction(taskId, "guide", { whole });
    if ("error" in started) {
      throw new Error(started.error);
    }
    await started.done;
    return store
      .turnsForTask(taskId)
      .filter((t) => t.role === TurnRole.action)
      .at(-1)!;
  }

  test("first review: the whole PR, with its words beside the diff", async () => {
    const { engine, task } = asked({
      context: async () => ({
        text: "The pull request, read from GitHub: speed up export",
        lastReviewed: null,
      }),
    });
    await guide(engine, task.id);
    expect(prompts[0]).toContain(
      "The pull request, read from GitHub: speed up export",
    );
    expect(prompts[0]).toContain("export function div");
  });

  test("asked again: only the commits since their last review, or the whole PR on ask", async () => {
    const reviewed = git("rev-parse", "HEAD").trim();
    writeFileSync(
      join(checkout, "mul.ts"),
      "export const mul = (a: number, b: number) => a * b;\n",
    );
    git("add", ".");
    git("commit", "-qm", "mul");
    const { engine, task } = asked({
      context: async () => ({ text: "PR words", lastReviewed: reviewed }),
    });
    const turn = await guide(engine, task.id);
    expect(prompts[0]).toContain("mul.ts");
    expect(prompts[0]).not.toContain("export function div");
    expect(prompts[0]).toContain(
      `since the owner's last review (${reviewed.slice(0, 7)})`,
    );
    expect(turn.steps).toContain(
      `since your last review (${reviewed.slice(0, 7)}): 1 files`,
    );

    await guide(engine, task.id, true);
    expect(prompts.at(-1)).toContain("export function div");
  });

  test("nothing new since their last review: the whole PR, said so", async () => {
    const reviewed = git("rev-parse", "HEAD").trim();
    const { engine, task } = asked({
      context: async () => ({ text: "PR words", lastReviewed: reviewed }),
    });
    const turn = await guide(engine, task.id);
    expect(prompts[0]).toContain("export function div");
    expect(turn.steps).toContain(
      `whole PR: nothing to review since your last review (${reviewed.slice(0, 7)})`,
    );
  });

  test("its history rewritten since: the whole PR", async () => {
    const { engine, task } = asked({
      context: async () => ({
        text: "PR words",
        lastReviewed: "0123456789abcdef0123456789abcdef01234567",
      }),
    });
    const turn = await guide(engine, task.id);
    expect(prompts[0]).toContain("export function div");
    expect(turn.steps).toContain(
      "whole PR: your last review (0123456) is not under its head now",
    );
  });

  test("the PR failing to read never stops the review", async () => {
    const { engine, task } = asked({
      context: async () => {
        throw new Error("rate limited");
      },
    });
    const turn = await guide(engine, task.id);
    expect(prompts.length).toBeGreaterThan(0);
    expect(turn.steps).toContain("pull request context not read: rate limited");
  });
});

// What plannotator review --json prints, as 0.29.1 prints it (probed by
// posting to its /api/feedback and /api/exit).
const record = (decision: string, message: string) =>
  JSON.stringify({ decision, message });
const POSTED = record(
  "annotated",
  "Pull request reviewed on GitHub: https://github.com/acme/api/pull/40",
);
const APPROVED = record(
  "approved",
  "# Code Review\n\nCode review completed — no changes requested.",
);
const APPROVED_WITH_NOTES = record(
  "approved",
  "# Code Review — Approved with Notes\n\nCode review completed — the changes are approved.\n\nnit: rename y",
);
const DISMISSED = record(
  "dismissed",
  "Review session closed without feedback.",
);
const NOTES = record(
  "annotated",
  "# Code Review Feedback\n\n## a.ts\n\n### Line 3 (new)\nrename this",
);

describe("when the review closes", () => {
  const notes =
    "# Code Review Feedback\n\n## a.ts\n\n### Line 3 (new)\nrename this\n";

  test("the owner's own work: what they sent goes to the agent", () => {
    expect(reviewExit(undefined, NOTES)).toEqual({
      end: "notes",
      notes: notes.trim(),
      status: null,
    });
    expect(reviewExit(undefined, notes)).toMatchObject({
      end: "notes",
      notes: notes.trim(),
    });
    expect(reviewExit(undefined, APPROVED_WITH_NOTES)).toMatchObject({
      end: "notes",
    });
    expect(reviewExit(undefined, DISMISSED)).toEqual({
      end: "none",
      notes: null,
      status: null,
    });
  });

  test("a bare Approve of their own work sends nothing", () => {
    for (const out of [APPROVED, "The user approved."]) {
      expect(reviewExit(undefined, out)).toEqual({
        end: "approved",
        notes: null,
        status: "Self-review: approved, no comments",
      });
    }
  });

  test("a PR they were asked to review: Plannotator posted it, nothing goes to the agent", () => {
    for (const out of [
      POSTED,
      "Pull request reviewed on GitHub: https://github.com/acme/api/pull/40\n",
    ]) {
      expect(reviewExit("github", out)).toEqual({
        end: "posted",
        notes: null,
        status:
          "Pull request reviewed on GitHub: https://github.com/acme/api/pull/40",
      });
    }
    expect(
      reviewExit("github", record("annotated", "Changes requested on GitHub"))
        .end,
    ).toBe("posted");
    expect(reviewExit("github", DISMISSED)).toEqual({
      end: "none",
      notes: null,
      status: "Nothing was posted to GitHub",
    });
    // Approved toward the agent in PR mode: nothing was posted.
    expect(reviewExit("github", APPROVED).end).toBe("none");
    const sent = reviewExit("github", NOTES);
    expect(sent).toMatchObject({ end: "none", notes: null });
    expect(sent.status).toContain("Not posted to GitHub");
  });

  test("posted to GitHub: the review task closes and its worktree goes", async () => {
    const { engine, task } = review();
    await engine.desk.prepareAction(task.id, "guide");
    const said = await engine.desk.finishReview(task.id, "github", POSTED);
    expect(said!.text).toBe(
      `${store.taskRef(task.id)}: Pull request reviewed on GitHub: https://github.com/acme/api/pull/40; closed`,
    );
    expect(store.getTask(task.id)!.status).toBe("done");
  });

  test("not posted: the review task stays open", async () => {
    const { engine, task } = review();
    const said = await engine.desk.finishReview(task.id, "github", DISMISSED);
    expect(said!.text).toContain("Nothing was posted to GitHub");
    expect(store.getTask(task.id)!.status).toBe("open");
  });

  test("a bare Approve says so on the task and starts nothing", async () => {
    const { engine, task } = review();
    await engine.desk.finishReview(task.id, undefined, APPROVED);
    const last = store.turnsForTask(task.id).at(-1)!;
    expect(last).toMatchObject({
      role: TurnRole.trigger,
      body: "Self-review: approved, no comments",
    });
    expect(mux.windows).toHaveLength(0);
  });

  test("notes for an agent that is not running start it with them", async () => {
    const { engine, task } = review();
    await engine.desk.prepareAction(task.id, "guide");
    const said = await engine.desk.finishReview(task.id, undefined, NOTES);
    expect(said!.text).toBe(
      `${store.taskRef(task.id)}'s agent resumed with your review notes`,
    );
    expect(mux.windows).toHaveLength(1);
    const you = store
      .turnsForTask(task.id)
      .filter((t) => t.role === TurnRole.you);
    expect(you.at(-1)!.body).toContain("rename this");
  });
});
