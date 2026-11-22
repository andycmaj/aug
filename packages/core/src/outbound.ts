// The only road out. A drafted action goes nowhere until the owner presses
// Send; then it returns through the channel the conversation started on.
// Sending never closes the task: Mark done does.

import type { TurnAnswer } from "./agents";
import type { RikerConfig } from "./config";
import { draftSent } from "./lifecycle";
import { logger } from "./log";
import type { DraftKind, RikerPlugin } from "./plugins";
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

// Fixtures and tests replace every sender at once (nothing leaves the demo).
let override: Sender | null = null;

export function setSender(next: Sender | null): void {
  override = next;
}

export class SendError extends Error {}

// Every kind of draft the plugins brought (core/plugins.ts), by type. Core
// knows no kind itself: it builds, words, rewrites and sends a draft through
// the kind that made it, and one no plugin brings is said by its type and
// not sent.
export class Drafts {
  private kinds = new Map<string, DraftKind>();

  constructor(kinds: readonly DraftKind[] = []) {
    for (const kind of kinds) {
      if (this.kinds.has(kind.type)) throw new Error(`two plugins draft ${kind.type}`);
      this.kinds.set(kind.type, kind);
    }
  }

  // The model says what to send; where it goes comes from the thread itself,
  // never from the model: the first kind that can answer its last message.
  for(task: TaskRow, answer: TurnAnswer["action"]): DraftAction | null {
    const text = answer?.text.trim();
    if (!answer || !text) return null;
    const message = lastIncoming(task.id);
    if (!message) return null;
    for (const kind of this.kinds.values()) {
      const draft = kind.build(message, { ...answer, text });
      if (draft) return draft;
    }
    return null;
  }

  describe(action: DraftAction): string {
    return this.kinds.get(action.type)?.describe(action) ?? `${action.type} draft`;
  }

  text(action: DraftAction): string {
    return this.kinds.get(action.type)?.text(action) ?? "";
  }

  withText(action: DraftAction, text: string): DraftAction {
    return this.kinds.get(action.type)?.withText(action, text) ?? action;
  }

  static of(plugins: readonly RikerPlugin[]): Drafts {
    return new Drafts(plugins.flatMap((p) => p.drafts ?? []));
  }

  send(action: DraftAction, config: RikerConfig): Promise<string> {
    if (override) return override(action, config);
    const kind = this.kinds.get(action.type);
    if (!kind) return Promise.reject(new SendError(`nothing is connected to send a ${this.describe(action)}`));
    return kind.send(action, config);
  }
}

const log = logger("outbound");

// Sends the pending action on a task. A refused act sends nothing and says why.
export async function sendPending(
  config: RikerConfig,
  taskId: number,
  drafts: Drafts,
): Promise<string> {
  const pending = store.pendingAction(taskId);
  if (!pending) throw new SendError("nothing waits to be sent");
  try {
    const receipt = await drafts.send(pending.action, config);
    log.info("sent", {
      task: taskId,
      action: drafts.describe(pending.action),
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
      action: drafts.describe(pending.action),
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
export function editPending(taskId: number, text: string, drafts: Drafts): string | null {
  const pending = store.pendingAction(taskId);
  if (!pending) return null;
  const before = drafts.text(pending.action);
  if (before.trim() === text.trim()) return null;
  store.updateTurn(pending.turn.id, {
    action: JSON.stringify(drafts.withText(pending.action, text)),
  });
  return before;
}
