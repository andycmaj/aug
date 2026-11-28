import { beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeArgs,
  setBrain,
  type BrainCall,
  type BrainResult,
} from "../src/brain";
import { SHELL_HOWTO } from "../src/capabilities";
import { DEFAULT_CONFIG, mergeConfig } from "../src/config";
import { Engine } from "../src/engine";
import { sessionStarted, workFinished } from "../src/lifecycle";
import { runMove } from "../src/moves";
import { setMux } from "../src/mux";
import * as store from "../src/store";
import {
  actionBase,
  actionsFor,
  rikerPluginDir,
  ensureRikerPlugin,
  fillArgs,
  invocation,
  registeredActions,
  whyNot,
  WRAP_PLUGIN,
} from "../src/task-actions";
import { actionAnswers } from "../src/rows";
import { transcript } from "../src/transcript";
import {
  Kind,
  PrChecks,
  PrMergeable,
  PrQueue,
  PrReview,
  PrState,
  SessionKind,
  TaskStatus,
  TurnRole,
  type MessageRow,
  type PrStatusRow,
  type TaskRow,
} from "../src/types";
import { FakeMux } from "./support/fake-mux";
import { config, freshHome, testConfig } from "./support/helpers";

let engine: Engine;
let mux: FakeMux;
let calls: BrainCall[];
let answer: (call: BrainCall) => Partial<BrainResult>;

beforeEach(() => {
  freshHome({ autostart: false });
  calls = [];
  answer = () => ({ text: "**Goal**: fix it.\n**Done**: fixed." });
  setBrain(async (call): Promise<BrainResult> => {
    calls.push(call);
    return {
      text: "",
      structured: null,
      sessionId: null,
      durationMs: 1,
      isError: false,
      ...answer(call),
    };
  });
  mux = new FakeMux();
  setMux(mux);
  engine = new Engine({ config: testConfig() });
});

function task(kind: Kind = Kind.coding, patch: Partial<TaskRow> = {}): TaskRow {
  const t = engine.desk.newTask("Fix the build", kind);
  if (Object.keys(patch).length) {
    store.updateTask(t.id, patch);
  }
  return store.getTask(t.id)!;
}

function withActions(actions: Record<string, unknown>) {
  return mergeConfig({ ...DEFAULT_CONFIG, actions } as never);
}

describe("the registry", () => {
  test("summarize is built in", () => {
    const names = registeredActions(config()).map((a) => a.name);
    expect(names).toContain("summarize");
  });

  test("config turns one off, changes one field by field, adds one", () => {
    const c = withActions({
      summarize: { model: "haiku" },
      recap: { skill: "riker:summarize", via: "headless", title: "Recap" },
    });
    const byName = Object.fromEntries(
      registeredActions(c).map((a) => [a.name, a]),
    );
    expect(byName.summarize!.model).toBe("haiku");
    expect(byName.summarize!.skill).toBe("riker:summarize");
    expect(byName.recap!.title).toBe("Recap");
    expect(byName.recap!.output).toBe("turn");

    const off = withActions({ summarize: false });
    expect(registeredActions(off).map((a) => a.name)).not.toContain(
      "summarize",
    );
  });

  test("an entry without a skill or a known via is left out", () => {
    const c = withActions({
      noskill: { via: "headless" },
      badvia: { skill: "x", via: "telepathy" },
    });
    const names = registeredActions(c).map((a) => a.name);
    expect(names).not.toContain("noskill");
    expect(names).not.toContain("badvia");
  });
});

describe("which rows an action applies to", () => {
  test("work, not Home", () => {
    const home = store.homeTask();
    expect(actionsFor(config(), task()).map((a) => a.name)).toContain(
      "summarize",
    );
    expect(actionsFor(config(), home)).toEqual([]);
  });

  test("kinds and needs say why not", () => {
    const c = withActions({
      review: {
        skill: "riker:summarize",
        via: "headless",
        kinds: ["coding"],
        needs: ["worktree"],
      },
    });
    const review = registeredActions(c).find((a) => a.name === "review")!;
    expect(whyNot(review, task(Kind.general))).toContain("coding");
    expect(whyNot(review, task())).toContain("worktree");
    expect(
      whyNot(review, task(Kind.coding, { worktree: tmpdir() })),
    ).toBeNull();
  });

  test("quiz: coding work with a checkout", () => {
    const names = (t: TaskRow) => actionsFor(config(), t).map((a) => a.name);
    expect(names(task(Kind.general))).not.toContain("quiz");
    expect(names(task())).not.toContain("quiz");
    expect(names(task(Kind.coding, { worktree: tmpdir() }))).toContain("quiz");
  });
});

describe("args", () => {
  test("the task fills the template", () => {
    const t = task(Kind.coding, { worktree: "/w/riker", branch: "fix-build" });
    const ref = store.taskRef(t.id);
    expect(
      fillArgs("{ref} {title} {worktree} {branch} {base} {pr} {other}", t),
    ).toBe(`${ref} Fix the build /w/riker fix-build main none {other}`);
    const summarize = registeredActions(config()).find(
      (a) => a.name === "summarize",
    )!;
    expect(invocation(summarize, t)).toStartWith(
      `/riker:summarize task ${ref}`,
    );
  });
});

describe("the base an action is taken against", () => {
  const PR = "https://github.com/acme/ledger/pull/230";

  function prStatus(taskId: number, patch: Partial<PrStatusRow> = {}) {
    store.setPrStatus({
      task_id: taskId,
      repo: "acme/ledger",
      number: 230,
      url: PR,
      state: PrState.open,
      checks: PrChecks.pass,
      review: PrReview.none,
      mergeable: PrMergeable.clean,
      queue: PrQueue.none,
      queue_position: null,
      queue_reason: null,
      fetched_at: "",
      error: null,
      ...patch,
    });
  }

  test("a PR stacked on another's branch is taken against that branch", () => {
    const t = task(Kind.coding, { url: PR });
    prStatus(t.id, { base: "stack-2-parser" });
    expect(actionBase(t)).toBe("stack-2-parser");
    expect(fillArgs("{base}", t)).toBe("stack-2-parser");
  });

  test("a PR into main is main, and a task with no PR is main", () => {
    const t = task(Kind.coding, { url: PR });
    prStatus(t.id, { base: "main" });
    expect(actionBase(t)).toBe("main");
    expect(actionBase(task())).toBe("main");
  });

  test("a PR not read yet, or whose read failed before it said a base, is main", () => {
    const t = task(Kind.coding, { url: PR });
    expect(actionBase(t)).toBe("main");
    prStatus(t.id, { base: null, error: "HTTP 502" });
    expect(actionBase(t)).toBe("main");
  });

  test("a read that failed keeps the base the one before it said", () => {
    const t = task(Kind.coding, { url: PR });
    prStatus(t.id, { base: "stack-2-parser" });
    store.markPrStale(t.id, "HTTP 502");
    expect(store.prStatus(t.id)!.error).toBe("HTTP 502");
    expect(actionBase(t)).toBe("stack-2-parser");
  });

  test("a read about another PR than the task's now says nothing", () => {
    const t = task(Kind.coding, { url: PR });
    prStatus(t.id, {
      url: "https://github.com/acme/ledger/pull/199",
      number: 199,
      base: "old-parent",
    });
    expect(actionBase(t)).toBe("main");
  });
});

describe("Riker's plugin", () => {
  test("is written under RIKER_HOME with its skills", () => {
    const dir = ensureRikerPlugin();
    expect(dir).toBe(rikerPluginDir());
    const manifest = JSON.parse(
      readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"),
    ) as { name: string };
    expect(manifest.name).toBe("riker");
    expect(
      readFileSync(join(dir, "skills", "summarize", "SKILL.md"), "utf8"),
    ).toContain("name: summarize");
  });
});

describe("running one", () => {
  test("headless: a running action turn, then the answer", async () => {
    const t = task(Kind.general);
    const started = engine.desk.runAction(t.id, "summarize");
    if ("error" in started) {
      throw new Error(started.error);
    }
    const running = store
      .turnsForTask(t.id)
      .find((x) => x.role === TurnRole.action)!;
    expect(running.status).toBe("running");
    expect(running.author).toBe("summarize");

    const result = await started.done;
    expect(result.ok).toBe(true);
    const turn = store.getTurn(running.id)!;
    expect(turn.status).toBe("done");
    expect(turn.body).toContain("**Goal**");

    const call = calls.at(-1)!;
    expect(call.prompt).toContain("/riker:summarize");
    expect(call.pluginDirs).toContain(rikerPluginDir());
    expect(call.allow).toContain("Bash(git log:*)");
    expect(call.resume).toBeUndefined();
    // Not the agent: its state is untouched.
    expect(store.getTask(t.id)!.agent_state).toBe(t.agent_state);
  });

  // Its git rules match `git log`, not `git -C <dir> log`, and a checkout
  // path in the prompt leads the model to write the second.
  test("in the checkout: told to run git there, without -C", async () => {
    const wt = mkdtempSync(join(tmpdir(), "riker-wt-"));
    const t = task(Kind.coding, { worktree: wt, branch: "fix-build" });
    const started = engine.desk.runAction(t.id, "summarize");
    if ("error" in started) {
      throw new Error(started.error);
    }
    await started.done;
    const call = calls.at(-1)!;
    expect(call.cwd).toBe(wt);
    expect(call.system).toContain(SHELL_HOWTO);
    expect(SHELL_HOWTO).toContain("never with -C");
    expect(call.prompt).toContain(
      "Checkout: you run in it (branch fix-build), so run git there as is, never with -C.",
    );
    expect(call.prompt).not.toContain(`Checkout: ${wt}`);
  });

  test("fork: resumes a copy of the agent's session in its folder", async () => {
    const t = task();
    const cwd = mkdtempSync(join(tmpdir(), "riker-wt-"));
    sessionStarted({
      id: "sess-1",
      taskId: t.id,
      kind: SessionKind.tmux,
      cwd,
      startedBy: "owner",
    });
    const started = engine.desk.runAction(t.id, "summarize");
    if ("error" in started) {
      throw new Error(started.error);
    }
    await started.done;
    const call = calls.at(-1)!;
    expect(call.resume).toBe("sess-1");
    expect(call.fork).toBe(true);
    expect(call.cwd).toBe(cwd);
    expect(claudeArgs(call)).toContain("--fork-session");
  });

  test("a failure is kept on its turn", async () => {
    answer = () => ({ isError: true, text: "overloaded" });
    const t = task(Kind.general);
    const started = engine.desk.runAction(t.id, "summarize");
    if ("error" in started) {
      throw new Error(started.error);
    }
    const result = await started.done;
    expect(result.ok).toBe(false);
    const turn = store
      .turnsForTask(t.id)
      .find((x) => x.role === TurnRole.action)!;
    expect(turn.status).toBe("failed");
    expect(turn.body).toContain("overloaded");
  });

  test("the same action twice at once is refused", () => {
    const t = task(Kind.general);
    const first = engine.desk.runAction(t.id, "summarize");
    const second = engine.desk.runAction(t.id, "summarize");
    expect("error" in first).toBe(false);
    expect("error" in second && second.error).toContain("already running");
  });

  test("an unknown action names the ones there are", () => {
    const t = task(Kind.general);
    const r = engine.desk.runAction(t.id, "nope");
    expect("error" in r && r.error).toContain("summarize");
  });

  test("output file: the answer is also under What it made", async () => {
    const c = withActions({ summarize: { output: "file" } });
    const source = { ...testConfig(), get: () => c };
    const e = new Engine({ config: source });
    const t = task(Kind.general);
    const started = e.desk.runAction(t.id, "summarize");
    if ("error" in started) {
      throw new Error(started.error);
    }
    await started.done;
    const turn = store
      .turnsForTask(t.id)
      .find((x) => x.role === TurnRole.action)!;
    const files = JSON.parse(turn.files ?? "[]") as { path: string }[];
    expect(files).toHaveLength(1);
    expect(existsSync(files[0]!.path)).toBe(true);
  });
});

describe("what agents read back", () => {
  test("an action's answer is named as the action's, not the agent's", async () => {
    const t = task(Kind.general);
    const started = engine.desk.runAction(t.id, "summarize");
    if ("error" in started) {
      throw new Error(started.error);
    }
    await started.done;
    const text = transcript(store.turnsForTask(t.id));
    expect(text).toContain("ran the summarize action");
    expect(text).not.toContain("You (the agent) answered");
  });
});

describe("a pane action (quiz)", () => {
  function codingTask() {
    const wt = mkdtempSync(join(tmpdir(), "riker-wt-"));
    return task(Kind.coding, { worktree: wt });
  }

  test("no agent window: interactive claude on the Canvas, Riker's plugin loaded", async () => {
    const t = codingTask();
    const started = engine.desk.runAction(t.id, "quiz");
    if ("error" in started) {
      throw new Error(started.error);
    }
    const result = await started.done;
    expect(result.ok).toBe(true);
    const run = result.terminal!;
    expect(run.argv[0]).toBe("claude");
    expect(run.argv).toContain(rikerPluginDir());
    expect(run.argv.at(-1)).toStartWith("/riker:quiz task ");
    // A title can come from Slack or GitHub: kept out of an interactive session.
    expect(run.argv.at(-1)).not.toContain(t.title);
    expect(run.cwd).toBe(t.worktree!);
    // Its hooks see a task but no session: not taken for the agent.
    expect(run.env).toEqual({ RIKER_TASK_ID: String(t.id) });
    expect(calls).toHaveLength(0);
    const turn = store
      .turnsForTask(t.id)
      .find((x) => x.role === TurnRole.action)!;
    expect(turn.status).toBe("done");
    expect(turn.body).toContain("on the Canvas");
  });

  test("an agent window: a zoomed split of it", async () => {
    const t = codingTask();
    mux.windows.push({
      id: "@7",
      sessionId: "$1",
      name: "fix-build",
      taskId: t.id,
      cwd: t.worktree!,
      env: {},
      argv: [],
    } as never);
    const started = engine.desk.runAction(t.id, "quiz");
    if ("error" in started) {
      throw new Error(started.error);
    }
    const result = await started.done;
    expect(result.pane).toBe(true);
    expect(result.terminal).toBeUndefined();
    const split = mux.splits.at(-1)!;
    expect(split.paneId).toBe("@7");
    expect(split.zoom).toBe(true);
    expect(split.argv.slice(0, 2)).toEqual(["env", `RIKER_TASK_ID=${t.id}`]);
  });

  test("pointed at a user skill that is not there, it says where it looked", async () => {
    const claude = mkdtempSync(join(tmpdir(), "riker-claude-"));
    process.env.CLAUDE_CONFIG_DIR = claude;
    try {
      const c = withActions({ quiz: { skill: "quiz-me" } });
      const e = new Engine({ config: { ...testConfig(), get: () => c } });
      const r = e.desk.runAction(codingTask().id, "quiz");
      expect("error" in r && r.error).toContain(
        join(claude, "skills", "quiz-me"),
      );
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });
});

describe("a bare user skill, headless", () => {
  function userSkill(name: string, allowed: string) {
    const claude = mkdtempSync(join(tmpdir(), "riker-claude-"));
    mkdirSync(join(claude, "skills", name), { recursive: true });
    writeFileSync(
      join(claude, "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: x\nallowed-tools: ${allowed}\n---\nDo it.\n`,
    );
    process.env.CLAUDE_CONFIG_DIR = claude;
  }

  test("is wrapped in a plugin of its own and invoked by that name", async () => {
    userSkill("recap", "Read, Grep");
    try {
      const c = withActions({ recap: { skill: "recap", via: "headless" } });
      const e = new Engine({ config: { ...testConfig(), get: () => c } });
      const started = e.desk.runAction(task(Kind.general).id, "recap");
      if ("error" in started) {
        throw new Error(started.error);
      }
      await started.done;
      const call = calls.at(-1)!;
      expect(call.prompt).toContain(`/${WRAP_PLUGIN}:recap`);
      const dir = call.pluginDirs!.find((d) => d.includes("wrapped"))!;
      expect(lstatSync(join(dir, "skills", "recap")).isSymbolicLink()).toBe(
        true,
      );
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  test("one that asks for more than its capability grants is refused", () => {
    userSkill("pusher", "Bash(git push:*)");
    try {
      const c = withActions({ pusher: { skill: "pusher", via: "headless" } });
      const e = new Engine({ config: { ...testConfig(), get: () => c } });
      const r = e.desk.runAction(task(Kind.general).id, "pusher");
      expect("error" in r && r.error).toContain("Bash(git push:*)");
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });
});

describe("as a move", () => {
  test("starts it and answers at once; without a name, lists them", async () => {
    const t = task(Kind.general);
    const ref = store.taskRef(t.id);
    const list = await runMove(engine.desk, "action", { task: ref });
    expect(list.result).toContain("summarize (Summarize the work so far)");
    const run = await runMove(engine.desk, "action", {
      task: ref,
      name: "summarize",
    });
    expect(run.ok).toBe(true);
    expect(run.result).toContain("started summarize");
    expect(
      store.turnsForTask(t.id).some((x) => x.role === TurnRole.action),
    ).toBe(true);
  });

  test("a pane action needs the TUI; an agent cannot run one", async () => {
    const t = task(Kind.coding, {
      worktree: mkdtempSync(join(tmpdir(), "riker-wt-")),
    });
    const ref = store.taskRef(t.id);
    const quiz = await runMove(engine.desk, "action", {
      task: ref,
      name: "quiz",
    });
    expect(quiz.ok).toBe(false);
    expect(quiz.result).toContain("needs the TUI");
    const agent = await runMove(
      engine.desk,
      "action",
      { task: ref, name: "summarize" },
      `agent ${ref}`,
    );
    expect(agent.ok).toBe(false);
    expect(agent.result).toContain("owner's move");
  });
});

// A coding task's live agent takes its Canvas, so the TUI
// offers each action's last answer to read over it.
describe("reading an answer again", () => {
  test("each action's last finished answer, newest first", async () => {
    const t = task(Kind.coding, {
      worktree: mkdtempSync(join(tmpdir(), "riker-wt-")),
    });
    answer = () => ({ text: "first summary" });
    const one = engine.desk.runAction(t.id, "summarize");
    if ("error" in one) {
      throw new Error(one.error);
    }
    await one.done;
    answer = () => ({ text: "second summary" });
    const two = engine.desk.runAction(t.id, "summarize");
    if ("error" in two) {
      throw new Error(two.error);
    }
    expect(two.turnId).toBeDefined();
    // Still running: nothing new to read yet, the last one still is.
    expect(actionAnswers(store.turnsForTask(t.id)).map((x) => x.body)).toEqual([
      "first summary",
    ]);
    await two.done;
    const quiz = store.addTurn({
      taskId: t.id,
      role: TurnRole.action,
      author: "quiz",
      body: "Opened on the Canvas",
    });
    const answers = actionAnswers(
      store.turnsForTask(t.id),
      (name) => name === "quiz",
    );
    expect(answers.map((x) => x.id)).toEqual([two.turnId!]);
    expect(answers[0]!.body).toBe("second summary");
    expect(actionAnswers(store.turnsForTask(t.id)).map((x) => x.id)).toEqual([
      quiz.id,
      two.turnId!,
    ]);
  });

  test("a move says where its answer shows", async () => {
    const t = task(Kind.coding, {
      worktree: mkdtempSync(join(tmpdir(), "riker-wt-")),
    });
    const run = await runMove(engine.desk, "action", {
      task: store.taskRef(t.id),
      name: "summarize",
    });
    expect(run.result).toContain("Read");
  });
});

describe("triggers", () => {
  function engineWith(actions: Record<string, unknown>) {
    const c = withActions(actions);
    return new Engine({ config: { ...testConfig(), get: () => c } });
  }

  const reviewAsk = {
    channel: "github",
    author: "octocat",
    author_name: "octocat",
    title: "Add div",
    body: "please review",
    meta: JSON.stringify({ repo: "a/b", reason: "review_requested" }),
  } as MessageRow;

  test("triaged: plain rules on the message and the task pick the action, once", async () => {
    const e = engineWith({
      summarize: {
        on: [
          {
            event: "triaged",
            kind: "coding",
            channel: "github",
            githubReason: ["review_requested"],
          },
        ],
      },
    });
    const t = task();
    const outcome = {
      verdict: "coding",
      taskId: t.id,
      reason: "",
      effects: [],
    } as never;
    e.desk.afterTriage(outcome, reviewAsk);
    e.desk.afterTriage(outcome, reviewAsk);
    await e.desk.actionsSettled();
    const turns = store
      .turnsForTask(t.id)
      .filter((x) => x.role === TurnRole.action);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.about).toBe("Summarize the work so far (on triaged)");

    // Another reason, another kind: no match.
    const other = task(Kind.general);
    e.desk.afterTriage(
      { ...(outcome as object), taskId: other.id } as never,
      reviewAsk,
    );
    const mention = {
      ...reviewAsk,
      meta: JSON.stringify({ reason: "mention" }),
    } as MessageRow;
    const t2 = task();
    e.desk.afterTriage(
      { ...(outcome as object), taskId: t2.id } as never,
      mention,
    );
    await e.desk.actionsSettled();
    expect(
      store.turnsForTask(other.id).some((x) => x.role === TurnRole.action),
    ).toBe(false);
    expect(
      store.turnsForTask(t2.id).some((x) => x.role === TurnRole.action),
    ).toBe(false);
  });

  test("the owner's own message on a thread triggers nothing", async () => {
    const e = engineWith({ summarize: { on: [{ event: "triaged" }] } });
    const t = task(Kind.general);
    e.desk.afterTriage(
      { verdict: "own", taskId: t.id, reason: "", effects: [] } as never,
      reviewAsk,
    );
    await e.desk.actionsSettled();
    expect(
      store.turnsForTask(t.id).some((x) => x.role === TurnRole.action),
    ).toBe(false);
  });

  test("a timer coming due triggers nothing: it is not something that came in", async () => {
    const e = engineWith({ summarize: { on: [{ event: "triaged" }] } });
    const t = task(Kind.general);
    e.pool.request = () => null;
    e.desk.afterTriage(
      { verdict: "timer", taskId: t.id, reason: "", effects: [] },
      { ...reviewAsk, channel: "timer" },
    );
    await e.desk.actionsSettled();
    expect(
      store.turnsForTask(t.id).some((x) => x.role === TurnRole.action),
    ).toBe(false);
  });

  test("lifecycle: task events since the last look, history left alone", async () => {
    const e = engineWith({ summarize: { on: [{ event: "done" }] } });
    const before = task(Kind.general);
    store.updateTask(before.id, {
      status: TaskStatus.done,
      closed_at: "2026-11-20T00:00:00Z",
    });
    // The first look only sets the cursor.
    expect(e.fireEventActions()).toBe(0);
    const t = task(Kind.general);
    store.updateTask(t.id, {
      status: TaskStatus.done,
      closed_at: "2026-11-20T00:00:00Z",
    });
    expect(e.fireEventActions()).toBe(1);
    expect(e.fireEventActions()).toBe(0);
    await e.desk.actionsSettled();
    expect(
      store.turnsForTask(t.id).some((x) => x.role === TurnRole.action),
    ).toBe(true);
    expect(
      store.turnsForTask(before.id).some((x) => x.role === TurnRole.action),
    ).toBe(false);
  });

  test("ready is the agent's finished work; merged is the merge", async () => {
    const e = engineWith({
      summarize: { on: [{ event: "ready" }] },
      recap: {
        skill: "riker:summarize",
        via: "headless",
        on: [{ event: "merged" }],
      },
    });
    e.fireEventActions();
    const t = task(Kind.general);
    sessionStarted({
      id: "s-ready",
      taskId: t.id,
      kind: SessionKind.tmux,
      cwd: tmpdir(),
      startedBy: "owner",
    });
    workFinished(
      { taskId: t.id, sessionId: "s-ready" },
      { summary: "did it", closes: false },
    );
    store.updateTask(t.id, { merged_at: "2026-11-20T00:00:00Z" });
    expect(e.fireEventActions()).toBe(2);
    await e.desk.actionsSettled();
    const abouts = store
      .turnsForTask(t.id)
      .filter((x) => x.role === TurnRole.action)
      .map((x) => x.about);
    expect(abouts).toContain("Summarize the work so far (on ready)");
    expect(abouts).toContain("recap (on merged)");
  });

  test("a run that never started is not counted: the next event tries again", async () => {
    const e = engineWith({
      recap: { skill: "nope", via: "headless", on: [{ event: "done" }] },
    });
    const t = task(Kind.general);
    expect(e.desk.fireActions("done", t.id)).toEqual(["recap"]);
    await e.desk.actionsSettled();
    expect(e.desk.fireActions("done", t.id)).toEqual(["recap"]);
  });

  test("a pane action never runs by itself; an unknown event is left out", () => {
    const c = withActions({
      quiz: { on: [{ event: "triaged" }, { event: "someday" }] },
    });
    const quiz = registeredActions(c).find((a) => a.name === "quiz")!;
    expect(quiz.on!.map((t) => t.event)).toEqual(["triaged"]);
    const e = new Engine({ config: { ...testConfig(), get: () => c } });
    const t = task(Kind.coding, {
      worktree: mkdtempSync(join(tmpdir(), "riker-wt-")),
    });
    expect(e.desk.fireActions("triaged", t.id, reviewAsk)).toEqual([]);
  });
});
