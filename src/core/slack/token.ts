// Slack through the Web API with a user token, so replies go back as you and
// the inbox is yours: direct messages, mentions of you, the configured
// channels, and new replies on threads aug already tracks.

import { logger } from "../log";
import type { NewMessage } from "../store";
import {
  plainText,
  rawToNewMessage,
  type PollContext,
  type SlackCursor,
  type SlackPollResult,
  type SlackReply,
  type SlackTransport,
} from "./shared";

const log = logger("slack.token");

export type SlackApi = (
  method: string,
  params: Record<string, string>,
) => Promise<Record<string, unknown>>;

export function slackApi(token: string): SlackApi {
  return async (method, params) => {
    const res = await fetch(
      `https://slack.com/api/${method}?${new URLSearchParams(params)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      },
    );
    const json = (await res.json()) as Record<string, unknown>;
    log.trace("api", { method, ok: json.ok === true, status: res.status });
    if (!json.ok)
      throw new Error(`slack ${method}: ${String(json.error ?? res.status)}`);
    return json;
  };
}

export interface SlackMessage {
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
  permalink?: string;
  channel?: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean };
}

interface SlackConversation {
  id: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  user?: string;
  priority?: number;
}

export interface SlackPollInput {
  api: SlackApi;
  cursor: SlackCursor;
  watchChannels: string[];
  // Threads aug tracks (open slack tasks), as "channel:thread_ts".
  trackedThreads: string[];
  // How far back a first look reaches.
  firstLookSeconds: number;
  maxDms: number;
}

export async function pollSlack(
  input: SlackPollInput,
): Promise<SlackPollResult> {
  const { api } = input;
  const cursor: SlackCursor = {
    channels: { ...input.cursor.channels },
    threads: { ...input.cursor.threads },
    searchedAt: input.cursor.searchedAt,
  };
  const auth = await api("auth.test", {});
  const me = String(auth.user_id);
  const team = String(auth.url ?? "").replace(/\/$/, "");
  const names = new Map<string, string>();
  const nameOf = async (id: string | undefined): Promise<string> => {
    if (!id) return "someone";
    const known = names.get(id);
    if (known) return known;
    try {
      const info = (await api("users.info", { user: id })) as {
        user?: { real_name?: string; name?: string };
      };
      const name = info.user?.real_name || info.user?.name || id;
      names.set(id, name);
      return name;
    } catch {
      return id;
    }
  };
  const firstLook = String(Date.now() / 1000 - input.firstLookSeconds);
  const out: NewMessage[] = [];

  const toMessage = async (
    msg: SlackMessage,
    channel: string,
    where: string,
    dm: boolean,
  ): Promise<NewMessage | null> => {
    if (msg.subtype && msg.subtype !== "thread_broadcast") return null;
    if (!msg.text?.trim()) return null;
    const authorName = await nameOf(msg.user);
    for (const id of msg.text.matchAll(/<@([UW][A-Z0-9]+)/g))
      await nameOf(id[1]);
    return rawToNewMessage({
      channel,
      where,
      dm,
      ts: msg.ts,
      threadTs: msg.thread_ts,
      author: msg.user ?? msg.bot_id ?? "unknown",
      authorName: msg.bot_id && !msg.user ? `${authorName} (bot)` : authorName,
      text: plainText(msg.text, names),
      url:
        msg.permalink ??
        (team
          ? `${team}/archives/${channel}/p${msg.ts.replace(".", "")}`
          : null),
      fromMe: msg.user === me,
    });
  };

  // Direct messages: the most active ones, every message.
  const convs = (await api("users.conversations", {
    types: "im,mpim",
    limit: "200",
    exclude_archived: "true",
  })) as {
    channels?: SlackConversation[];
  };
  const dms = [...(convs.channels ?? [])]
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))
    .slice(0, input.maxDms);
  const watched = input.watchChannels.map(
    (id) => ({ id, is_im: false }) as SlackConversation,
  );

  for (const conv of [...dms, ...watched]) {
    const dm = Boolean(conv.is_im || conv.is_mpim);
    const oldest = cursor.channels[conv.id] ?? firstLook;
    let history: { messages?: SlackMessage[] };
    try {
      history = (await api("conversations.history", {
        channel: conv.id,
        oldest,
        limit: "50",
      })) as typeof history;
    } catch (err) {
      log.warn("history skipped", { channel: conv.id, err });
      continue;
    }
    const msgs = [...(history.messages ?? [])].reverse();
    const where = dm
      ? conv.is_im
        ? `DM with ${await nameOf(conv.user)}`
        : `group DM`
      : `#${conv.name ?? conv.id}`;
    for (const msg of msgs) {
      const m = await toMessage(msg, conv.id, where, dm);
      if (m) out.push(m);
      if (!cursor.channels[conv.id] || msg.ts > cursor.channels[conv.id])
        cursor.channels[conv.id] = msg.ts;
    }
    if (!cursor.channels[conv.id])
      cursor.channels[conv.id] = String(Date.now() / 1000);
  }

  // Mentions anywhere (needs search:read; skipped quietly without it).
  try {
    const found = (await api("search.messages", {
      query: `<@${me}>`,
      sort: "timestamp",
      count: "30",
    })) as {
      messages?: { matches?: SlackMessage[] };
    };
    const after = cursor.searchedAt ?? firstLook;
    for (const match of [...(found.messages?.matches ?? [])].reverse()) {
      if (match.ts <= after || !match.channel?.id) continue;
      const dm = Boolean(match.channel.is_im || match.channel.is_mpim);
      if (dm) continue;
      const m = await toMessage(
        match,
        match.channel.id,
        `#${match.channel.name ?? match.channel.id}`,
        false,
      );
      if (m) out.push(m);
      if (!cursor.searchedAt || match.ts > cursor.searchedAt)
        cursor.searchedAt = match.ts;
    }
    cursor.searchedAt ??= String(Date.now() / 1000);
  } catch (err) {
    // no search scope
    log.debug("mention search skipped", { err });
  }

  // New replies on threads aug tracks.
  for (const tracked of input.trackedThreads) {
    const [channel, threadTs] = tracked.split(":");
    if (!channel || !threadTs) continue;
    const key = `slack:${channel}:${threadTs}`;
    const oldest = cursor.threads[key] ?? threadTs;
    try {
      const replies = (await api("conversations.replies", {
        channel,
        ts: threadTs,
        oldest,
        limit: "50",
      })) as {
        messages?: SlackMessage[];
      };
      for (const msg of replies.messages ?? []) {
        if (msg.ts <= oldest) continue;
        const m = await toMessage(
          { ...msg, thread_ts: threadTs },
          channel,
          "thread",
          false,
        );
        if (m) out.push(m);
        if (!cursor.threads[key] || msg.ts > cursor.threads[key])
          cursor.threads[key] = msg.ts;
      }
    } catch (err) {
      log.warn("thread skipped", { thread: tracked, err });
      continue;
    }
  }

  return { messages: out, cursor };
}

export async function slackPost(
  token: string,
  action: SlackReply,
): Promise<string> {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: action.channel,
      text: action.text,
      thread_ts: action.thread_ts,
    }),
  });
  const json = (await res.json()) as { ok: boolean; error?: string };
  if (!json.ok) throw new Error(`Slack refused: ${json.error ?? res.status}`);
  return `posted to Slack${action.to ? ` for ${action.to}` : ""}`;
}

export class TokenTransport implements SlackTransport {
  readonly kind = "token" as const;

  constructor(private token: string | undefined) {}

  available(): { ok: boolean; detail: string } {
    return this.token
      ? { ok: true, detail: "user token" }
      : {
          ok: false,
          detail: "no SLACK_TOKEN (or set slack.transport to claude-mcp)",
        };
  }

  poll(ctx: PollContext): Promise<SlackPollResult> {
    if (!this.token) throw new Error("no Slack token");
    return pollSlack({ ...ctx, api: slackApi(this.token), maxDms: 25 });
  }

  send(action: SlackReply): Promise<string> {
    if (!this.token) {
      throw new Error(
        "no Slack token (set SLACK_TOKEN or slack.token in config)",
      );
    }
    return slackPost(this.token, action);
  }

  stop(): void {}
}
