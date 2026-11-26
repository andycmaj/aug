// What a message's `meta` column holds, by channel: the coordinates an
// outbound reply and the triage gates need. Parsed here, once, instead of
// at each reader with a shape of its own.

import type { MessageRow } from "./types";

export interface GithubMeta {
  channel: "github";
  repo: string | null;
  number: number | null;
  // Issue, PullRequest, ...
  type: string | null;
  // Why the notification came: mention, review_requested, ci_activity, ...
  reason: string | null;
  // The PR's head branch, when it was worth a call to fetch.
  head: string | null;
  // A review request: who the PR still asks, read when it arrived. Null
  // when it was not read (another reason, or the call failed).
  requested: ReviewRequested | null;
}

export interface ReviewRequested {
  me: boolean;
  // org/team-slug
  teams: string[];
}

export interface SlackMeta {
  channel: "slack";
  slackChannel: string | null;
  ts: string | null;
  thread_ts: string | null;
  dm: boolean;
  // The text mentions the owner.
  mention: boolean;
}

export interface OwnerMeta {
  channel: "owner";
}

export type MessageMeta = GithubMeta | SlackMeta | OwnerMeta;

const str = (v: unknown): string | null =>
  typeof v === "string" && v ? v : null;

function requestedOf(v: unknown): ReviewRequested | null {
  if (!v || typeof v !== "object") {
    return null;
  }
  const r = v as Record<string, unknown>;
  return {
    me: r.me === true,
    teams: Array.isArray(r.teams)
      ? r.teams.filter((t): t is string => typeof t === "string")
      : [],
  };
}

export function messageMeta(message: MessageRow): MessageMeta {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(message.meta) as Record<string, unknown>;
  } catch {
    // An unreadable meta reads as empty: the gates fall through.
  }
  switch (message.channel) {
    case "github":
      return {
        channel: "github",
        repo: str(raw.repo),
        number: typeof raw.number === "number" ? raw.number : null,
        type: str(raw.type),
        reason: str(raw.reason),
        head: str(raw.head),
        requested: requestedOf(raw.requested),
      };
    case "slack":
      return {
        channel: "slack",
        slackChannel: str(raw.channel),
        ts: str(raw.ts),
        thread_ts: str(raw.thread_ts),
        dm: Boolean(raw.dm),
        mention: Boolean(raw.mention),
      };
    default:
      return { channel: "owner" };
  }
}
