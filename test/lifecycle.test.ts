import { beforeEach, describe, expect, test } from "bun:test";
import {
  draftSent,
  finishSuperseded,
  holdForStart,
  queued,
  recoverAtBoot,
  sessionActivity,
  sessionEnded,
  sessionStarted,
  startCancelled,
  taskClosed,
  turnFinished,
  workFinished,
} from "../src/core/lifecycle";
import * as store from "../src/core/store";
import {
  AgentState,
  Kind,
  SessionKind,
  TaskStatus,
  TurnRole,
} from "../src/core/types";
import { freshHome } from "./helpers";

let n = 0;

function task(kind: Kind = Kind.general) {
  return store.createTask({ title: `t${++n}`, kind, channel: "owner" });
}

function start(taskId: number, kind: SessionKind = SessionKind.chat) {
  const id = `s${++n}`;
  sessionStarted({ id, taskId, kind, cwd: "/tmp", startedBy: "aug" });
  return { taskId, sessionId: id };
}

const agentOf = (id: number) => store.getTask(id)!.agent_state;

beforeEach(() => freshHome());

describe("starting", () => {
  test("a new session puts the task to work and clears what the last one left", () => {
    const t = task();
    store.updateTask(t.id, {
      agent_state: AgentState.queued,
      queue_reason: "waiting",
      agent_says: "old",
      unread_result: 1,
    });
    const ref = start(t.id);
    const fresh = store.getTask(t.id)!;
    expect(fresh.agent_state).toBe(AgentState.working);
    expect(fresh.queue_reason).toBeNull();
    expect(fresh.agent_says).toBeNull();
    expect(fresh.unread_result).toBe(0);
    expect(store.getSession(ref.sessionId)!.state).toBe(AgentState.working);
  });

  test("the same id again revives the saved session instead of making one", () => {
    const t = task();
    const ref = start(t.id);
    sessionEnded(ref, AgentState.saved);
    sessionStarted({
      ...ref,
      id: ref.sessionId,
      kind: SessionKind.chat,
      cwd: "/tmp",
      startedBy: "aug",
    });
    expect(store.sessionsForTask(t.id)).toHaveLength(1);
    expect(store.getSession(ref.sessionId)!.ended_at).toBeNull();
    expect(agentOf(t.id)).toBe(AgentState.working);
  });

  test("starting on a task put away or done reopens it", () => {
    const t = task();
    store.remindAt(t.id, "2030-01-01T07:00:00.000Z");
    start(t.id);
    const fresh = store.getTask(t.id)!;
    expect(fresh.status).toBe(TaskStatus.open);
    expect(fresh.remind_at).toBeNull();
  });

  test("held and queued are both queued, with their reason", () => {
    const a = task(Kind.coding);
    holdForStart(a.id);
    expect(store.getTask(a.id)!.queue_reason).toBe("held for you: press Start");
    queued(a.id, "waiting its turn");
    expect(store.getTask(a.id)!.queue_reason).toBe("waiting its turn");
    startCancelled(a.id);
    expect(agentOf(a.id)).toBe(AgentState.saved);
    expect(store.getTask(a.id)!.queue_reason).toBeNull();
    // Cancel only undoes a queue; a working agent is not touched.
    const b = task();
    start(b.id);
    startCancelled(b.id);
    expect(agentOf(b.id)).toBe(AgentState.working);
  });
});

describe("while live", () => {
  test("activity moves the task and session together", () => {
    const t = task();
    const ref = start(t.id);
    sessionActivity(
      ref,
      AgentState.blocked,
      "asked you something",
      "AskUserQuestion",
    );
    expect(agentOf(t.id)).toBe(AgentState.blocked);
    expect(store.getTask(t.id)!.agent_says).toBe("asked you something");
    expect(store.getSession(ref.sessionId)!.last_tool).toBe("AskUserQuestion");
    sessionActivity(ref, AgentState.working, null);
    expect(agentOf(t.id)).toBe(AgentState.working);
    expect(store.getTask(t.id)!.agent_says).toBeNull();
  });

  test("a finished agent stays finished while it winds down, until it works again", () => {
    const t = task(Kind.coding);
    const ref = start(t.id, SessionKind.tmux);
    workFinished(ref, { summary: "shipped", closes: false });
    sessionActivity(ref, AgentState.blocked, "is waiting at its prompt");
    expect(agentOf(t.id)).toBe(AgentState.agentdone);
    sessionEnded(ref, AgentState.stopped);
    expect(agentOf(t.id)).toBe(AgentState.agentdone);
    expect(store.getSession(ref.sessionId)!.state).toBe(AgentState.agentdone);
    expect(store.getSession(ref.sessionId)!.ended_at).not.toBeNull();
    // A new prompt is new work.
    sessionActivity(ref, AgentState.working, null);
    expect(agentOf(t.id)).toBe(AgentState.working);
  });
});

describe("ending", () => {
  test("stopped on open work leaves the task stopped and silent", () => {
    const t = task();
    const ref = start(t.id);
    sessionActivity(ref, AgentState.blocked, "needs you");
    sessionEnded(ref, AgentState.stopped);
    const fresh = store.getTask(t.id)!;
    expect(fresh.agent_state).toBe(AgentState.stopped);
    expect(fresh.agent_says).toBeNull();
    expect(store.getSession(ref.sessionId)!.state).toBe(AgentState.stopped);
  });

  test("saved is the owner's stop, which resumes", () => {
    const t = task(Kind.coding);
    const ref = start(t.id, SessionKind.tmux);
    sessionEnded(ref, AgentState.saved);
    expect(agentOf(t.id)).toBe(AgentState.saved);
    expect(store.getSession(ref.sessionId)!.state).toBe(AgentState.saved);
  });

  test("a session ending on a closed task does not reopen the agent's state", () => {
    const t = task();
    const ref = start(t.id);
    taskClosed(t.id);
    expect(agentOf(t.id)).toBe(AgentState.saved);
    sessionEnded(ref, AgentState.stopped);
    expect(agentOf(t.id)).toBe(AgentState.saved);
  });

  test("a chat turn finishes as done, or as asking with the question", () => {
    const t = task();
    const ref = start(t.id);
    turnFinished(ref, { asking: "Which tier?" });
    expect(agentOf(t.id)).toBe(AgentState.blocked);
    expect(store.getTask(t.id)!.agent_says).toBe("Which tier?");
    expect(store.getSession(ref.sessionId)!.ended_at).not.toBeNull();
    const again = start(t.id);
    turnFinished(again, { asking: null });
    expect(agentOf(t.id)).toBe(AgentState.agentdone);
    expect(store.getTask(t.id)!.agent_says).toBeNull();
  });
});

describe("finishing work", () => {
  test("finished work that closes is done by the agent and unread", () => {
    const t = task(Kind.coding);
    const ref = start(t.id, SessionKind.tmux);
    workFinished(ref, { summary: "merged #12", closes: true });
    const fresh = store.getTask(t.id)!;
    expect(fresh.status).toBe(TaskStatus.done);
    expect(fresh.closed_by).toBe("agent");
    expect(fresh.unread_result).toBe(1);
    expect(fresh.agent_state).toBe(AgentState.agentdone);
    expect(store.getSession(ref.sessionId)!.result).toBe("merged #12");
    // The window is still up: the session is not ended by the finish.
    expect(store.getSession(ref.sessionId)!.ended_at).toBeNull();
  });

  test("finished work that waits on the owner stays open, and tells the task it came from", () => {
    const from = task();
    const t = store.createTask({
      title: "child",
      kind: Kind.coding,
      channel: "owner",
      fromTaskId: from.id,
    });
    const ref = start(t.id, SessionKind.tmux);
    workFinished(ref, { summary: "ready", closes: false });
    expect(store.getTask(t.id)!.status).toBe(TaskStatus.open);
    const told = store.turnsForTask(from.id).at(-1)!;
    expect(told.role).toBe(TurnRole.trigger);
    expect(told.body).toContain("finished; it waits for the owner");
  });

  test("new work on a finished task takes the finish back", () => {
    const t = task();
    const ref = start(t.id);
    turnFinished(ref, { asking: null });
    store.updateTask(t.id, { unread_result: 1 });
    finishSuperseded(t.id);
    expect(agentOf(t.id)).toBe(AgentState.none);
    expect(store.getTask(t.id)!.unread_result).toBe(0);
    // Only a finish is superseded; a working agent keeps going.
    const u = task();
    start(u.id);
    finishSuperseded(u.id);
    expect(agentOf(u.id)).toBe(AgentState.working);
  });

  test("sending the draft an agent waited on clears what it said", () => {
    const t = task();
    const ref = start(t.id);
    turnFinished(ref, { asking: "send it?" });
    draftSent(t.id);
    expect(store.getTask(t.id)!.agent_says).toBeNull();
    expect(agentOf(t.id)).toBe(AgentState.blocked);
  });
});

describe("closing", () => {
  test("closing saves a live agent, ends its sessions, retires the draft", () => {
    const t = task();
    const ref = start(t.id);
    const turn = store.addTurn({
      taskId: t.id,
      role: TurnRole.agent,
      body: "x",
    });
    store.setTurnAction(turn.id, {
      type: "slack_reply",
      channel: "C1",
      text: "hi",
    });
    taskClosed(t.id);
    const fresh = store.getTask(t.id)!;
    expect(fresh.status).toBe(TaskStatus.done);
    expect(fresh.agent_state).toBe(AgentState.saved);
    expect(fresh.closed_by).toBe("you");
    expect(store.pendingAction(t.id)).toBeNull();
    expect(store.getSession(ref.sessionId)!.ended_at).not.toBeNull();
  });

  test("closing a finished task keeps the finish, and a queued one is saved", () => {
    const done = task();
    turnFinished(start(done.id), { asking: null });
    taskClosed(done.id);
    expect(agentOf(done.id)).toBe(AgentState.agentdone);
    const held = task(Kind.coding);
    holdForStart(held.id);
    taskClosed(held.id);
    expect(agentOf(held.id)).toBe(AgentState.saved);
  });
});

describe("recovering at boot", () => {
  test("sessions that do not survive a restart are stopped; tmux ones are asked later", () => {
    const chat = task();
    const chatRef = start(chat.id);
    const coding = task(Kind.coding);
    const codingRef = start(coding.id, SessionKind.tmux);
    const orphan = task();
    store.updateTask(orphan.id, { agent_state: AgentState.working });
    recoverAtBoot(
      () => false,
      (s) => s.kind === SessionKind.tmux,
    );
    expect(agentOf(chat.id)).toBe(AgentState.stopped);
    expect(store.getSession(chatRef.sessionId)!.ended_at).not.toBeNull();
    expect(agentOf(coding.id)).toBe(AgentState.working);
    expect(store.getSession(codingRef.sessionId)!.ended_at).toBeNull();
    expect(agentOf(orphan.id)).toBe(AgentState.stopped);
  });

  test("a task the pool is already running is left alone", () => {
    const t = task();
    store.updateTask(t.id, { agent_state: AgentState.working });
    recoverAtBoot(
      (id) => id === t.id,
      () => false,
    );
    expect(agentOf(t.id)).toBe(AgentState.working);
  });
});
