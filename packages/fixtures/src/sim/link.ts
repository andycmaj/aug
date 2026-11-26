// What the sim process and `sim:do` share beyond the state file: where the
// running sim's home is said, and the owner's PR linked to the work task.

import { tmpdir } from "node:os";
import { join } from "node:path";
import { linkPr } from "@riker/core/feedback";
import type { Applied } from "./events";
import { pullWeb, type SimState } from "./github";

// Where `bun run sim:do` finds the sim that runs now.
export const POINTER = join(tmpdir(), "riker-sim.home");

// The owner's PR, once opened, is the work task's: as `riker-tools pr` would.
export function linkOpened(s: SimState, done: Applied): void {
  const p = done.opened;
  if (!p || p.author !== s.me || !s.work?.taskId || p.head !== s.work.branch) {
    return;
  }
  linkPr(s.work.taskId, pullWeb(s, p.number));
}
