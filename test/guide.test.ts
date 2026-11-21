import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setBrain, type BrainResult } from "../src/core/brain";
import { Engine } from "../src/core/engine";
import {
  fitGuide,
  freePort,
  parseGuide,
  postComments,
  patchFor,
  patchHunks,
  setGuideTool,
} from "../src/core/guide";
import { setMux } from "../src/core/mux";
import * as store from "../src/core/store";
import { Kind, TurnRole } from "../src/core/types";
import { FakeMux } from "./fake-mux";
import { freshHome, testConfig } from "./helpers";

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
    expect(findings).toBe(2);
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

describe("posting the comments", () => {
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

  function answering(text: string) {
    setBrain(
      async (): Promise<BrainResult> => ({
        text,
        structured: null,
        sessionId: null,
        durationMs: 1,
        isError: false,
      }),
    );
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
