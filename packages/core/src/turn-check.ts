// The safety net under the turn signals. A turn ends with claude's Stop hook,
// but Esc (an interrupted turn) fires none, so a row could read working
// forever. Each running claude says busy or idle in its own
// ~/.claude/sessions/<pid>.json; a session Riker has as working, quiet for a
// while, that claude calls idle, is idle.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeDir } from "./adopt";
import { turnEnded } from "./lifecycle";
import * as store from "./store";
import { AgentState, SessionKind } from "./types";

// Long enough that a turn between two tools is never caught mid-way.
export const QUIET_MS = 2 * 60_000;

// Session id -> "busy" | "idle", for every claude that wrote a file.
export function claudeStatuses(
  dir = join(claudeDir(), "sessions"),
): Map<string, string> {
  const out = new Map<string, string>();
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return out;
  }
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf8")) as {
        sessionId?: unknown;
        status?: unknown;
      };
      if (typeof raw.sessionId === "string" && typeof raw.status === "string") {
        out.set(raw.sessionId, raw.status);
      }
    } catch {
      // gone between the listing and the read, or half written
    }
  }
  return out;
}

// Returns the sessions it settled. A claude with no file says nothing: the
// window check (reconcile) decides whether it is gone.
export function settleStaleTurns(
  statuses: Map<string, string> = claudeStatuses(),
  now = Date.now(),
): string[] {
  const settled: string[] = [];
  for (const s of store.liveSessions()) {
    if (s.kind !== SessionKind.tmux || s.state !== AgentState.working) {
      continue;
    }
    if (now - Date.parse(s.last_event_at) < QUIET_MS) {
      continue;
    }
    if (statuses.get(s.id) !== "idle") {
      continue;
    }
    turnEnded({ taskId: s.task_id, sessionId: s.id }, null);
    settled.push(s.id);
  }
  return settled;
}
