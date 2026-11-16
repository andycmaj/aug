// State for a coding agent running interactively in an embedded terminal.
// Claude Code fires hooks (configured per session with --settings) that run
// `aug-tools hook <event>`; each one lands here and moves the session and its
// task through the agent states. A turn runs from the prompt to Stop: idle
// after it, unless it ended on a question (waiting on you).

import { readFileSync } from "node:fs";
import { describeStep } from "./brain";
import type { TurnAnswer } from "./agents";
import { actionFor } from "./outbound";
import {
  EndReason,
  sessionActivity,
  sessionEnded,
  turnEnded,
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
  // PostToolUse carries what the tool gave back.
  tool_response?: unknown;
  // Notification says what kind it is (permission_prompt, idle_prompt).
  notification_type?: string;
  // Stop carries the transcript, and newer claudes its last message too.
  transcript_path?: string;
  last_assistant_message?: string;
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
        sessionActivity(env, AgentState.waiting, "asked you something", step);
      else sessionActivity(env, AgentState.working, null, step);
      return;
    }
    case "notification": {
      // Claude's "waiting for your input" after a quiet minute: the turn
      // ended already, and Stop said whether it asked anything.
      if (isIdleNotice(payload)) return;
      const text = payload.message ?? "needs you";
      const approval = /permission|approve|allow/i.test(text);
      sessionActivity(
        env,
        AgentState.waiting,
        approval ? `needs your approval: ${text}` : text,
      );
      return;
    }
    case "stop":
      turnEnded(env, endedAsking(lastMessage(payload)));
      return;
    case "end":
      sessionEnded(env, endReason(payload.reason));
      return;
    case "made":
      linkArtifact(payload, env);
      return;
  }
}

function isIdleNotice(payload: HookPayload): boolean {
  if (payload.notification_type) return payload.notification_type === "idle_prompt";
  return /waiting for your input/i.test(payload.message ?? "");
}

// SessionEnd's reason: "clear", "logout", "prompt_input_exit", "other".
function endReason(reason: string | undefined): string {
  return reason === "other" || !reason ? EndReason.window : EndReason.exited;
}

// The question a turn ended on, if it ended on one: its last line, when
// that line asks. A turn that ends with a statement left nothing to answer.
export function endedAsking(message: string | null): string | null {
  if (!message) return null;
  const lines = message
    .split("\n")
    .map((l) => l.replace(/[*_`\s]+$/g, "").trim())
    .filter(Boolean);
  const last = lines.at(-1) ?? "";
  if (!last.endsWith("?")) return null;
  return last.length > 200 ? `${last.slice(0, 199)}…` : last;
}

// The turn's last words: from the payload when claude sends them, else the
// last assistant text in its transcript.
function lastMessage(payload: HookPayload): string | null {
  if (typeof payload.last_assistant_message === "string")
    return payload.last_assistant_message;
  if (!payload.transcript_path) return null;
  try {
    return lastAssistantText(readFileSync(payload.transcript_path, "utf8"));
  } catch {
    return null;
  }
}

export function lastAssistantText(jsonl: string): string | null {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"assistant"')) continue;
    let entry: { type?: string; message?: { content?: unknown } };
    try {
      entry = JSON.parse(lines[i]) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== "assistant") continue;
    const content = entry.message?.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter(
        (c): c is { type: "text"; text: string } =>
          typeof c === "object" &&
          c !== null &&
          (c as { type?: unknown }).type === "text" &&
          typeof (c as { text?: unknown }).text === "string",
      )
      .map((c) => c.text)
      .join("\n");
    if (text.trim()) return text;
  }
  return null;
}

// Only the calls that make or change a Claude artifact fire "made": the
// Artifact tool and the Claude Docs connector's writes. Reads and listings
// name artifacts the session did not make.
export const ARTIFACT_TOOLS = "^(Artifact|mcp__.*Claude_Docs__(batch|create))$";

const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifacts?\/[\w-]+/;

function text(v: unknown): string {
  return typeof v === "string" ? v : (JSON.stringify(v) ?? "");
}

// The artifact a call made, and what to call it. A publish to an existing
// one names it in its input; otherwise the result carries the new link.
export function artifactLink(
  payload: HookPayload,
): { url: string; title: string } | null {
  const tool = payload.tool_name ?? "";
  const input = payload.tool_input ?? {};
  let title: string;
  if (tool === "Artifact") {
    const action = input.action ?? "publish";
    if (action !== "publish" || input.asset) return null;
    const file = typeof input.file_path === "string" ? input.file_path : "";
    title =
      (typeof input.title === "string" && input.title.trim()) ||
      file.split("/").pop()?.replace(/\.[^.]+$/, "") ||
      "Claude artifact";
  } else if (/^mcp__.*Claude_Docs__/.test(tool)) {
    const container = (input.container ?? {}) as { create?: { name?: unknown } };
    const name = container.create?.name;
    title = typeof name === "string" && name.trim() ? name.trim() : "Claude doc";
  } else return null;
  const url =
    (typeof input.url === "string" ? input.url.match(ARTIFACT_URL)?.[0] : null) ??
    text(payload.tool_response).match(ARTIFACT_URL)?.[0];
  return url ? { url, title } : null;
}

// A republish keeps whatever title the link already has: the agent or the
// owner may have named it better than a file name does.
function linkArtifact(payload: HookPayload, env: HookEnv): void {
  const made = artifactLink(payload);
  if (!made) return;
  if (store.linksForTask(env.taskId).some((l) => l.url === made.url)) return;
  store.addTaskLink(
    env.taskId,
    made.url,
    made.title,
    `agent ${store.taskRef(env.taskId)}`,
  );
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
