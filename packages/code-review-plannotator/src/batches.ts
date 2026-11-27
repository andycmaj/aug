// The guide's patch cut into batches, each small enough for one model call to
// hold whole (Riker's docs/task-actions-design.md, guide in batches). Every
// file's diff goes into exactly one batch's prompt, so nothing depends on the
// model choosing to read it. Related files share a batch, so a finding that
// needs both is in reach: files changed in the same commit of the branch, a
// test and what it tests, and a file whose diff names what another one defines.
// None of it parses a language; a miss only splits two related files, and each
// batch may still Read the other.

import { basename, dirname } from "node:path";
import { numberedPatch, type Patch } from "./guide";

export interface FilePatch {
  file: string;
  text: string;
  added: number;
  removed: number;
}

// About 25k tokens of numbered diff per call, and one file past 400k
// characters is more than a call should hold: it is named, not reviewed.
export const BATCH_CHARS = 100_000;
export const FILE_CHARS_MAX = 400_000;

// Lock files say nothing a reviewer reads: left out of every prompt (and so
// listed as unplaced in the guide).
const LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "composer.lock",
  "go.sum",
  "mix.lock",
  "flake.lock",
  "Podfile.lock",
  "Package.resolved",
  "packages.lock.json",
  "gradle.lockfile",
  "pubspec.lock",
]);

export function isLockfile(path: string): boolean {
  return LOCKFILES.has(basename(path));
}

// One entry per `diff --git` section, in patch order.
export function splitPatch(text: string): FilePatch[] {
  const files: FilePatch[] = [];
  for (const chunk of text.split(/(?=^diff --git )/m)) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    if (!header || !chunk.startsWith("diff --git ")) {
      continue;
    }
    let added = 0;
    let removed = 0;
    let inHunk = false;
    for (const line of chunk.split("\n")) {
      if (line.startsWith("@@")) {
        inHunk = true;
      } else if (!inHunk) {
        continue;
      } else if (line.startsWith("+")) {
        added++;
      } else if (line.startsWith("-")) {
        removed++;
      }
    }
    files.push({ file: header[2]!, text: chunk, added, removed });
  }
  return files;
}

// The files each commit of the branch changed, oldest first.
export function branchCommits(cwd: string, mergeBase: string): string[][] {
  const r = Bun.spawnSync(
    [
      "git",
      "-C",
      cwd,
      "log",
      "--no-merges",
      "--reverse",
      "--format=%x00",
      "--name-only",
      `${mergeBase}..HEAD`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (r.exitCode !== 0) {
    return [];
  }
  return r.stdout
    .toString()
    .split("\0")
    .map((c) =>
      c
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean),
    )
    .filter((c) => c.length > 0);
}

// The branch's commits, one line each, for the chapters call.
export function commitLog(cwd: string, mergeBase: string): string {
  const r = Bun.spawnSync(
    ["git", "-C", cwd, "log", "--no-merges", "--oneline", `${mergeBase}..HEAD`],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return r.exitCode === 0 ? r.stdout.toString().trim() : "";
}

// `foo.test.ts`, `test_foo.py`, `foo_test.go`, `FooSpec.scala` -> `foo`.
export function stem(path: string): string {
  let name = basename(path);
  const dot = name.indexOf(".");
  if (dot > 0) {
    name = name.slice(0, dot);
  }
  return name
    .replace(/^test_/, "")
    .replace(/(?:[_-](?:test|spec)|Test|Spec)$/, "")
    .toLowerCase();
}

function isTest(path: string): boolean {
  return (
    /(?:^|\/)(?:tests?|spec|__tests__)\//.test(path) ||
    /^test_|[._-](?:test|spec)\.|(?:Test|Spec)\./.test(basename(path))
  );
}

const DEFINES =
  /\b(?:function|def|class|func|fn|interface|type|struct|enum|trait|module|const|let|var|val)\s+\*?\s*([A-Za-z_][A-Za-z0-9_]*)/g;

// Too common to say two files are related.
const COMMON = new Set([
  "default",
  "async",
  "await",
  "const",
  "function",
  "return",
  "export",
  "import",
  "string",
  "number",
  "boolean",
  "object",
  "value",
  "values",
  "result",
  "error",
  "props",
  "state",
  "options",
  "config",
  "index",
  "data",
  "type",
  "types",
  "main",
  "init",
  "self",
  "this",
  "test",
  "tests",
  "name",
  "item",
  "items",
  "list",
  "args",
]);

// The names a file's diff defines or changes: declarations on changed lines,
// and the enclosing definition git names in each hunk header.
export function definedNames(fp: FilePatch): Set<string> {
  const names = new Set<string>();
  for (const line of fp.text.split("\n")) {
    const context = /^@@ [^@]* @@ (.*)$/.exec(line)?.[1];
    const scan = context ?? (/^[+-][^+-]/.test(line) ? line.slice(1) : null);
    if (scan === null) {
      continue;
    }
    for (const m of scan.matchAll(DEFINES)) {
      const n = m[1]!;
      if (n.length >= 4 && !COMMON.has(n.toLowerCase())) {
        names.add(n);
      }
    }
  }
  return names;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The files that belong together, each group in patch order, groups in the
// order their first file appears.
export function relate(files: FilePatch[], commits: string[][]): string[][] {
  const index = new Map(files.map((f, i) => [f.file, i]));
  const parent = files.map((_, i) => i);
  const find = (i: number): number =>
    parent[i] === i ? i : (parent[i] = find(parent[i]!));
  const join = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) {
      parent[Math.max(ra, rb)] = Math.min(ra, rb);
    }
  };

  // 1. Changed in the same commit.
  for (const commit of commits) {
    const inPatch = commit.flatMap((f) =>
      index.has(f) ? [index.get(f)!] : [],
    );
    for (const i of inPatch.slice(1)) {
      join(inPatch[0]!, i);
    }
  }
  // 3. A test and what it tests; files of one name in one folder
  // (foo.ts, foo.css). Not every index.ts in the repo.
  files.forEach((a, i) => {
    const s = stem(a.file);
    if (s.length < 3) {
      return;
    }
    files.forEach((b, j) => {
      if (j <= i || stem(b.file) !== s) {
        return;
      }
      if (
        isTest(a.file) !== isTest(b.file) ||
        dirname(a.file) === dirname(b.file)
      ) {
        join(i, j);
      }
    });
  });
  // 4. A diff that names what another file's diff defines, or imports it.
  files.forEach((a, i) => {
    const names = [...definedNames(a)];
    const s = stem(a.file);
    const imports =
      s.length >= 3
        ? new RegExp(`[/'"]${escape(s)}(?:\\.[a-z]+)?['"]`, "i")
        : null;
    const named = names.length
      ? new RegExp(`\\b(?:${names.map(escape).join("|")})\\b`)
      : null;
    files.forEach((b, j) => {
      if (i === j || find(i) === find(j)) {
        return;
      }
      if ((named && named.test(b.text)) || (imports && imports.test(b.text))) {
        join(i, j);
      }
    });
  });

  const groups = new Map<number, string[]>();
  files.forEach((f, i) => {
    const root = find(i);
    const g = groups.get(root) ?? [];
    g.push(f.file);
    groups.set(root, g);
  });
  return [...groups.values()];
}

export interface BatchPlan {
  batches: FilePatch[][];
  // Shown in no prompt: lock files, and files too big for one call.
  lockfiles: string[];
  tooLarge: string[];
  all: FilePatch[];
}

// Related files fill a batch together; a group too big for one is split by
// folder, then by file.
export function planBatches(
  patch: Patch,
  cwd: string,
  opts: { budget?: number; fileMax?: number } = {},
): BatchPlan {
  const budget = opts.budget ?? BATCH_CHARS;
  const fileMax = opts.fileMax ?? FILE_CHARS_MAX;
  const all = splitPatch(patch.text);
  const lockfiles = all.filter((f) => isLockfile(f.file)).map((f) => f.file);
  const size = new Map(all.map((f) => [f.file, numberedPatch(f.text).length]));
  const tooLarge = all
    .filter((f) => !isLockfile(f.file) && size.get(f.file)! > fileMax)
    .map((f) => f.file);
  const shown = all.filter(
    (f) => !lockfiles.includes(f.file) && !tooLarge.includes(f.file),
  );
  const byFile = new Map(shown.map((f) => [f.file, f]));
  const groups = relate(shown, branchCommits(cwd, patch.mergeBase));

  const batches: FilePatch[][] = [];
  let current: FilePatch[] = [];
  let used = 0;
  const weigh = (files: string[]) =>
    files.reduce((n, f) => n + size.get(f)!, 0);
  const place = (files: string[]) => {
    const w = weigh(files);
    if (current.length && used + w > budget) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(...files.map((f) => byFile.get(f)!));
    used += w;
  };
  for (const group of groups) {
    if (weigh(group) <= budget) {
      place(group);
      continue;
    }
    const byDir = new Map<string, string[]>();
    for (const f of group) {
      byDir.set(dirname(f), [...(byDir.get(dirname(f)) ?? []), f]);
    }
    for (const dirFiles of byDir.values()) {
      if (weigh(dirFiles) <= budget) {
        place(dirFiles);
      } else {
        for (const f of dirFiles) {
          place([f]);
        }
      }
    }
  }
  if (current.length) {
    batches.push(current);
  }
  return { batches, lockfiles, tooLarge, all };
}
