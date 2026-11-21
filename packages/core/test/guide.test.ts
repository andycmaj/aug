import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setBrain, type BrainResult } from "../src/brain";
import { Engine } from "../src/engine";
import {
  fitGuide,
  freePort,
  OPEN_REVIEW_TITLE,
  parseGuide,
  postComments,
  patchFor,
  patchHunks,
  readFindings,
  reviewComments,
  reviewNotes,
  numberedPatch,
  setGuideTool,
  type ReviewComment,
} from "../src/guide";
import { paths } from "../src/paths";
import { startAction } from "../src/run-action";
import { actionNamed } from "../src/task-actions";
import { setMux } from "../src/mux";
import * as store from "../src/store";
import { Kind, TurnRole } from "../src/types";
import { FakeMux } from "./support/fake-mux";
import { freshHome, testConfig } from "./support/helpers";

function sh(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
}

// A repo on a feature branch that adds div to math.ts and a README line.
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aug-guide-"));
  const git = (...a: string[]) =>
    sh(dir, "git", "-c", "user.email=t@t", "-c", "user.name=t", ...a);
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "math.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
  writeFileSync(join(dir, "README.md"), "# math\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "feature");
  writeFileSync(
    join(dir, "math.ts"),
    "export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport function div(a: number, b: number) {\n  return a / b;\n}\n",
  );
  writeFileSync(join(dir, "README.md"), "# math\n\nAdds and divides.\n");
  git("commit", "-qam", "div");
  return dir;
}

const ANSWER = {
  title: "Add div",
  intent: "Division for the calculator.",
  sections: [
    {
      title: "Division",
      overview: "A new `div` function.",
      diffs: [
        {
          file: "math.ts",
          summary: "Adds `div`.",
          notes: [
            { lineStart: 6, lineEnd: 6, text: "Bug: b of 0 gives Infinity." },
            { lineStart: 40, lineEnd: 40, text: "Nit: outside every hunk." },
          ],
        },
        { file: "invented.ts", summary: "not in the patch" },
      ],
    },
  ],
  unplacedFiles: [],
};

describe("the guide's JSON", () => {
  test("is read from a json fence", () => {
    const g = parseGuide(`Here:\n\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\`\n`);
    if ("error" in g) throw new Error(g.error);
    expect(g.sections[0]!.diffs[0]!.notes).toHaveLength(2);
  });

  test("not JSON, or no chapters, says so", () => {
    expect(parseGuide("no")).toHaveProperty("error");
    expect(parseGuide('{"title":"x","sections":[]}')).toHaveProperty("error");
  });
});

describe("fitted to the patch", () => {
  test("files it lacks go, files it left out are unplaced, every note is a review comment", () => {
    const dir = repo();
    const patch = patchFor(dir, "main");
    if ("error" in patch) throw new Error(patch.error);
    expect([...patchHunks(patch.text).keys()].sort()).toEqual(["README.md", "math.ts"]);

    const parsed = parseGuide(JSON.stringify(ANSWER));
    if ("error" in parsed) throw new Error(parsed.error);
    const { guide, findings, comments } = fitGuide(parsed, patch.text);
    expect(findings.map((f) => f.note.lineStart)).toEqual([6, 40]);
    const section = guide.sections[0]!;
    expect(section.diffs.map((d) => d.file)).toEqual(["math.ts"]);
    expect(section.diffs[0]!.notes!.map((n) => n.lineStart)).toEqual([6]);
    expect(section.overview).toBe("A new `div` function.");
    expect(guide.unplacedFiles).toEqual(["README.md"]);
    // On its line when a hunk shows it; on its file, naming the line, when not.
    expect(comments).toEqual([
      {
        source: "aug-guide",
        author: "aug guide",
        scope: "line",
        filePath: "math.ts",
        lineStart: 6,
        lineEnd: 6,
        side: "new",
        type: "concern",
        text: "Bug: b of 0 gives Infinity.",
      },
      {
        source: "aug-guide",
        author: "aug guide",
        scope: "file",
        filePath: "math.ts",
        type: "comment",
        text: "L40: Nit: outside every hunk.",
      },
    ]);
  });

  test("a new file not yet added is in the patch", () => {
    const dir = repo();
    writeFileSync(join(dir, "mod.ts"), "export const m = 1;\n");
    const patch = patchFor(dir, "main");
    if ("error" in patch) throw new Error(patch.error);
    expect([...patchHunks(patch.text).keys()]).toContain("mod.ts");
    // The agent's index is left as it was.
    expect(sh(dir, "git", "status", "--porcelain")).toContain("?? mod.ts");
  });

  test("master when there is no main", () => {
    const dir = repo();
    sh(dir, "git", "branch", "-m", "main", "master");
    const patch = patchFor(dir, "main");
    if ("error" in patch) throw new Error(patch.error);
    expect(patch.base).toBe("master");
  });
});

describe("refit to a later patch", () => {
  test("lines a hunk still shows stay on them, others go to the file, files out of the change are left out", () => {
    const patch = [
      "diff --git a/math.ts b/math.ts",
      "--- a/math.ts",
      "+++ b/math.ts",
      "@@ -3,0 +4,6 @@",
      "+x",
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1,3 @@",
      "+y",
      "",
    ].join("\n");
    const { comments, dropped } = reviewComments(
      [
        { file: "math.ts", note: { lineStart: 6, lineEnd: 7, text: "Bug: in the hunk" } },
        { file: "math.ts", note: { lineStart: 12, lineEnd: 12, text: "Nit: moved out of it" } },
        { file: "gone.ts", note: { lineStart: 1, lineEnd: 1, text: "Risk: file reverted" } },
      ],
      patch,
    );
    expect(dropped).toBe(1);
    expect(comments.map((c) => [c.scope, c.filePath, c.lineStart ?? null, c.text])).toEqual([
      ["line", "math.ts", 6, "Bug: in the hunk"],
      ["file", "math.ts", null, "L12: Nit: moved out of it"],
    ]);
  });
});

// A stand-in for `plannotator review`: answers /api/diff, keeps what aug
// posts, and clears by source as Plannotator does.
function fakeReview(port = 0) {
  const calls: string[] = [];
  let held: ReviewComment[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/diff") return Response.json({ rawPatch: "" });
      calls.push(`${req.method} ${url.pathname}${url.search}`);
      if (req.method === "DELETE") {
        const source = url.searchParams.get("source");
        held = source ? held.filter((c) => c.source !== source) : [];
        return Response.json({ ok: true });
      }
      const body = (await req.json()) as { annotations: ReviewComment[] };
      held.push(...body.annotations);
      return Response.json({ ids: body.annotations.map(() => "x") }, { status: 201 });
    },
  });
  return { server, calls, held: () => held };
}

describe("what the review sends back", () => {
  test("an approval or a review closed without feedback is nothing to pass on", () => {
    expect(reviewNotes("")).toBeNull();
    expect(reviewNotes("The user approved.\n")).toBeNull();
    expect(reviewNotes("Review session closed without feedback.\n")).toBeNull();
    expect(reviewNotes("# Code Review Feedback\n\nBug: x\n")).toBe("# Code Review Feedback\n\nBug: x");
  });
});

describe("posting the comments", () => {
  test("aug's earlier comments are cleared before posting, so they are there once", async () => {
    const review = fakeReview();
    const comment: ReviewComment = {
      source: "aug-guide",
      author: "aug guide",
      scope: "file",
      filePath: "math.ts",
      type: "comment",
      text: "L1: Nit: x",
    };
    await postComments(review.server.port!, [comment], { waitMs: 3000, everyMs: 50 });
    await postComments(review.server.port!, [comment], { waitMs: 3000, everyMs: 50 });
    void review.server.stop(true);
    expect(review.calls).toEqual([
      "DELETE /api/external-annotations?source=aug-guide",
      "POST /api/external-annotations",
      "DELETE /api/external-annotations?source=aug-guide",
      "POST /api/external-annotations",
    ]);
    expect(review.held()).toEqual([comment]);
  });

  test("waits for the review to come up, then posts them as one batch", async () => {
    const port = freePort();
    const got: unknown[] = [];
    // Plannotator starts a moment after aug begins posting.
    let server: ReturnType<typeof Bun.serve> | null = null;
    setTimeout(() => {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        async fetch(req) {
          const path = new URL(req.url).pathname;
          if (path === "/api/diff") return Response.json({ rawPatch: "" });
          if (req.method === "DELETE") return Response.json({ ok: true });
          got.push({ path, body: await req.json() });
          return Response.json({ ids: ["a"] }, { status: 201 });
        },
      });
    }, 150);
    const comment = {
      source: "aug-guide",
      author: "aug guide",
      scope: "file" as const,
      filePath: "math.ts",
      type: "comment" as const,
      text: "L1: Nit: x",
    };
    const r = await postComments(port, [comment], { waitMs: 3000, everyMs: 50 });
    void server!.stop(true);
    expect(r).toEqual({ ok: true });
    expect(got).toEqual([{ path: "/api/external-annotations", body: { annotations: [comment] } }]);
  });

  test("a port something else took gets nothing", async () => {
    let posted = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        if (req.method === "POST") posted++;
        return new Response("not found", { status: 404 });
      },
    });
    const r = await postComments(server.port!, [{ source: "s", author: "a", scope: "file", filePath: "f", type: "comment", text: "t" }], { waitMs: 3000, everyMs: 50 });
    void server.stop(true);
    expect("error" in r && r.error).toContain("is not a Plannotator review");
    expect(posted).toBe(0);
  });

  test("a refusal is not retried, and nothing answering gives up", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/api/diff"
          ? Response.json({ rawPatch: "" })
          : Response.json({ error: "annotations[0] missing" }, { status: 400 }),
    });
    const refused = await postComments(server.port!, [{ source: "s", author: "a", scope: "file", filePath: "f", type: "comment", text: "t" }], { waitMs: 3000, everyMs: 50 });
    void server.stop(true);
    expect("error" in refused && refused.error).toContain("refused the comments (400)");

    const silent = await postComments(freePort(), [{ source: "s", author: "a", scope: "file", filePath: "f", type: "comment", text: "t" }], { waitMs: 200, everyMs: 50 });
    expect(silent).toHaveProperty("error");
  });
});

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

    expect(result.terminal!.argv.join(" ")).toContain("plannotator review --base");
    expect(result.terminal!.cwd).toBe(dir);
    expect(result.terminal!.feedback).toEndWith("guide-feedback.md");
    // The review comes up on a port aug chose, so it can post the notes there.
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
    expect(again.terminal!.argv.join(" ")).toContain("plannotator review --base");
    expect(again.terminal!.feedback).toBe(first.terminal!.feedback);
    expect(again.terminal!.comments!.list).toEqual(first.terminal!.comments!.list);
    const port = again.terminal!.comments!.port;
    expect(again.terminal!.env.PLANNOTATOR_PORT).toBe(String(port));

    // Posted into the review on that port, once.
    const review = fakeReview(port);
    const posted = await postComments(port, again.terminal!.comments!.list, { waitMs: 3000, everyMs: 50 });
    void review.server.stop(true);
    expect(posted).toEqual({ ok: true });
    expect(review.calls[0]).toBe("DELETE /api/external-annotations?source=aug-guide");
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
    expect(turn.body).not.toContain("The review aug opens");
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
    const { engine, task } = codingTask(join(tmpdir(), "aug-guide-gone-worktree"));
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
});
