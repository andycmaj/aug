// What every Slack transport shares: one message shape coming in, the
// thread-key rules, and the transport seam itself. However a message was
// read (the Web API with a token, or Claude through a Slack MCP), it lands
// as the same NewMessage, so dedupe and triage never know the difference.

import type { NewMessage } from "../store";
import type { DraftAction } from "../types";

export type SlackReply = Extract<DraftAction, { type: "slack_reply" }>;

export interface SlackCursor {
  // channel id -> newest ts seen (token transport)
  channels: Record<string, string>;
  // thread key -> newest reply ts seen (token transport)
  threads: Record<string, string>;
  searchedAt?: string;
  // newest ts seen anywhere (claude-mcp transport)
  since?: string;
}

export const EMPTY_CURSOR: SlackCursor = { channels: {}, threads: {} };

export interface PollContext {
  cursor: SlackCursor;
  // Channel ids whose every message is triaged.
  watchChannels: string[];
  // Threads aug tracks (open slack tasks), as "channel:thread_ts".
  trackedThreads: string[];
  // How far back a first look reaches.
  firstLookSeconds: number;
}

export interface SlackPollResult {
  messages: NewMessage[];
  cursor: SlackCursor;
}

export interface SlackTransport {
  readonly kind: "token" | "claude-mcp" | "mcp";
  // Whether polling can start at all, and why not.
  available(): { ok: boolean; detail: string };
  poll(ctx: PollContext): Promise<SlackPollResult>;
  // Posts the owner's approved reply; returns a receipt or throws.
  send(action: SlackReply): Promise<string>;
  stop(): void;
}

export function tsToIso(ts: string): string {
  return new Date(Math.floor(Number(ts) * 1000)).toISOString();
}

export function threadKeyFor(
  channel: string,
  msg: { ts: string; thread_ts?: string },
  dm: boolean,
): string {
  if (msg.thread_ts) return `slack:${channel}:${msg.thread_ts}`;
  return dm ? `slack:${channel}:dm` : `slack:${channel}:${msg.ts}`;
}

// <@U123> -> @name, <https://x|label> -> label (https://x), <#C1|general> -> #general
export function plainText(text: string, names: Map<string, string>): string {
  return text
    .replace(
      /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g,
      (_, id: string) => `@${names.get(id) ?? id}`,
    )
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2 ($1)")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// One Slack message, as either transport reads it.
export interface RawSlack {
  channel: string;
  // "DM with Ruth", "#renewals", "thread"
  where: string;
  dm: boolean;
  ts: string;
  threadTs?: string;
  author: string;
  authorName: string;
  // Already plain (mentions resolved); see plainText.
  text: string;
  url: string | null;
  fromMe: boolean;
}

export function rawToNewMessage(raw: RawSlack): NewMessage {
  return {
    channel: "slack",
    externalId: `slack:${raw.channel}:${raw.ts}`,
    threadKey: threadKeyFor(
      raw.channel,
      { ts: raw.ts, thread_ts: raw.threadTs },
      raw.dm,
    ),
    author: raw.author,
    authorName: raw.authorName,
    title: raw.where,
    body: raw.text,
    url: raw.url,
    receivedAt: tsToIso(raw.ts),
    fromMe: raw.fromMe,
    meta: {
      channel: raw.channel,
      ts: raw.ts,
      thread_ts: raw.threadTs,
      dm: raw.dm,
    },
  };
}
