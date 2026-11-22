// What another package adds to Riker, and the only way it does. Core runs
// the engine, the desk and the store; it knows no inbox source (GitHub,
// Slack), no way out, and not how a message is judged. A package hands the
// engine a RikerPlugin at an entry point (tui's index.tsx, the fixture day,
// the sim, a test) and core runs what it brings without importing it.
//
// Dependencies run one way: a plugin package imports @riker/core, never the
// reverse, and plugins never import each other.

import type { ConfigSource, RikerConfig } from "./config";
import type { NewMessage } from "./store";
import type {
  DraftAction,
  MessageRow,
  TriageVerdict,
} from "./types";

// ── triage: what happens to a message after a poller inserts it ─────────

export type TriageEffect =
  | { type: "agent-turn"; taskId: number; reason: string }
  | { type: "agent-message"; taskId: number; messageId: number };

export interface ProjectPick {
  projectId: number | null;
  reason: string;
}

export interface TriageOutcome {
  verdict: TriageVerdict;
  taskId: number | null;
  reason: string;
  effects: TriageEffect[];
  // A new task only: the project it was filed under, or why none.
  project?: ProjectPick;
}

export interface Triaged {
  messages: number[];
  outcome: TriageOutcome;
}

// The inbox's judge. The engine's one worker calls next() until nothing is
// due; the desk calls again() and fromHeld() for the owner's keys. Without
// one, messages wait in the Inbox untriaged.
export interface Triage {
  // A fresh message, before it waits its turn (a PR on a task's branch is
  // that task's thread).
  arrived?(message: MessageRow): void;
  // Claims and triages the next due batch; null when nothing is due. A
  // model failure is an outcome; a throw leaves its messages for retry.
  next(config: RikerConfig): Promise<Triaged | null>;
  // One message again, as a new run. The caller has claimed it.
  again(message: MessageRow, config: RikerConfig): Promise<TriageOutcome>;
  // A message held for the owner made into the task its verdict described,
  // or null when no run gave one.
  fromHeld(message: MessageRow, config: RikerConfig): TriageOutcome | null;
}

// ── connections: where messages come from and where replies go ──────────

export type ConnectorState = "off" | "polling" | "ok" | "error";

export interface ConnectorStatus {
  state: ConnectorState;
  detail: string;
  at: string | null;
}

export const offStatus = (detail: string): ConnectorStatus => ({
  state: "off",
  detail,
  at: null,
});

// What the engine lends a connector while it runs.
export interface ConnectorContext {
  config: ConfigSource;
  status(): ConnectorStatus;
  setStatus(next: ConnectorStatus): void;
  // Inserts what a poll read (a duplicate is refused) and wakes triage;
  // returns how many were new.
  ingest(messages: NewMessage[]): number;
  // A timer the engine clears at stop.
  every(ms: number, fn: () => void): void;
  // The owner's words into a task, and a wake for its agent.
  say(taskId: number, text: string, author: string): void;
  wake(taskId: number, reason: string): void;
  // A move run on the desk, as `by`.
  runMove(verb: string, args: Record<string, string>, by: string): Promise<{ ok: boolean; result: string }>;
  // Work the engine runs on its own clock that a poll may want now.
  checkMerges(): Promise<void>;
}

// One source or line, with its own clock and status line. `name` keys the
// status (engine.status[name]); `label` is what the status modal calls it.
export interface Connector {
  name: string;
  label: string;
  // Left off the footer's line while off (an opt-in nobody turned on).
  quietWhenOff?: boolean;
  // One line for the status modal on what it needs to connect.
  hint?: string;
  // What the engine lends, handed over once when it is made, so a test or
  // the fixture day can poll a connector the engine never started.
  attach(ctx: ConnectorContext): void;
  // Starts its clocks (never on the fixture day).
  start(): void;
  stop?(): void;
  // The owner's "check now": skips a backoff, never a rate limit.
  pollNow?(): Promise<void>;
}

// Sends one drafted action of its type; resolves to a receipt line.
export type Send<T extends DraftAction = DraftAction> = (
  action: T,
  config: RikerConfig,
) => Promise<string>;

export type Senders = {
  [K in DraftAction["type"]]?: Send<Extract<DraftAction, { type: K }>>;
};

// A move the owner must say yes to before it runs: the guard answers what
// to say instead (held), or null to let it run.
export type MoveGuard = (
  verb: string,
  args: Record<string, string>,
  by: string,
) => string | null;

export interface RikerPlugin {
  name: string;
  triage?: Triage;
  connectors?: Connector[];
  senders?: Senders;
  guards?: MoveGuard[];
}
