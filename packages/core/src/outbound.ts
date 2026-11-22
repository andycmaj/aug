// The only road out. A drafted action goes nowhere until the owner presses
// Send; then it returns through the channel the conversation started on.
// Sending never closes the task: Mark done does.

import type { TurnAnswer } from "./agents";
import type { RikerConfig } from "./config";
import { draftSent } from "./lifecycle";
import { logger } from "./log";
import { messageMeta } from "./meta";
import type { Send, Senders } from "./plugins";
import * as store from "./store";
import {
  ActionState,
  TurnRole,
  type DraftAction,
  type MessageRow,
  type TaskRow,
} from "./types";

export type Sender = (
  action: DraftAction,
  config: RikerConfig,
) => Promise<string>;

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

// Fixtures and tests replace every sender at once (nothing leaves the demo).
let override: Sender | null = null;

export function setSender(next: Sender | null): void {
  override = next;
}

export class SendError extends Error {}

// Each action goes out through the plugin that brought its type
// (core/plugins.ts); with none, it is not sent and says why.
function send(action: DraftAction, config: RikerConfig, senders: Senders): Promise<string> {
  if (override) return override(action, config);
  const sender = senders[action.type] as Send | undefined;
  if (!sender) return Promise.reject(new SendError(`nothing is connected to send a ${describeAction(action)}`));
  return sender(action, config);
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
export async function sendPending(
  config: RikerConfig,
  taskId: number,
  senders: Senders,
): Promise<string> {
  const pending = store.pendingAction(taskId);
  if (!pending) throw new SendError("nothing waits to be sent");
  try {
    const receipt = await send(pending.action, config, senders);
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
