import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postComments, readFindings, setGuideTool } from "@riker/code-review-plannotator/guide";
import { fakeReview } from "@riker/code-review-plannotator/test/support/fake-review";
import { ANSWER, bigAnswer, bigRepo, repo, sh } from "@riker/code-review-plannotator/test/support/repo";
import { setBrain, type BrainResult } from "../src/brain";
import { Engine } from "../src/engine";
import { OPEN_REVIEW_TITLE } from "../src/guide-turn";
import { paths } from "../src/paths";
import { startAction } from "../src/run-action";
import { actionNamed } from "../src/task-actions";
import { setMux } from "../src/mux";
import * as store from "../src/store";
import { actionRailWord } from "../src/rows";
import { Kind, TurnRole } from "../src/types";
import { FakeMux } from "./support/fake-mux";
import { freshHome, testConfig } from "./support/helpers";

describe("the guide action", () => {
  let saved: { file: string; cwd: string; pr?: string }[];

  beforeEach(() => {
    freshHome({ autostart: false });
    setMux(new FakeMux());
    saved = [];
    setGuideTool({
      async save(file, cwd, pr) {
        saved.push({ file, cwd, pr });
        return { id: "1795-add-div" };
      },
    });
  });
  afterEach(() => setGuideTool(null));

  let prompts: string[];

  function answering(text: string, denied?: string[]) {
    prompts = [];
    setBrain(async (call): Promise<BrainResult> => {
      prompts.push(call.prompt);
      return {
        text,
        structured: null,
        sessionId: null,
        durationMs: 1,
        isError: false,
        ...(denied ? { denied } : {}),
      };
    });
  }

  function codingTask(worktree: string) {
    const engine = new Engine({ config: testConfig() });
    const t = engine.desk.newTask("Add div", Kind.coding);
    store.updateTask(t.id, { worktree });
    return { engine, task: store.getTask(t.id)! };
  }

  test("saves a v4 snapshot into Plannotator and opens its review", async () => {
    const dir = repo();
    answering(`\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``);
    const { engine, task } = codingTask(dir);
    const started = engine.desk.runAction(task.id, "guide");
    if ("error" in started) throw new Error(started.error);
    const result = await started.done;
    expect(result.ok).toBe(true);

    expect(saved).toHaveLength(1);
    expect(saved[0]!.cwd).toBe(dir);
    const snap = JSON.parse(readFileSync(saved[0]!.file, "utf8")) as {
      version: number;
      review: { rawPatch: string };
    };
    expect(snap.version).toBe(4);
    expect(snap.review.rawPatch).toContain("+export function div");

    expect(result.terminal!.argv.join(" ")).toContain("plannotator review --json --base");
    expect(result.terminal!.cwd).toBe(dir);
    expect(result.terminal!.feedback).toEndWith("guide-feedback.md");
    // The review comes up on a port Riker chose, so it can post the notes there.
    const port = result.terminal!.comments!.port;
    expect(result.terminal!.env.PLANNOTATOR_PORT).toBe(String(port));
    expect(result.terminal!.comments!.list.map((c) => c.scope)).toEqual(["line", "file"]);

    const turn = store.turnsForTask(task.id).find((x) => x.role === TurnRole.action)!;
    expect(turn.status).toBe("done");
    expect(turn.body).toContain("2 review notes (1 not on a changed line)");
    expect(turn.body).toContain("Bug: b of 0 gives Infinity.");
    expect(turn.body).toContain("1795-add-div");
  });

  test("its findings are kept beside the guide, and its review opens again with no run", async () => {
    const dir = repo();
    answering(`\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``);
    const { engine, task } = codingTask(dir);
    expect(engine.desk.hasGuideReview(task.id)).toBe(false);
    expect(engine.desk.guideReview(task.id)).toHaveProperty("error");
    const started = engine.desk.runAction(task.id, "guide");
    if ("error" in started) throw new Error(started.error);
    const first = await started.done;

    const kept = readFindings(paths.work(task.id))!;
    expect(kept).toMatchObject({ id: "1795-add-div", title: "Add div", base: "main" });
    expect(kept.findings.map((f) => f.file)).toEqual(["math.ts", "math.ts"]);
    expect(engine.desk.hasGuideReview(task.id)).toBe(true);

    let asked = 0;
    setBrain(async (): Promise<BrainResult> => {
      asked++;
      return { text: "", structured: null, sessionId: null, durationMs: 1, isError: false };
    });
    const again = engine.desk.guideReview(task.id);
    if ("error" in again) throw new Error(again.error);
    expect(asked).toBe(0);
    expect(again.terminal!.argv.join(" ")).toContain("plannotator review --json --base");
    expect(again.terminal!.feedback).toBe(first.terminal!.feedback);
    expect(again.terminal!.comments!.list).toEqual(first.terminal!.comments!.list);
    const port = again.terminal!.comments!.port;
    expect(again.terminal!.env.PLANNOTATOR_PORT).toBe(String(port));

    // Posted into the review on that port, once.
    const review = fakeReview(port);
    const posted = await postComments(port, again.terminal!.comments!.list, { waitMs: 3000, everyMs: 50 });
    void review.server.stop(true);
    expect(posted).toEqual({ ok: true });
    expect(review.calls[0]).toBe("DELETE /api/external-annotations?source=riker-guide");
    expect(review.held().map((c) => c.scope)).toEqual(["line", "file"]);
  });

  test("a review opened after the change moved on fits the findings to it", async () => {
    const dir = repo();
    answering(`\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``);
    const { engine, task } = codingTask(dir);
    const started = engine.desk.runAction(task.id, "guide");
    if ("error" in started) throw new Error(started.error);
    await started.done;

    // div is taken out again: math.ts is no longer in the change.
    sh(dir, "git", "checkout", "main", "--", "math.ts");
    const later = engine.desk.guideReview(task.id);
    if ("error" in later) throw new Error(later.error);
    expect(later.terminal!.comments!.list).toEqual([]);
    expect(later.text).toContain("2 notes on files no longer changed left out");
  });

  test("a guide a trigger ran opens nothing; its turn says how to open the review", async () => {
    const dir = repo();
    answering(`\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``);
    const { engine, task } = codingTask(dir);
    const config = engine.desk.config();
    const run = startAction(config, task, actionNamed(config, "guide")!, "triaged");
    if ("error" in run) throw new Error(run.error);
    const result = await run.done;
    expect(result.ok).toBe(true);
    expect(result.terminal).toBeUndefined();
    const turn = store.turnsForTask(task.id).find((x) => x.role === TurnRole.action)!;
    expect(turn.body).toContain(OPEN_REVIEW_TITLE);
    expect(turn.body).not.toContain("The review Riker opens");
    expect(engine.desk.hasGuideReview(task.id)).toBe(true);
  });

  test("the diff is in the prompt, numbered, and the run is headless", async () => {
    const dir = repo();
    answering(`\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``);
    const { engine, task } = codingTask(dir);
    const started = engine.desk.runAction(task.id, "guide");
    if ("error" in started) throw new Error(started.error);
    await started.done;
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("job: whole");
    // div is new line 5.
    expect(prompts[0]).toMatch(/^\s+5 \+export function div/m);
  });

  test("no change against the base is refused before the run spends anything", () => {
    const dir = repo();
    sh(dir, "git", "checkout", "-q", "main");
    answering("unused");
    const { engine, task } = codingTask(dir);
    const started = engine.desk.runAction(task.id, "guide");
    expect("error" in started && started.error).toContain("no change against main");
    expect(prompts).toHaveLength(0);
  });

  test("a run that had a read denied says it may have missed things, not that nothing stood out", async () => {
    const dir = repo();
    const bare = { ...ANSWER, sections: [{ ...ANSWER.sections[0]!, diffs: [{ file: "math.ts", summary: "Adds `div`." }] }] };
    answering(`\`\`\`json\n${JSON.stringify(bare)}\n\`\`\``, ["Bash mb=$(git merge-base main HEAD); git diff $mb"]);
    const { engine, task } = codingTask(dir);
    const started = engine.desk.runAction(task.id, "guide");
    if ("error" in started) throw new Error(started.error);
    const result = await started.done;
    expect(result.ok).toBe(true);
    expect(result.text).toContain("a read was denied");
    const turn = store.turnsForTask(task.id).find((x) => x.role === TurnRole.action)!;
    expect(turn.body).toContain("A read was denied (`Bash mb=$(git merge-base main HEAD); git diff $mb`)");
    expect(turn.body).toContain("No review notes.");
    expect(turn.body).not.toContain("nothing stood out");
  });

  test("a worktree that is gone is refused before the run spends anything", () => {
    let asked = 0;
    setBrain(async (): Promise<BrainResult> => {
      asked++;
      return { text: "", structured: null, sessionId: null, durationMs: 1, isError: false };
    });
    const { engine, task } = codingTask(join(tmpdir(), "riker-guide-gone-worktree"));
    const started = engine.desk.runAction(task.id, "guide");
    expect("error" in started && started.error).toContain("is gone");
    expect(asked).toBe(0);
  });

  test("an answer that is not a guide fails, and is kept as a file", async () => {
    const dir = repo();
    answering("I could not write it.");
    const { engine, task } = codingTask(dir);
    const started = engine.desk.runAction(task.id, "guide");
    if ("error" in started) throw new Error(started.error);
    const result = await started.done;
    expect(result.ok).toBe(false);
    expect(saved).toHaveLength(0);
    const turn = store.turnsForTask(task.id).find((x) => x.role === TurnRole.action)!;
    expect(turn.status).toBe("failed");
    expect(turn.body).toContain("not JSON");
    const files = JSON.parse(turn.files ?? "[]") as { path: string }[];
    expect(readFileSync(files[0]!.path, "utf8")).toContain("could not write it");
  });

  test("a run in batches says on its turn which stage it is in, read by the rail, then where it ended", async () => {
    const dir = bigRepo(5);
    const { engine, task } = codingTask(dir);
    // What the turn says, as the rail reads it, at each call and at the save.
    const seen: string[] = [];
    const look = () => {
      const turn = store.latestActionTurns().get(task.id)!;
      seen.push(`${turn.status} | ${turn.progress} | ${actionRailWord(turn, new Date())!.text}`);
    };
    setBrain(async (call): Promise<BrainResult> => {
      look();
      await Bun.sleep(1);
      const job = /job: (.*)$/m.exec(call.prompt)![1]!;
      const text = job.startsWith("notes")
        ? JSON.stringify({ files: [{ file: `part${/batch (\d+)/.exec(job)![1]}.ts`, summary: "A part." }] })
        : JSON.stringify(bigAnswer(5));
      return { text, structured: null, sessionId: null, durationMs: 1, isError: false };
    });
    setGuideTool({
      async save() {
        look();
        return { id: "big" };
      },
    });
    const started = engine.desk.runAction(task.id, "guide");
    if ("error" in started) throw new Error(started.error);
    const result = await started.done;
    expect(result.ok).toBe(true);
    expect(seen).toEqual([
      "running | batches 0/5 done, 3 running | guide: batches 0/5 done, 3 running",
      "running | batches 0/5 done, 3 running | guide: batches 0/5 done, 3 running",
      "running | batches 0/5 done, 3 running | guide: batches 0/5 done, 3 running",
      "running | batches 3/5 done, 2 running | guide: batches 3/5 done, 2 running",
      "running | batches 3/5 done, 2 running | guide: batches 3/5 done, 2 running",
      "running | writing the chapters | guide: writing the chapters",
      "running | saving to Plannotator | guide: saving to Plannotator",
    ]);
    const turn = store.latestActionTurns().get(task.id)!;
    expect(turn.status).toBe("done");
    expect(actionRailWord(turn, new Date())).toEqual({ text: "guide done", running: false, failed: false });
    // The rail lets it go after a while.
    expect(actionRailWord(turn, new Date(Date.now() + 3 * 60_000))).toBeNull();
  });

  test("a failed guide keeps the stage it stopped at, and the rail says it failed", async () => {
    const dir = bigRepo(2);
    const { engine, task } = codingTask(dir);
    setBrain(async (call): Promise<BrainResult> => {
      const job = /job: (.*)$/m.exec(call.prompt)![1]!;
      return {
        text: job.startsWith("notes") ? JSON.stringify({ files: [] }) : "no guide here",
        structured: null,
        sessionId: null,
        durationMs: 1,
        isError: false,
      };
    });
    const started = engine.desk.runAction(task.id, "guide");
    if ("error" in started) throw new Error(started.error);
    expect((await started.done).ok).toBe(true); // unwritten chapters still save
    setGuideTool({ async save() { return { error: "refused" }; } });
    const again = engine.desk.runAction(task.id, "guide");
    if ("error" in again) throw new Error(again.error);
    expect((await again.done).ok).toBe(false);
    const turn = store.latestActionTurns().get(task.id)!;
    expect(turn.status).toBe("failed");
    expect(turn.progress).toBe("saving to Plannotator");
    expect(actionRailWord(turn, new Date())).toEqual({ text: "guide failed", running: false, failed: true });
  });

  test("a guide a trigger started shows its stages the same way", async () => {
    const dir = bigRepo(2);
    const { engine, task } = codingTask(dir);
    const stages: (string | null)[] = [];
    setBrain(async (call): Promise<BrainResult> => {
      stages.push(store.latestActionTurns().get(task.id)!.progress);
      const job = /job: (.*)$/m.exec(call.prompt)![1]!;
      const text = job.startsWith("notes") ? JSON.stringify({ files: [] }) : JSON.stringify(bigAnswer(2));
      return { text, structured: null, sessionId: null, durationMs: 1, isError: false };
    });
    const config = engine.desk.config();
    const run = startAction(config, task, actionNamed(config, "guide")!, "triaged");
    if ("error" in run) throw new Error(run.error);
    expect((await run.done).ok).toBe(true);
    expect(stages).toEqual([
      "batches 0/2 done, 2 running",
      "batches 0/2 done, 2 running",
      "writing the chapters",
    ]);
    expect(store.latestActionTurns().get(task.id)!.about).toEndWith("(on triaged)");
  });
});
