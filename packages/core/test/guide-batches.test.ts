import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { patchFor, type Patch } from "../src/guide";
import {
  definedNames,
  isLockfile,
  planBatches,
  relate,
  splitPatch,
  stem,
  type FilePatch,
} from "../src/guide-batches";
import { reviewInBatches, type GuideAsk } from "../src/guide-run";

function sh(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
}
const git = (cwd: string, ...a: string[]) =>
  sh(cwd, "git", "-c", "user.email=t@t", "-c", "user.name=t", ...a);

function write(dir: string, files: Record<string, string>) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

// A repo on main with `base`, then a feature branch with one commit per
// entry of `commits`.
function repo(base: Record<string, string>, commits: Record<string, string>[]): string {
  const dir = mkdtempSync(join(tmpdir(), "aug-batches-"));
  git(dir, "init", "-q", "-b", "main");
  write(dir, { "README.md": "# r\n", ...base });
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  git(dir, "checkout", "-qb", "feature");
  commits.forEach((files, i) => {
    write(dir, files);
    git(dir, "add", ".");
    git(dir, "commit", "-qm", `step ${i}`);
  });
  return dir;
}

function fp(file: string, body: string): FilePatch {
  return { file, text: `diff --git a/${file} b/${file}\n@@ -1 +1 @@\n${body}\n`, added: 1, removed: 0 };
}

describe("cutting the patch", () => {
  test("one entry per file, with its counts; lock files are known", () => {
    const files = splitPatch(
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,2 +1,2 @@",
        " keep",
        "-old",
        "+new",
        "+more",
        "diff --git a/bun.lock b/bun.lock",
        "@@ -1 +1 @@",
        "+x",
        "",
      ].join("\n"),
    );
    expect(files.map((f) => [f.file, f.added, f.removed])).toEqual([
      ["a.ts", 2, 1],
      ["bun.lock", 1, 0],
    ]);
    expect(isLockfile("web/package-lock.json")).toBe(true);
    expect(isLockfile("go.sum")).toBe(true);
    expect(isLockfile("src/lock.ts")).toBe(false);
  });

  test("a test's stem is what it tests", () => {
    expect(stem("test/guide.test.ts")).toBe("guide");
    expect(stem("tests/test_guide.py")).toBe("guide");
    expect(stem("pkg/guide_test.go")).toBe("guide");
    expect(stem("src/GuideSpec.scala")).toBe("guide");
    expect(stem("src/contest.ts")).toBe("contest");
  });

  test("names a diff defines, from changed lines and hunk headers", () => {
    const names = definedNames({
      file: "a.ts",
      text: "@@ -1 +1 @@ export function outerThing() {\n+export const planBatches = 1;\n+  return x;\n def handle_it(self):\n",
      added: 2,
      removed: 0,
    });
    expect([...names].sort()).toEqual(["outerThing", "planBatches"]);
  });
});

describe("related files", () => {
  test("a commit, a test and its code, a name used elsewhere, an import each join files", () => {
    const files = [
      fp("src/a.ts", "+export function computeTotals() {}"),
      fp("src/b.ts", "+const t = computeTotals();"),
      fp("src/calc.ts", "+export const c = 1;"),
      fp("test/calc.test.ts", "+expect(c).toBe(1);"),
      fp("src/money.ts", "+export const dee = 2;"),
      fp("src/e.ts", '+import { dee } from "./money";'),
      fp("docs/x.md", "+words"),
      fp("docs/y.md", "+other words"),
      fp("pkg1/index.ts", "+one"),
      fp("pkg2/index.ts", "+two"),
    ];
    const groups = relate(files, [["docs/x.md", "docs/y.md", "not/in/patch.ts"]]);
    expect(groups).toEqual([
      ["src/a.ts", "src/b.ts"],
      ["src/calc.ts", "test/calc.test.ts"],
      ["src/money.ts", "src/e.ts"],
      ["docs/x.md", "docs/y.md"],
      ["pkg1/index.ts"],
      ["pkg2/index.ts"],
    ]);
  });

  test("batches keep related files together, leave lock files out and split what is too big", () => {
    const big = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n";
    const dir = repo({}, [
      { "src/a.ts": big(40), "src/b.ts": big(40) },
      { "lib/c.ts": big(40) },
      { "bun.lock": big(400) },
      { "huge/h.ts": big(400) },
    ]);
    const patch = patchFor(dir, "main") as Patch;
    const plan = planBatches(patch, dir, { budget: 2400, fileMax: 6000 });
    expect(plan.lockfiles).toEqual(["bun.lock"]);
    expect(plan.tooLarge).toEqual(["huge/h.ts"]);
    expect(plan.batches.map((b) => b.map((f) => f.file))).toEqual([["lib/c.ts"], ["src/a.ts", "src/b.ts"]]);

    // A group over the budget is split by folder.
    const tight = planBatches(patch, dir, { budget: 1300, fileMax: 6000 });
    expect(tight.batches.map((b) => b.map((f) => f.file))).toEqual([["lib/c.ts"], ["src/a.ts"], ["src/b.ts"]]);
  });
});

describe("the base", () => {
  // origin has moved on; the local main was never pulled.
  function cloned(): { dir: string; origin: string } {
    const origin = repo({ "a.ts": "a\n" }, []);
    git(origin, "checkout", "-q", "main");
    const dir = mkdtempSync(join(tmpdir(), "aug-clone-"));
    sh(dir, "git", "clone", "-q", origin, ".");
    write(origin, { "merged.ts": "someone else's work\n" });
    git(origin, "add", ".");
    git(origin, "commit", "-qm", "merged elsewhere");
    git(dir, "fetch", "-q");
    return { dir, origin };
  }

  test("origin/<base> when the remote is ahead of the local branch", () => {
    const { dir } = cloned();
    git(dir, "checkout", "-qb", "feature", "origin/main");
    write(dir, { "mine.ts": "mine\n" });
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "mine");
    const patch = patchFor(dir, "main") as Patch;
    expect(patch.base).toBe("origin/main");
    expect(splitPatch(patch.text).map((f) => f.file)).toEqual(["mine.ts"]);
  });

  test("the local branch when it is ahead of origin", () => {
    const { dir } = cloned();
    git(dir, "merge", "-q", "--ff-only", "origin/main");
    write(dir, { "local.ts": "not pushed\n" });
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "local");
    git(dir, "checkout", "-qb", "feature");
    write(dir, { "mine.ts": "mine\n" });
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "mine");
    const patch = patchFor(dir, "main") as Patch;
    expect(patch.base).toBe("main");
    expect(splitPatch(patch.text).map((f) => f.file)).toEqual(["mine.ts"]);
  });
});

describe("the guide's calls", () => {
  const notes = (files: { file: string; notes?: { lineStart: number; lineEnd: number; text: string }[] }[]) =>
    "```json\n" + JSON.stringify({ files: files.map((f) => ({ summary: `about ${f.file}`, ...f })) }) + "\n```";

  test("one batch is one call; several are a call each, then chapters, with every diff in one prompt", async () => {
    const dir = repo({}, [{ "src/a.ts": "export const a = 1;\n" }, { "lib/b.ts": "export const b = 2;\n" }]);
    const patch = patchFor(dir, "main") as Patch;
    const prompts: { label: string; prompt: string }[] = [];
    const ask: GuideAsk = async (prompt, label) => {
      prompts.push({ label, prompt });
      if (label === "batch 2/2")
        return { text: notes([{ file: "src/a.ts", notes: [{ lineStart: 1, lineEnd: 1, text: "Bug: a" }] }]), denied: [] };
      if (label === "batch 1/2") return { text: "not json", denied: ["Bash git diff | head"] };
      return {
        text: "```json\n" + JSON.stringify({ title: "T", intent: "I", sections: [{ title: "A", overview: "", diffs: [{ file: "src/a.ts" }] }], unplacedFiles: [] }) + "\n```",
        denied: [],
      };
    };
    const plan = planBatches(patch, dir, { budget: 100 });
    expect(plan.batches).toHaveLength(2);
    const ran = await reviewInBatches({ plan, prompt: (job) => `/aug:guide; job: ${job}`, commits: "abc step", ask });
    if ("error" in ran) throw new Error(ran.error);

    expect(prompts.map((p) => p.label)).toEqual(["batch 1/2", "batch 2/2", "chapters"]);
    expect(prompts[0]!.prompt).toContain("job: notes, batch 1 of 2");
    expect(prompts[0]!.prompt).toContain("- src/a.ts (+1 -0): batch 2");
    // Each file's diff in exactly one prompt, numbered.
    const withDiff = (file: string) => prompts.filter((p) => p.prompt.includes(`diff --git a/${file}`)).map((p) => p.label);
    expect(withDiff("src/a.ts")).toEqual(["batch 2/2"]);
    expect(withDiff("lib/b.ts")).toEqual(["batch 1/2"]);
    expect(prompts[1]!.prompt).toMatch(/^\s+1 \+export const a = 1;/m);
    // Chapters get the index with summaries, not the diffs.
    expect(prompts[2]!.prompt).toContain("- src/a.ts (+1 -0): about src/a.ts");
    expect(prompts[2]!.prompt).toContain("abc step");

    expect(ran.calls).toBe(3);
    expect(ran.denied).toEqual(["Bash git diff | head"]);
    expect(ran.gaps).toEqual(["No review came back for `lib/b.ts`."]);
    // The notes laid into the chapter; the file no chapter named is kept.
    expect(ran.guide.sections.map((s) => [s.title, s.diffs.map((d) => [d.file, d.notes?.length ?? 0])])).toEqual([
      ["A", [["src/a.ts", 1]]],
      ["Other changes", [["lib/b.ts", 0]]],
    ]);
  });

  test("a single batch is the whole job; chapters that are not JSON still keep every file", async () => {
    const dir = repo({}, [{ "src/a.ts": "export const a = 1;\n" }, { "lib/b.ts": "export const b = 2;\n" }]);
    const patch = patchFor(dir, "main") as Patch;

    const one: string[] = [];
    const whole = await reviewInBatches({
      plan: planBatches(patch, dir),
      prompt: (job) => `job: ${job}`,
      commits: "",
      ask: async (prompt) => {
        one.push(prompt);
        return { text: "nope", denied: [] };
      },
    });
    expect(one).toHaveLength(1);
    expect(one[0]).toContain("job: whole");
    expect(whole).toMatchObject({ error: expect.stringContaining("not JSON"), answer: "nope" });

    const split = await reviewInBatches({
      plan: planBatches(patch, dir, { budget: 100 }),
      prompt: (job) => `job: ${job}`,
      commits: "",
      ask: async (_p, label) =>
        label === "chapters"
          ? { text: "no chapters", denied: [] }
          : { text: notes([{ file: label === "batch 2/2" ? "src/a.ts" : "lib/b.ts" }]), denied: [] },
    });
    if ("error" in split) throw new Error(split.error);
    expect(split.gaps[0]).toContain("The chapters were not written");
    expect(split.guide.sections.flatMap((s) => s.diffs.map((d) => d.file)).sort()).toEqual(["lib/b.ts", "src/a.ts"]);
  });
});
