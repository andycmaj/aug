// bun run lint (oxlint, .oxlintrc.json) enforces block braces on every if,
// else, for and while body, nested ones included, and the type-aware
// promise rules, so the tool holds them and no review has to. Each case runs
// the repo's own config on a scratch file.

import { afterAll, expect, test } from "bun:test";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../..");
const BIN = join(ROOT, "node_modules/.bin");
const dir = mkdtempSync(join(tmpdir(), "riker-lint-"));
mkdirSync(join(dir, "packages/x/src"), { recursive: true });
copyFileSync(join(ROOT, ".oxlintrc.json"), join(dir, ".oxlintrc.json"));
writeFileSync(
  join(dir, "tsconfig.json"),
  JSON.stringify({ compilerOptions: { strict: true, lib: ["ESNext"] } }),
);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function lint(name: string, source: string) {
  const file = join("packages/x/src", `${name}.ts`);
  writeFileSync(join(dir, file), source);
  // The type-aware rules run in tsgolint, which oxlint finds on PATH.
  const run = Bun.spawnSync([join(BIN, "oxlint"), file], {
    cwd: dir,
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH ?? ""}` },
  });
  return {
    code: run.exitCode,
    out: run.stdout.toString() + run.stderr.toString(),
  };
}

const UNBRACED: Record<string, string> = {
  "nested for": `export function f() {
  for (const a of [1])
    for (const b of [a]) {
      console.log(b);
    }
}
`,
  "if inside a braced for": `export function f() {
  for (const a of [1]) {
    if (a) console.log(a);
  }
}
`,
  else: `export function f(a: number) {
  if (a > 0.5) {
    console.log(a);
  } else console.log(0);
}
`,
  while: `export function f(a: number) {
  while (a > 0) a--;
}
`,
};

for (const [name, source] of Object.entries(UNBRACED)) {
  test(`lint fails on an unbraced ${name}`, () => {
    const { code, out } = lint(name.replaceAll(" ", "-"), source);
    expect(code).not.toBe(0);
    expect(out).toContain("eslint(curly)");
  });
}

test("lint fails on a promise nobody awaits", () => {
  const { code, out } = lint(
    "floating",
    `async function save(): Promise<void> {}
export function f() {
  save();
}
`,
  );
  expect(code).not.toBe(0);
  expect(out).toContain("no-floating-promises");
});

test("lint passes the same code braced and awaited", () => {
  const { code, out } = lint(
    "clean",
    `async function save(): Promise<void> {}
export async function f(n: number) {
  for (const a of [1]) {
    for (const b of [a]) {
      if (b) {
        console.log(b);
      } else {
        console.log(a);
      }
    }
  }
  while (n > 0) {
    n--;
  }
  await save();
}
`,
  );
  expect(out).not.toContain("error");
  expect(code).toBe(0);
});
