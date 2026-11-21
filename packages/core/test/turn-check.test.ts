import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeStatuses, QUIET_MS, settleStaleTurns } from "../src/turn-check";
import * as store from "../src/store";
import { AgentState, Kind, SessionKind } from "../src/types";
import { freshHome } from "./support/helpers";

describe("stale working", () => {
  beforeEach(() => freshHome());

  function working(id: string) {
    const t = store.createTask({ title: id, kind: Kind.coding, channel: "owner" });
    store.createSession({ id, taskId: t.id, kind: SessionKind.tmux, cwd: "/tmp", startedBy: "aug" });
    store.updateTask(t.id, { agent_state: AgentState.working });
    return t.id;
  }

  test("a quiet working session that claude calls idle is idle; busy or recent stays working", () => {
    const interrupted = working("a");
    const longTool = working("b");
    const recent = working("c");
    const later = Date.now() + QUIET_MS + 1000;
    const statuses = new Map([
      ["a", "idle"],
      ["b", "busy"],
    ]);
    expect(settleStaleTurns(statuses, later)).toEqual(["a"]);
    expect(store.getTask(interrupted)!.agent_state).toBe(AgentState.idle);
    expect(store.getTask(longTool)!.agent_state).toBe(AgentState.working);
    // Quiet for less than the window: not caught between two tools.
    statuses.set("c", "idle");
    expect(settleStaleTurns(statuses, Date.now())).toEqual([]);
    expect(store.getTask(recent)!.agent_state).toBe(AgentState.working);
  });

  test("claude's session files are read by session id", () => {
    const dir = join(process.env.AUG_HOME!, "sessions");
    mkdirSync(dir);
    writeFileSync(join(dir, "1.json"), JSON.stringify({ pid: 1, sessionId: "a", status: "idle" }));
    writeFileSync(join(dir, "2.json"), "{half");
    expect([...claudeStatuses(dir)]).toEqual([["a", "idle"]]);
  });
});
