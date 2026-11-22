// `riker install` and friends write into the home, and they run inside
// parseCLI, before index.tsx moves aug's home. Run on an unmoved ~/.aug they
// made a fresh ~/.riker, and the next start then refused to move ~/.aug over
// it. Each runs `riker` with HOME on a scratch folder, never the real one.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Run from the repo root: its bunfig and tsconfig set up Solid's JSX.
const ROOT = join(import.meta.dir, "../../..");
const ENTRY = join(ROOT, "packages/cli/src/riker.ts");
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "riker-cli-home-"));
  mkdirSync(join(home, ".aug", "docs"), { recursive: true });
  writeFileSync(join(home, ".aug", "config.json"), "{}\n");
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

function riker(...args: string[]) {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !/^(RIKER|AUG)_/.test(k)) env[k] = v;
  env.HOME = home;
  return Bun.spawnSync(["bun", ENTRY, ...args], { env, cwd: ROOT });
}

test("riker install moves aug's home before writing into it", () => {
  const run = riker("install", "hooks");
  expect(run.exitCode).toBe(0);
  expect(lstatSync(join(home, ".aug")).isSymbolicLink()).toBe(true);
  expect(existsSync(join(home, ".riker", "config.json"))).toBe(true);
  expect(existsSync(join(home, ".riker", "adopt-hook.sh"))).toBe(true);
});

test("riker install --check changes nothing", () => {
  const run = riker("install", "--check");
  expect(run.exitCode).toBe(0);
  expect(lstatSync(join(home, ".aug")).isDirectory()).toBe(true);
  expect(existsSync(join(home, ".riker"))).toBe(false);
});
