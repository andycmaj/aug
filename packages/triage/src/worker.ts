// The inbox's one worker. Pollers only insert messages (state new) and move
// their cursors on; this takes them oldest first, the way the engine takes
// moves: claim, run the chain, settle. A claim is a try, so a message that
// keeps failing (or keeps killing Riker mid-triage) stops after
// TRIAGE_MAX_ATTEMPTS and waits on the Inbox tab for the owner.
//
// A burst on one thread is one triage: messages on the same thread_key that
// arrived within BATCH_WINDOW_MS of each other are read as one message (the
// latest, carrying all their text), and the earlier ones follow it.

import { logger } from "@riker/core/log";
import { perfStart } from "@riker/core/perf";
import * as store from "@riker/core/store";
import { triage, type TriageDeps, type TriageOutcome } from "./triage";
import { MessageState, type MessageRow } from "@riker/core/types";

export const TRIAGE_MAX_ATTEMPTS = 4;
// 1, 4, then 16 minutes between tries: a model outage gets time to pass.
export const RETRY_BASE_MS = 60_000;
export const BATCH_WINDOW_MS = 2 * 60_000;

const log = logger("triage-worker");

export function retryDelayMs(attempts: number): number {
  return RETRY_BASE_MS * 4 ** Math.max(0, attempts - 1);
}

// The oldest due message and the ones after it on its thread, each within
// the window of the one before. The owner's own messages are triaged alone:
// they answer, they do not ask, and one ends the burst before it.
export function nextBatch(due: readonly MessageRow[]): MessageRow[] {
  const first = due[0];
  if (!first) return [];
  if (first.from_me) return [first];
  const batch = [first];
  for (const m of due.slice(1)) {
    if (m.thread_key !== first.thread_key) continue;
    // The owner answered in between: what comes after is a new turn.
    if (m.from_me) break;
    const last = batch[batch.length - 1]!;
    if (Date.parse(m.received_at) - Date.parse(last.received_at) > BATCH_WINDOW_MS) break;
    batch.push(m);
  }
  return batch;
}

// One message for the chain: the latest (a reply goes to it), with every
// message's text in order, each named when more than one person wrote.
export function combined(batch: readonly MessageRow[]): MessageRow {
  const lead = batch[batch.length - 1]!;
  if (batch.length === 1) return lead;
  const authors = new Set(batch.map((m) => m.author));
  const body = batch
    .map((m) => (authors.size > 1 ? `${m.author_name}: ${m.body}` : m.body))
    .join("\n\n");
  // A mention anywhere in the burst is a mention of it.
  const meta = JSON.parse(lead.meta) as Record<string, unknown>;
  const mentioned = batch.some(
    (m) => (JSON.parse(m.meta) as { mention?: boolean }).mention === true,
  );
  return {
    ...lead,
    body,
    meta: mentioned ? JSON.stringify({ ...meta, mention: true }) : lead.meta,
  };
}

export interface Triaged {
  messages: number[];
  outcome: TriageOutcome;
}

// Triage the next due batch, or null when nothing is due.
export async function triageNext(
  deps: TriageDeps,
  at: Date = new Date(),
): Promise<Triaged | null> {
  const batch = nextBatch(store.dueMessages(at.toISOString())).filter((m) =>
    store.claimMessage(m.id),
  );
  if (batch.length === 0) return null;
  const claimed = batch.map((m) => store.getMessage(m.id)!);
  const lead = claimed[claimed.length - 1]!;
  const earlier = claimed.slice(0, -1);
  const done = perfStart("engine.triage", { channel: lead.channel });
  let outcome: TriageOutcome;
  try {
    outcome = await triage(combined(claimed), { ...deps, batch: earlier });
  } catch (err) {
    // The chain itself threw (not the model, whose failure is an outcome):
    // the same retry, with nothing filed.
    done({ ok: false });
    log.error("triage threw", { message: lead.id, err });
    for (const m of claimed) retryOrGiveUp(m, at);
    throw err;
  }
  done({ verdict: outcome.verdict, batch: claimed.length });
  if (outcome.verdict === "failed")
    for (const m of claimed) retryOrGiveUp(m, at);
  return { messages: claimed.map((m) => m.id), outcome };
}

function retryOrGiveUp(m: MessageRow, at: Date): void {
  const attempts = store.getMessage(m.id)?.attempts ?? m.attempts;
  const next =
    attempts < TRIAGE_MAX_ATTEMPTS
      ? new Date(at.getTime() + retryDelayMs(attempts)).toISOString()
      : null;
  store.settleMessage(m.id, MessageState.failed, next);
  if (!next) log.warn("triage gave up", { message: m.id, attempts });
}
