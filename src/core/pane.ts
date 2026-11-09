// Runs a command in a split of the caller's own tmux window. A diff viewer an
// agent opens (revdiff) then shows wherever that window does, aug's viewer
// included; tmux would otherwise put a window of its own in the session, or a
// popup on whichever client it picks.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mux } from "./mux";

export interface PaneRun {
  paneId: string;
  cwd: string;
  argv: string[];
  zoom: boolean;
  wait: boolean;
  pollMs?: number;
}

export interface PaneResult {
  paneId: string;
  // Only when waited on; a pane killed before its command finished is 1.
  exitCode: number | null;
}

export async function runInPane(run: PaneRun): Promise<PaneResult> {
  const split = {
    paneId: run.paneId,
    cwd: run.cwd,
    argv: run.argv,
    zoom: run.zoom,
  };
  if (!run.wait) {
    const paneId = await mux().splitPane(split);
    return { paneId, exitCode: null };
  }
  const dir = mkdtempSync(join(tmpdir(), "aug-pane-"));
  const exitFile = join(dir, "exit");
  try {
    const paneId = await mux().splitPane({ ...split, exitFile });
    while (await mux().paneAlive(paneId)) await Bun.sleep(run.pollMs ?? 300);
    return { paneId, exitCode: readExit(exitFile) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readExit(file: string): number {
  try {
    const code = Number(readFileSync(file, "utf8").trim());
    return Number.isInteger(code) ? code : 1;
  } catch {
    return 1;
  }
}
