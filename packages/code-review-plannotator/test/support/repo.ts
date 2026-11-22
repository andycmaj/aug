// A git repo on a feature branch, and the guide a skill would answer for it:
// shared by this package's tests and Riker's guide action tests.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function sh(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
}

// A repo on a feature branch that adds div to math.ts and a README line.
export function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "riker-guide-"));
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

export const ANSWER = {
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

// A repo whose change is `files` unrelated files of about `chars` each, one
// commit apiece, so a guide of it runs in that many batches.
export function bigRepo(files: number, chars = 60_000): string {
  const dir = mkdtempSync(join(tmpdir(), "riker-guide-big-"));
  const git = (...a: string[]) =>
    sh(dir, "git", "-c", "user.email=t@t", "-c", "user.name=t", ...a);
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# big\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "feature");
  for (let k = 1; k <= files; k++) {
    const lines = Array.from({ length: Math.ceil(chars / 40) }, (_, i) => `export const part${k}_${i} = ${i}; // ${"x".repeat(8)}`);
    writeFileSync(join(dir, `part${k}.ts`), `${lines.join("\n")}\n`);
    git("add", ".");
    git("commit", "-qm", `part ${k}`);
  }
  return dir;
}

// The chapters answer for bigRepo: one chapter naming every file.
export function bigAnswer(files: number) {
  return {
    title: "Big change",
    intent: "Many parts.",
    sections: [
      {
        title: "Parts",
        overview: "Each part.",
        diffs: Array.from({ length: files }, (_, k) => ({ file: `part${k + 1}.ts`, summary: `Part ${k + 1}.` })),
      },
    ],
    unplacedFiles: [],
  };
}
