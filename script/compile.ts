#!/usr/bin/env bun
// Compile aug to one standalone binary for this machine: dist/aug.
// Adapted from kube-tui's script/build.ts (itself from opencode's).

import solidPlugin from "@opentui/solid/bun-plugin";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
process.chdir(root);

const outfile = join(root, "dist", "aug");
// opentui's tree-sitter parser runs in a worker, loaded by path at runtime.
const parserWorker = realpathSync(join(root, "node_modules/@opentui/core/parser.worker.js"));

const result = await Bun.build({
  entrypoints: ["./src/bin/aug.ts", parserWorker],
  conditions: ["browser"],
  tsconfig: "./tsconfig.json",
  plugins: [solidPlugin],
  sourcemap: "external",
  compile: {
    target: `bun-${process.platform}-${process.arch}` as Bun.Build.CompileTarget,
    outfile,
    autoloadBunfig: false,
    autoloadDotenv: false,
    execArgv: ["--"],
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log(`built ${outfile}`);
