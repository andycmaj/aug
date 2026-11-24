// What another package adds to Riker, and the only way it does. Core runs
// the engine, the desk and the store; it knows no inbox source (GitHub,
// Slack), no way out, and not how a message is judged. A package hands the
// engine a RikerPlugin at an entry point (tui's index.tsx, the fixture day,
// the sim, a test) and core runs what it brings without importing it.
//
// Dependencies run one way: a plugin package imports @riker/core, never the
// reverse, and plugins never import each other.

import type { TurnAnswer } from "./agents";
import type { ConfigSection, ConfigSource, RikerConfig } from "./config";
import type { NewMessage } from "./store";
import type {
  DraftAction,
  MessageRow,
  TriageVerdict,
} from "./types";

// ── triage: what happens to a message after a poller inserts it ─────────

export type TriageEffect =
  | { type: "agent-turn"; taskId: number; reason: string }
  | { type: "agent-message"; taskId: number; messageId: number }
  // A follow-up or schedule came due: its agent picks the work up again.
  | { type: "timer"; taskId: number; turnId: number; reason: string };

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
  say(taskId: number, text: string, author: string): Promise<boolean>;
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

// ── drafts: the one road out ───────────────────────────────────────────

// What the model said to send (TurnAnswer.action), trimmed and not empty.
export type DraftAnswer = NonNullable<TurnAnswer["action"]>;

// One kind of draft a plugin sends, and everything core says or does about
// it: core keeps a draft as its JSON and asks the kind that built it. A
// plugin's kinds never share a type with another plugin's.
export interface DraftKind<T extends DraftAction = DraftAction> {
  type: string;
  // The draft answering `message` (a task's last incoming one), where it
  // goes read from the message itself, never from the model. Null when the
  // message is not on this plugin's channel or lacks what a reply needs.
  build(message: MessageRow, answer: DraftAnswer): T | null;
  // What the owner reads before pressing Send: "Slack reply to Ann".
  describe(action: T): string;
  // The words the owner may rewrite, and the draft with them rewritten.
  text(action: T): string;
  withText(action: T, text: string): T;
  // Sends it; resolves to a receipt line.
  send(action: T, config: RikerConfig): Promise<string>;
}

// A move the owner must say yes to before it runs: the guard answers what
// to say instead (held), or null to let it run.
export type MoveGuard = (
  verb: string,
  args: Record<string, string>,
  by: string,
) => string | null;

export interface RikerPlugin {
  name: string;
  // Its parts of config.json, each under its own key (core/config.ts).
  config?: ConfigSection<object>[];
  triage?: Triage;
  connectors?: Connector[];
  drafts?: DraftKind[];
  guards?: MoveGuard[];
  // Lines for the Assistant's system prompt (core/assistant.ts): what this
  // plugin lets it look up, and how a line heard from its place is answered.
  assistant?(config: RikerConfig): string[];
}
