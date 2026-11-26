// What a Claude Code session's own log says it cost. claude writes a
// cost-state line (the session's running totalCostUSD) after each turn, in
// <claude config dir>/projects/<project>/<session id>.jsonl, and restores
// the last one on --resume. Riker reads it where its own spend rows cannot
// say what a session had cost before a turn (core/spend.ts).

import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { claudeDir } from "./capabilities";

const COST_STATE = '"type":"cost-state"';
// Enough of a log's end to hold its last cost-state line; the whole file
// only when it is not there.
const TAIL_BYTES = 256 * 1024;

function projectsDir(): string {
  return join(claudeDir(), "projects");
}

// The session's log under any project folder, or null.
export function sessionLog(
  sessionId: string,
  dir = projectsDir(),
): string | null {
  if (!existsSync(dir)) {
    return null;
  }
  for (const project of readdirSync(dir)) {
    const file = join(dir, project, `${sessionId}.jsonl`);
    if (existsSync(file)) {
      return file;
    }
  }
  return null;
}

// The session's total as its log last said it.
export function sessionLogCost(
  sessionId: string,
  dir = projectsDir(),
): number | null {
  const file = sessionLog(sessionId, dir);
  if (!file) {
    return null;
  }
  const tail = readTail(file, TAIL_BYTES);
  const totals = costStates(tail.text);
  if (totals.length || tail.whole) {
    return totals.at(-1) ?? null;
  }
  return costStates(readTail(file, Infinity).text).at(-1) ?? null;
}

// The total the session had before the turn that brought it to `total`
// (0 for its first), or null when the log never said `total`.
export function costBefore(
  sessionId: string,
  total: number,
  dir = projectsDir(),
): number | null {
  const file = sessionLog(sessionId, dir);
  if (!file) {
    return null;
  }
  const totals = costStates(readTail(file, Infinity).text);
  const at = totals.findLastIndex((t) => Math.abs(t - total) < 1e-9);
  if (at < 0) {
    return null;
  }
  return at === 0 ? 0 : (totals[at - 1] ?? null);
}

function readTail(
  file: string,
  bytes: number,
): { text: string; whole: boolean } {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    return { text: buf.toString("utf8"), whole: length === size };
  } finally {
    closeSync(fd);
  }
}

// Each cost-state line's total, in order. A line cut by a tail's start, or
// one claude is still writing, is skipped.
function costStates(text: string): number[] {
  const totals: number[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes(COST_STATE)) {
      continue;
    }
    try {
      const event: unknown = JSON.parse(line);
      if (
        event &&
        typeof event === "object" &&
        "totalCostUSD" in event &&
        typeof event.totalCostUSD === "number"
      ) {
        totals.push(event.totalCostUSD);
      }
    } catch {
      // not a whole line
    }
  }
  return totals;
}
