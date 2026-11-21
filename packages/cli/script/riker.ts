#!/usr/bin/env bun
// Riker from source (`bun dev`). Two things a bare `bun run` of the entry does
// not do:
// - Runs from anywhere: the TUI needs the Solid JSX preload and the `browser`
//   condition, and the preload resolves only from the repo's node_modules, so
//   bun runs with --cwd at the repo root.
// - Restarts Riker after a fatal UI error: CrashGuard exits with RESTART_CODE
//   (core/restart.ts) and this starts it again, unless it asks more than three
//   times inside a minute. Any other exit code ends it. The compiled binary
//   (script/compile.ts) does not restart itself.

import { RESTART_CODE } from "@riker/core/restart";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const entry = resolve(import.meta.dir, "../src/riker.ts");
const WINDOW_MS = 60_000;
const MAX_RESTARTS = 3;

let recent: number[] = [];
for (;;) {
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      "--cwd",
      root,
      "--conditions=browser",
      "--preload",
      "@opentui/solid/preload",
      entry,
      ...process.argv.slice(2),
    ],
    { stdio: ["inherit", "inherit", "inherit"] },
  );
  const code = await proc.exited;
  if (code !== RESTART_CODE) process.exit(code);
  const now = Date.now();
  recent = [...recent.filter((t) => now - t < WINDOW_MS), now];
  if (recent.length > MAX_RESTARTS) {
    console.error(`riker: restarted ${MAX_RESTARTS} times in a minute; giving up (see ~/.riker/riker.log)`);
    process.exit(code);
  }
  console.error("riker: restarting after a fatal UI error (see ~/.riker/riker.log)");
  await Bun.sleep(1000);
}
