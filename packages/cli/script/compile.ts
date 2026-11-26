#!/usr/bin/env bun
// Compile Riker to standalone binaries. Adapted from kube-tui's and ghdash's
// script/build.ts (themselves from opencode's).
//
//   bun run compile          this machine only: dist/riker
//   bun run compile --all    every release target: dist/riker-<os>-<arch>
//
// The release workflow (.github/workflows/riker-release.yml) uploads the
// --all files as the GitHub release's assets, named as they are here, which
// is what `mise use -g github:andycmaj/riker` picks from by os and arch.

import solidPlugin from "@opentui/solid/bun-plugin";
import { $ } from "bun";
import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
process.chdir(root);

type Os = "darwin" | "linux";
type Arch = "arm64" | "x64";

// What the opentui-apps site promises for every app.
const TARGETS: readonly { os: Os; arch: Arch }[] = [
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
];

const all = process.argv.includes("--all");
const dist = join(root, "dist");

// opentui's renderer is a native library in one package per platform, and
// bun installs only this machine's: a cross build needs the rest on disk to
// embed. ghostty-opentui ships every platform's .node in its own package.
// Without a package name this leaves package.json and bun.lock alone.
if (all) {
  await $`bun install ${"--os=*"} ${"--cpu=*"}`;
}

// opentui's tree-sitter parser runs in a worker, loaded by path at runtime.
const parserWorker = realpathSync(
  join(root, "node_modules/@opentui/core/parser.worker.js"),
);

async function build(os: string, arch: string, outfile: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: ["./packages/cli/src/riker.ts", parserWorker],
    conditions: ["browser"],
    tsconfig: "./tsconfig.json",
    plugins: [solidPlugin],
    sourcemap: "external",
    compile: {
      target: `bun-${os}-${arch}` as Bun.Build.CompileTarget,
      outfile,
      autoloadBunfig: false,
      autoloadDotenv: false,
      execArgv: ["--"],
    },
  });
  if (!result.success) {
    console.error(`build failed for ${os}-${arch}:`);
    for (const log of result.logs) {
      console.error(log);
    }
    process.exit(1);
  }
  console.log(`built ${outfile}`);
}

if (all) {
  rmSync(dist, { recursive: true, force: true });
  mkdirSync(dist, { recursive: true });
  for (const t of TARGETS) {
    await build(t.os, t.arch, join(dist, `riker-${t.os}-${t.arch}`));
  }
} else {
  await build(process.platform, process.arch, join(dist, "riker"));
}
