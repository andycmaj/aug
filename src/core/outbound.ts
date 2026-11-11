// The only road out. A drafted action goes nowhere until the owner presses
// Send; then it returns through the channel the conversation started on.
// Sending never closes the task: Mark done does.

import type { TurnAnswer } from "./agents";
import { loadConfig } from "./config";
import { draftSent } from "./lifecycle";
import { logger } from "./log";
import { messageMeta } from "./meta";
import * as store from "./store";
import {
  ActionState,
  TurnRole,
  type DraftAction,
  type MessageRow,
  type TaskRow,
} from "./types";

export type Sender = (action: DraftAction) => Promise<string>;

export function lastIncoming(taskId: number): MessageRow | null {
  const messages = store.messagesForTask(taskId).filter((m) => !m.from_me);
  return messages[messages.length - 1] ?? null;
}

// The model says what to send; where it goes comes from the thread itself,
// never from the model.
export function actionFor(
  task: TaskRow,
  answer: TurnAnswer["action"],
): DraftAction | null {
  if (!answer?.text.trim()) return null;
  const message = lastIncoming(task.id);
  if (!message) return null;
  const meta = messageMeta(message);
  if (meta.channel === "slack") {
    if (!meta.slackChannel) return null;
    const threadTs = meta.thread_ts ?? (meta.dm ? null : meta.ts);
    return {
      type: "slack_reply",
      channel: meta.slackChannel,
      thread_ts: threadTs ?? undefined,
      to: message.author_name,
      text: answer.text.trim(),
    };
  }
  if (meta.channel === "github") {
    if (!meta.repo || !meta.number) return null;
    const isPr = meta.type === "PullRequest";
    const close =
      answer.kind === "close_issue" && !isPr
        ? ("issue" as const)
        : answer.kind === "merge_pr" && isPr
          ? ("merge" as const)
          : answer.kind === "approve_pr" && isPr
            ? ("approve" as const)
            : undefined;
    return {
      type: "github_comment",
      repo: meta.repo,
      number: meta.number,
      body: answer.text.trim(),
      close,
    };
  }
  return null;
}

let impl: Sender = realSend;

export function setSender(next: Sender): void {
  impl = next;
}

export class SendError extends Error {}

async function gh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new SendError(err.trim() || `gh exited ${code}`);
  return out.trim();
}

// Slack replies go through whichever transport the engine chose.
type SlackSend = (
  action: Extract<DraftAction, { type: "slack_reply" }>,
) => Promise<string>;

let slackSend: SlackSend = () =>
  Promise.reject(new SendError("Slack is not connected"));

export function setSlackSender(next: SlackSend): void {
  slackSend = next;
}

async function githubSend(
  action: Extract<DraftAction, { type: "github_comment" }>,
): Promise<string> {
  const ref = `${action.repo}#${action.number}`;
  switch (action.close) {
    case "approve":
      await gh([
        "pr",
        "review",
        String(action.number),
        "-R",
        action.repo,
        "--approve",
        "--body",
        action.body,
      ]);
      return `approved ${ref} with your comment`;
    case "merge": {
      await gh([
        "api",
        `repos/${action.repo}/issues/${action.number}/comments`,
        "-f",
        `body=${action.body}`,
      ]);
      const method = loadConfig().github.mergeMethod;
      await gh([
        "pr",
        "merge",
        String(action.number),
        "-R",
        action.repo,
        `--${method}`,
      ]);
      return `commented and merged ${ref}`;
    }
    case "issue":
      await gh([
        "issue",
        "close",
        String(action.number),
        "-R",
        action.repo,
        "--comment",
        action.body,
      ]);
      return `closed ${ref} with your comment`;
    default:
      await gh([
        "api",
        `repos/${action.repo}/issues/${action.number}/comments`,
        "-f",
        `body=${action.body}`,
      ]);
      return `commented on ${ref}`;
  }
}

async function realSend(action: DraftAction): Promise<string> {
  return action.type === "slack_reply" ? slackSend(action) : githubSend(action);
}

export function describeAction(action: DraftAction): string {
  if (action.type === "slack_reply") {
    return `Slack reply${action.to ? ` to ${action.to}` : ""}${action.thread_ts ? " (in thread)" : ""}`;
  }
  const what =
    action.close === "merge"
      ? "comment + merge"
      : action.close === "issue"
        ? "comment + close issue"
        : action.close === "approve"
          ? "approve with comment"
          : "comment";
  return `GitHub ${what} on ${action.repo}#${action.number}`;
}

export function actionText(action: DraftAction): string {
  return action.type === "slack_reply" ? action.text : action.body;
}

export function withText(action: DraftAction, text: string): DraftAction {
  return action.type === "slack_reply"
    ? { ...action, text }
    : { ...action, body: text };
}

const log = logger("outbound");

// Sends the pending action on a task. A refused act sends nothing and says why.
export async function sendPending(taskId: number): Promise<string> {
  const pending = store.pendingAction(taskId);
  if (!pending) throw new SendError("nothing waits to be sent");
  try {
    const receipt = await impl(pending.action);
    log.info("sent", {
      task: taskId,
      action: describeAction(pending.action),
      receipt,
    });
    store.batch(() => {
      store.updateTurn(pending.turn.id, {
        action_state: ActionState.sent,
        action_result: receipt,
      });
      store.addTurn({
        taskId,
        role: TurnRole.trigger,
        body: `Sent: ${receipt}`,
      });
      draftSent(taskId);
    });
    return receipt;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("send failed", {
      task: taskId,
      action: describeAction(pending.action),
      err,
    });
    store.updateTurn(pending.turn.id, {
      action_result: `not sent: ${message}`,
    });
    throw new SendError(message);
  }
}

// The owner rewrote the draft before sending. Returns the words it replaced
// (the caller keeps them as a correction: editing a draft teaches voice).
export function editPending(taskId: number, text: string): string | null {
  const pending = store.pendingAction(taskId);
  if (!pending) return null;
  const before = actionText(pending.action);
  if (before.trim() === text.trim()) return null;
  store.updateTurn(pending.turn.id, {
    action: JSON.stringify(withText(pending.action, text)),
  });
  return before;
}
