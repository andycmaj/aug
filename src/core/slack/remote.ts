// The owner talking to the Assistant from Slack: one conversation only they
// are in (their self-DM, or a private channel with nobody else) is read on a
// clock. Each new line of theirs goes to Home as if typed there, and the
// Assistant's answer is posted back in that message's thread.
//
// The conversation is the trust boundary: aug refuses one with anyone else
// in it, and inside it hears only the owner's own plain messages, never a
// bot's, an app's, a join notice or its own answers. What it hears is the
// owner talking to the Assistant, with the Assistant's limits, nothing more.

import type { ConfigSource } from "../config";
import { errorMessage, logger } from "../log";
import * as store from "../store";
import {
  SLACK_AUTHOR,
  TurnRole,
  TurnStatus,
  type TurnRow,
} from "../types";

const log = logger("slack.remote");

export interface RemoteMessage {
  ts: string;
  // The parent's ts when this is a thread reply.
  threadTs?: string;
  // The author's user id; empty when the reader could not say.
  user: string;
  // A bot or an app wrote it.
  bot: boolean;
  // Slack's subtype: a join, an edit, a file share. Plain messages have none.
  subtype?: string;
  text: string;
}

export interface RemoteRead {
  // The conversation read: the configured one, or the self-DM found.
  channel: string;
  // The owner's user id.
  me: string;
  // Who is in the conversation (a self-DM has only the owner).
  members: string[];
  messages: RemoteMessage[];
}

export interface RemoteQuery {
  channel?: string;
  // Unix seconds: only messages newer than this.
  since: string;
  // Thread parents whose new replies are wanted.
  threads: string[];
}

// How aug reads and posts that one conversation: the Web API with a token,
// or Claude with a Slack MCP.
export interface RemoteLink {
  readonly kind: "token" | "claude-mcp";
  read(query: RemoteQuery): Promise<RemoteRead>;
  // Returns the posted message's ts when the link knows it.
  post(channel: string, threadTs: string, text: string): Promise<string | null>;
  stop(): void;
}

// Every answer starts with this, so a reader that sees the owner's own name
// on aug's posts (both links post as the owner) can tell them apart.
export const REPLY_MARK = "[aug]";

// Slack answers stay short: past this the rest is in aug.
const REPLY_CHARS = 3500;

// A thread stays live for replies this long after its last line.
const THREAD_HOURS = 24;
const MAX_THREADS = 10;

// An owner line with no answer after this is given up on, with a note.
const ANSWER_MINUTES = 60;

const STATE_KEY = "slack.remote";

interface Waiting {
  // The owner's turn in Home.
  turnId: number;
  channel: string;
  threadTs: string;
  at: string;
}

interface RemoteState {
  // The conversation last read, so the triage poller can leave it alone.
  channel?: string;
  since?: string;
  // thread ts -> when it last had a line (ISO)
  threads: Record<string, string>;
  waiting: Waiting[];
  // ts of what aug posted, newest last.
  posted: string[];
}

function loadState(): RemoteState {
  try {
    const raw = store.kvGet(STATE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<RemoteState>;
      return {
        channel: parsed.channel,
        since: parsed.since,
        threads: parsed.threads ?? {},
        waiting: parsed.waiting ?? [],
        posted: parsed.posted ?? [],
      };
    }
  } catch (err) {
    log.warn("state unreadable, starting fresh", { err: errorMessage(err) });
  }
  return { threads: {}, waiting: [], posted: [] };
}

function saveState(state: RemoteState): void {
  store.kvSet(STATE_KEY, JSON.stringify(state));
}

// The conversation the triage poller must skip: aug's own talk with the owner.
export function remoteChannel(config: ConfigSource): string | undefined {
  const c = config.get().remote;
  if (!c.enabled) return undefined;
  return c.channel ?? loadState().channel;
}

const nowSeconds = () => (Date.now() / 1000).toFixed(6);
const newer = (a: string, b: string) => Number(a) > Number(b);

// Why the conversation is not the owner's alone, or null when it is.
export function notPrivate(read: RemoteRead): string | null {
  if (!read.me) return "could not tell who you are";
  const others = read.members.filter((m) => m && m !== read.me);
  if (others.length)
    return `${read.channel} has ${others.length} other member${others.length === 1 ? "" : "s"}: use your self-DM or a private channel with only you in it`;
  return null;
}

// Mark-stripped: leading emoji shortcodes, Markdown and spaces.
function startsWithMark(text: string): boolean {
  return text
    .replace(/^(\s|[*_~`>]|:[a-z0-9_+-]+:)+/i, "")
    .startsWith(REPLY_MARK);
}

// Why aug does not hear this message, or null when it is the owner's.
export function skipReason(
  msg: RemoteMessage,
  me: string,
  posted: Set<string>,
): string | null {
  if (posted.has(msg.ts)) return "aug posted it";
  if (msg.bot) return "a bot or app wrote it";
  if (msg.subtype && msg.subtype !== "thread_broadcast")
    return `subtype ${msg.subtype}`;
  if (msg.user !== me) return "not the owner";
  if (!msg.text.trim()) return "empty";
  if (startsWithMark(msg.text)) return "aug's answer";
  return null;
}

// The answer as Slack shows it: its mrkdwn has *bold* and no headings.
export function toSlack(text: string): string {
  const body = text
    .trim()
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+(.+)$/gm, "*$1*");
  const clipped =
    body.length > REPLY_CHARS
      ? `${body.slice(0, REPLY_CHARS).trimEnd()}\n… (the rest is in aug's Home)`
      : body;
  return `${REPLY_MARK} ${clipped || "(no answer)"}`;
}

export interface RemoteDeps {
  link: RemoteLink;
  config: ConfigSource;
  // The desk's say: the line goes to Home as the owner's.
  say: (taskId: number, text: string, author: string) => Promise<boolean>;
  // Runs Home's agent again: a line that came while it was mid-turn.
  wake: (taskId: number) => void;
}

export interface TickResult {
  heard: number;
  answered: number;
  channel: string;
}

export class Remote {
  private busy = false;

  constructor(private deps: RemoteDeps) {}

  get kind(): RemoteLink["kind"] {
    return this.deps.link.kind;
  }

  // One look: hear what is new, then post what has been answered. Throws
  // when Slack cannot be reached or the conversation is not the owner's
  // alone; nothing is lost, the next tick tries again.
  async tick(): Promise<TickResult | null> {
    if (this.busy) return null;
    this.busy = true;
    try {
      const state = loadState();
      // The first look starts now: an old "yes" never runs anything.
      if (!state.since) {
        state.since = nowSeconds();
        saveState(state);
      }
      const read = await this.deps.link.read({
        channel: this.deps.config.get().remote.channel ?? state.channel,
        since: state.since,
        threads: this.liveThreads(state),
      });
      const refused = notPrivate(read);
      if (refused) throw new Error(refused);
      state.channel = read.channel;
      const heard = await this.hear(state, read);
      saveState(state);
      const answered = await this.answer(state);
      return { heard, answered, channel: read.channel };
    } finally {
      this.busy = false;
    }
  }

  private liveThreads(state: RemoteState): string[] {
    const cutoff = Date.now() - THREAD_HOURS * 3600_000;
    for (const [ts, at] of Object.entries(state.threads))
      if (Date.parse(at) < cutoff) delete state.threads[ts];
    return Object.entries(state.threads)
      .sort((a, b) => b[1].localeCompare(a[1]))
      .slice(0, MAX_THREADS)
      .map(([ts]) => ts);
  }

  private async hear(state: RemoteState, read: RemoteRead): Promise<number> {
    const posted = new Set(state.posted);
    const seen = new Set<string>();
    const fresh = read.messages
      .filter((m) => newer(m.ts, state.since ?? "0"))
      .sort((a, b) => Number(a.ts) - Number(b.ts));
    const home = store.homeTask();
    let heard = 0;
    for (const msg of fresh) {
      if (seen.has(msg.ts)) continue;
      seen.add(msg.ts);
      const skip = skipReason(msg, read.me, posted);
      // Only the ts and why: message text never reaches the log.
      if (skip) {
        log.debug("skipped", { ts: msg.ts, why: skip });
        continue;
      }
      const threadTs =
        msg.threadTs && msg.threadTs !== msg.ts ? msg.threadTs : msg.ts;
      const text = msg.text.trim();
      await this.deps.say(home.id, text, SLACK_AUTHOR);
      const turn = store
        .turnsForTask(home.id)
        .findLast(
          (t) =>
            t.role === TurnRole.you &&
            t.author === SLACK_AUTHOR &&
            t.body === text,
        );
      if (turn)
        state.waiting.push({
          turnId: turn.id,
          channel: read.channel,
          threadTs,
          at: new Date().toISOString(),
        });
      state.threads[threadTs] = new Date().toISOString();
      heard++;
      log.info("heard", { ts: msg.ts, thread: threadTs, turn: turn?.id });
    }
    for (const msg of fresh)
      if (newer(msg.ts, state.since ?? "0")) state.since = msg.ts;
    return heard;
  }

  // The first finished Assistant turn after each waiting line is its answer.
  // Two lines in one thread answered by one turn get one post.
  private async answer(state: RemoteState): Promise<number> {
    if (!state.waiting.length) return 0;
    const home = store.homeTask();
    const agentTurns = store
      .turnsForTask(home.id)
      .filter((t) => t.role === TurnRole.agent);
    let answered = 0;
    const done = new Set<string>();
    // A line heard while a turn ran is not in that turn: run another.
    const idle = !agentTurns.some((t) => t.status === TurnStatus.running);
    const unheard = state.waiting.some(
      (w) => !agentTurns.some((t) => t.id > w.turnId),
    );
    if (idle && unheard) this.deps.wake(home.id);
    for (const w of [...state.waiting]) {
      const turn = agentTurns.find((t) => t.id > w.turnId);
      if (turn?.status === TurnStatus.running) continue;
      const stale = Date.now() - Date.parse(w.at) > ANSWER_MINUTES * 60_000;
      if (!turn && !stale) continue;
      const key = `${w.threadTs}:${turn?.id ?? "none"}`;
      if (!done.has(key)) {
        const text = turn
          ? toSlack(answerText(turn))
          : `${REPLY_MARK} No answer: the Assistant did not run. Try again, or look in aug.`;
        // A failed post throws with w still waiting: the next tick posts it.
        const ts = await this.deps.link.post(w.channel, w.threadTs, text);
        if (ts) state.posted = [...state.posted, ts].slice(-50);
        state.threads[w.threadTs] = new Date().toISOString();
        done.add(key);
        answered++;
        log.info("answered", { thread: w.threadTs, turn: turn?.id ?? null });
      }
      state.waiting = state.waiting.filter((x) => x !== w);
      saveState(state);
    }
    return answered;
  }

  stop(): void {
    this.deps.link.stop();
  }
}

function answerText(turn: TurnRow): string {
  if (turn.status === TurnStatus.failed)
    return `That did not work: ${turn.body}`;
  return turn.body || turn.did || "";
}
