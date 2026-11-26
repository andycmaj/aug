// The one-way packages (AGENTS.md, Packages): a package imports only the
// packages below it, by name. Core knows no plugin; plugins know core and
// never each other, so triage and a connection can each change alone.

import { expect, test } from "bun:test";
import { Glob } from "bun";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");

// What each package may import, besides itself.
const ALLOWED: Record<string, readonly string[]> = {
  "code-review-plannotator": [],
  core: ["code-review-plannotator"],
  triage: ["core"],
  github: ["core"],
  slack: ["core"],
  fixtures: ["core", "triage", "github", "slack"],
  tui: [
    "core",
    "fixtures",
    "triage",
    "github",
    "slack",
    "code-review-plannotator",
  ],
  cli: [
    "core",
    "tui",
    "fixtures",
    "triage",
    "github",
    "slack",
    "code-review-plannotator",
  ],
};

function importsOf(text: string): string[] {
  return [...text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map(
    (m) => m[1]!,
  );
}

test("every package imports only the packages below it", async () => {
  const wrong: string[] = [];
  for (const file of new Glob(
    "packages/*/{src,test,script}/**/*.{ts,tsx}",
  ).scanSync(ROOT)) {
    const own = file.split("/")[1]!;
    const allowed = ALLOWED[own];
    if (!allowed) {
      wrong.push(`${own}: a package with no place in ALLOWED`);
      continue;
    }
    for (const spec of importsOf(await Bun.file(join(ROOT, file)).text())) {
      if (spec.startsWith("../") && /^(\.\.\/)+packages\//.test(spec)) {
        wrong.push(`${file}: ${spec} (by path)`);
      }
      const m = spec.match(/^@riker\/([^/]+)/);
      if (!m || m[1] === own) {
        continue;
      }
      if (!allowed.includes(m[1]!)) {
        wrong.push(`${file}: ${spec}`);
      }
    }
  }
  expect(wrong).toEqual([]);
});

test("each package.json names the packages it imports", async () => {
  const missing: string[] = [];
  for (const [pkg, allowed] of Object.entries(ALLOWED)) {
    const json = (await Bun.file(
      join(ROOT, "packages", pkg, "package.json"),
    ).json()) as {
      dependencies?: Record<string, string>;
    };
    const deps = Object.keys(json.dependencies ?? {});
    const used = new Set<string>();
    for (const file of new Glob(`packages/${pkg}/src/**/*.{ts,tsx}`).scanSync(
      ROOT,
    )) {
      for (const spec of importsOf(await Bun.file(join(ROOT, file)).text())) {
        const m = spec.match(/^@riker\/([^/]+)/);
        if (m && m[1] !== pkg && allowed.includes(m[1]!)) {
          used.add(`@riker/${m[1]}`);
        }
      }
    }
    for (const u of used) {
      if (!deps.includes(u)) {
        missing.push(`${pkg} imports ${u}`);
      }
    }
  }
  expect(missing).toEqual([]);
});
