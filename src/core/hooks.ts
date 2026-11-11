// State for a coding agent running interactively in an embedded terminal.
// Claude Code fires hooks (configured per session with --settings) that run
// `aug-tools hook <event>`; each one lands here and moves the session and its
// task through the agent states. A quiet session at its prompt is an agent
// waiting on you.

import { describeStep } from "./brain";
import { actionFor, type TurnAnswer } from "./agents";
import {
  sessionActivity,
  sessionEnded,
  workFinished,
  type AgentRef,
} from "./lifecycle";
import * as store from "./store";
import { AgentState, TurnRole } from "./types";

export interface HookPayload {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  message?: string;
  reason?: string;
  // UserPromptSubmit carries what was typed; every event carries the cwd.
  prompt?: string;
  cwd?: string;
}

export type HookEnv = AgentRef;

export function handleHook(
  event: string,
  payload: HookPayload,
  env: HookEnv,
): void {
  switch (event) {
    case "prompt":
      sessionActivity(env, AgentState.working, null);
      return;
    case "tool": {
      const step = describeStep(
        payload.tool_name ?? "tool",
        payload.tool_input,
      );
      if (payload.tool_name === "AskUserQuestion")
        sessionActivity(env, AgentState.blocked, "asked you something", step);
      else sessionActivity(env, AgentState.working, null, step);
      return;
    }
    case "notification": {
      const text = payload.message ?? "needs you";
      const approval = /permission|approve|allow/i.test(text);
      sessionActivity(
        env,
        AgentState.blocked,
        approval ? `needs your approval: ${text}` : text,
      );
      return;
    }
    case "stop":
      sessionActivity(env, AgentState.blocked, "is waiting at its prompt");
      return;
    case "end":
      sessionEnded(env, AgentState.stopped);
      return;
  }
}

export interface DoneArgs {
  summary: string;
  reply?: string;
  close?: "issue" | "merge" | "approve";
}

// The agent says it is finished. The session is written up; the task waits
// for you with its close-out when a reply is owed, otherwise it is done (and
// stays on the rail until you have read it).
export function handleDone(env: HookEnv, args: DoneArgs): string {
  const task = store.getTask(env.taskId);
  if (!task) return `no task ${env.taskId}`;
  const session = store.getSession(env.sessionId);
  const kind: NonNullable<TurnAnswer["action"]>["kind"] =
    args.close === "issue"
      ? "close_issue"
      : args.close === "merge"
        ? "merge_pr"
        : args.close === "approve"
          ? "approve_pr"
          : "reply";
  const action = args.reply
    ? actionFor(task, { kind, text: args.reply })
    : null;
  const ownerSession = session?.started_by === "owner";

  store.batch(() => {
    const turn = store.addTurn({
      taskId: task.id,
      role: TurnRole.agent,
      author: "coding agent",
      body: args.summary,
      sessionId: env.sessionId,
    });
    store.updateTurn(turn.id, {
      about: task.title,
      did: args.summary,
      next: action
        ? "The reply is set up below; send it when you are happy."
        : ownerSession
          ? "Yours to close: you started this session."
          : "Nothing left to do here.",
    });
    if (action) store.setTurnAction(turn.id, action);
    workFinished(env, {
      summary: args.summary,
      closes: !action && !ownerSession && !lastIncomingNeedsReply(task.id),
    });
  });
  return action
    ? `${store.taskRef(task.id)}: finished; reply waits for the owner's Send`
    : `${store.taskRef(task.id)}: finished`;
}

function lastIncomingNeedsReply(taskId: number): boolean {
  return store
    .messagesForTask(taskId)
    .some((m) => !m.from_me && m.channel !== "owner");
}
