// Slack through the Web API with a user token, so replies go back as you and
// the inbox is yours: direct messages, mentions of you, the configured
// channels, and new replies on threads Riker already tracks.

import { mapLimit } from "@riker/core/concurrent";
import { logger } from "@riker/core/log";
import type { NewMessage } from "@riker/core/store";
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

// The same, as a JSON POST: for a write whose text is too long for a URL.
export function slackPostApi(token: string): SlackApi {
  return async (method, params) => {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(params),
    });
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

// Who the token is and the names it has looked up: the same from one poll
// to the next, so a transport keeps them instead of asking every time.
export interface SlackWho {
  me: string;
  team: string;
}

export interface SlackPollInput {
  api: SlackApi;
  cursor: SlackCursor;
  watchChannels: string[];
  // Threads Riker tracks (open slack tasks), as "channel:thread_ts".
  trackedThreads: string[];
  // How far back a first look reaches.
  firstLookSeconds: number;
  maxDms: number;
  who?: SlackWho;
  names?: Map<string, string>;
}

// History and reply reads in flight at once: a quiet poll is one read per
// conversation, and in a row 25 DMs took seconds. A few at a time stays well
// inside Slack's per-method limits.
const READ_CONCURRENCY = 6;

export async function whoAmI(api: SlackApi): Promise<SlackWho> {
  const auth = await api("auth.test", {});
  return {
    me: String(auth.user_id),
    team: String(auth.url ?? "").replace(/\/$/, ""),
  };
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
  const { me, team } = input.who ?? (await whoAmI(api));
  const names = input.names ?? new Map<string, string>();
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
      mentionsMe: msg.text.includes(`<@${me}>`),
    });
  };

  // The conversation list and the mention search do not depend on each
  // other, nor do the history and reply reads after them: they all go out
  // at once, a few at a time. What they found is then read in the order the
  // calls used to run, so messages and cursors come out the same.
  const conversations = async () => {
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
    return mapLimit([...dms, ...watched], READ_CONCURRENCY, async (conv) => {
      try {
        const history = (await api("conversations.history", {
          channel: conv.id,
          oldest: cursor.channels[conv.id] ?? firstLook,
          limit: "50",
        })) as { messages?: SlackMessage[] };
        return { conv, messages: history.messages ?? [] };
      } catch (err) {
        log.warn("history skipped", { channel: conv.id, err });
        return null;
      }
    });
  };

  // Mentions anywhere (needs search:read; skipped quietly without it).
  const mentions = async (): Promise<SlackMessage[] | null> => {
    try {
      const found = (await api("search.messages", {
        query: `<@${me}>`,
        sort: "timestamp",
        count: "30",
      })) as {
        messages?: { matches?: SlackMessage[] };
      };
      return found.messages?.matches ?? [];
    } catch (err) {
      // no search scope
      log.debug("mention search skipped", { err });
      return null;
    }
  };

  // New replies on threads Riker tracks.
  const threads = () =>
    mapLimit(input.trackedThreads, READ_CONCURRENCY, async (tracked) => {
      const [channel, threadTs] = tracked.split(":");
      if (!channel || !threadTs) return null;
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
        return { channel, threadTs, key, oldest, messages: replies.messages ?? [] };
      } catch (err) {
        log.warn("thread skipped", { thread: tracked, err });
        return null;
      }
    });

  const [histories, matches, replies] = await Promise.all([
    conversations(),
    mentions(),
    threads(),
  ]);

  for (const read of histories) {
    if (!read) continue;
    const { conv } = read;
    const dm = Boolean(conv.is_im || conv.is_mpim);
    const msgs = [...read.messages].reverse();
    // A quiet DM needs no name: looking it up was a call per DM per poll.
    const where = !msgs.length
      ? ""
      : dm
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

  if (matches) {
    const after = cursor.searchedAt ?? firstLook;
    for (const match of [...matches].reverse()) {
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
  }

  for (const read of replies) {
    if (!read) continue;
    const { channel, threadTs, key, oldest } = read;
    for (const msg of read.messages) {
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

  private who: SlackWho | null = null;
  // Names looked up so far, kept across polls: each was a users.info call.
  private names = new Map<string, string>();

  constructor(
    private token: string | undefined,
    private api: SlackApi | null = null,
  ) {}

  available(): { ok: boolean; detail: string } {
    return this.token
      ? { ok: true, detail: "user token" }
      : {
          ok: false,
          detail: "no SLACK_TOKEN (or set slack.transport to claude-mcp)",
        };
  }

  async poll(ctx: PollContext): Promise<SlackPollResult> {
    if (!this.token) throw new Error("no Slack token");
    const api = (this.api ??= slackApi(this.token));
    this.who ??= await whoAmI(api);
    return pollSlack({ ...ctx, api, maxDms: 25, who: this.who, names: this.names });
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
