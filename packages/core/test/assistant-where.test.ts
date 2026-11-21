import { beforeEach, describe, expect, test } from "bun:test";
import { setBrain, type BrainCall } from "../src/brain";
import { AgentPool } from "../src/agents";
import {
  assistantPrompt,
  heardWhere,
  whereThingsStand,
} from "../src/assistant";
import * as store from "../src/store";
import { Kind, TurnRole } from "../src/types";
import { freshHome, withLimit } from "./support/helpers";

let calls: BrainCall[];

beforeEach(() => {
  freshHome();
  calls = [];
  setBrain(async (call) => {
    calls.push(call);
    return {
      text: "ok",
      structured: null,
      sessionId: call.sessionId ?? call.resume ?? null,
      durationMs: 1,
      isError: false,
    };
  });
});

function say(taskId: number, body: string) {
  store.addTurn({ taskId, role: TurnRole.you, author: "you", body });
}

function task(title: string) {
  return store.createTask({ title, summary: "", kind: Kind.general, channel: "owner" });
}

describe("Where things stand", () => {
  test("counts open work instead of listing it; a named task comes in full", () => {
    const quiet = task("A task nobody named");
    const named = task("The task the owner named");
    const turns = [
      store.addTurn({
        taskId: store.homeTask().id,
        role: TurnRole.you,
        author: "you",
        body: `what about @${store.taskRef(named.id)}`,
      }),
    ];
    const prompt = assistantPrompt(turns, "typed", false);
    expect(prompt).toContain("## Where things stand\nNow: ");
    expect(prompt).toContain("Open work: 2 tasks (2 open, 0 later)");
    expect(prompt).toContain("tasks lists them");
    expect(prompt).toContain("The task the owner named");
    expect(prompt).not.toContain(quiet.title);
  });

  test("a fresh session gets the whole picture even with one heard", () => {
    task("one");
    const where = whereThingsStand();
    const prompt = assistantPrompt([], "typed", false, where, where);
    expect(prompt).toContain("Open work: 1 task (1 open, 0 later)");
    expect(prompt).not.toContain("unchanged");
  });

  test("a resumed session with nothing heard gets the whole picture", () => {
    task("one");
    const prompt = assistantPrompt([], "typed", true, whereThingsStand(), null);
    expect(prompt).toContain("## Where things stand\nNow: ");
    expect(prompt).toContain("Open work: 1 task");
  });

  test("a resumed session gets one line when nothing changed", () => {
    task("one");
    const where = whereThingsStand();
    const prompt = assistantPrompt([], "typed", true, where, where);
    expect(prompt).toContain("## Where things stand: unchanged since your last turn\nNow: ");
    expect(prompt).not.toContain("Open work");
  });

  test("a resumed session gets only the lines that changed", () => {
    task("one");
    store.createProject({ name: "steady", tmuxSession: "steady" });
    const heard = whereThingsStand();
    task("two");
    const prompt = assistantPrompt([], "typed", true, whereThingsStand(), heard);
    expect(prompt).toContain("changed since your last turn");
    expect(prompt).toContain("- Open work: 1 task (1 open, 0 later)");
    expect(prompt).toContain("+ Open work: 2 tasks (2 open, 0 later)");
    expect(prompt).not.toContain("steady");
  });

  test("a named project brings its brief and goals, not its open list", () => {
    const p = store.createProject({ name: "rocket", tmuxSession: "rocket" });
    store.updateProject(p.id, { brief: "Get to orbit." });
    const goal = store.addGoal(p.id, "Reach orbit");
    store.createTask({
      title: "Build the engine",
      summary: "",
      kind: Kind.general,
      channel: "owner",
      projectId: p.id,
      goalId: goal.id,
    });
    const turns = [
      store.addTurn({
        taskId: store.homeTask().id,
        role: TurnRole.you,
        author: "you",
        body: "how is @rocket going",
      }),
    ];
    const prompt = assistantPrompt(turns, "typed", false);
    expect(prompt).toContain("## Projects the owner named");
    expect(prompt).toContain("Get to orbit.");
    expect(prompt).toContain("Reach orbit: 0/1 tasks done");
    expect(prompt).not.toContain("Build the engine");
  });

  test("the pool sends the picture once per session, then what moved", async () => {
    const home = store.homeTask();
    const pool = new AgentPool({ config: withLimit(4) });
    say(home.id, "first");
    await pool.request(home.id, "typed", "owner");
    expect(calls[0].prompt).toContain("Open work: 0 tasks");
    const session = calls[0].sessionId!;
    expect(heardWhere(session)).toBe(whereThingsStand());

    say(home.id, "second");
    await pool.request(home.id, "typed", "owner");
    expect(calls[1].resume).toBe(session);
    expect(calls[1].prompt).toContain("unchanged since your last turn");

    task("new work");
    say(home.id, "third");
    await pool.request(home.id, "typed", "owner");
    expect(calls[2].prompt).toContain("+ Open work: 1 task (1 open");
    expect(heardWhere("another-session")).toBeNull();
  });
});
