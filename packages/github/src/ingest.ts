// GitHub through the `gh` CLI, so whatever auth gh has works here. The
// participating notifications feed is the inbox: review requests, mentions,
// assignments, and comments on threads you are part of. Read-only: Riker never
// marks a notification read.

import { ghTrouble, GhTrouble } from "./gate";
import { mapLimit } from "@riker/core/concurrent";
import type { NewMessage } from "@riker/core/store";

// A detail that cannot be read is left out; a rate limit stops the poll,
// since every call after it fails too and spends what is left.
function unlessLimited(err: unknown): null {
  const message = err instanceof Error ? err.message : String(err);
  if (ghTrouble(message) === GhTrouble.rateLimit) throw err;
  return null;
}

export interface GhNotification {
  id: string;
  reason: string;
  updated_at: string;
  subject: {
    title: string;
    url: string | null;
    latest_comment_url: string | null;
    type: string;
  };
  repository: { full_name: string; html_url: string };
}

export interface GhItem {
  user?: { login: string } | null;
  body?: string | null;
  html_url?: string;
  created_at?: string;
  updated_at?: string;
  number?: number;
  state?: string;
}

// The pull request itself: its head, and who it still asks for a review.
export interface GhPull extends GhItem {
  head?: { ref?: string };
  requested_reviewers?: { login?: string }[];
  requested_teams?: { slug?: string }[];
}

// What a review request names, read off the PR: you, and the teams (as
// org/slug, a PR's teams being its repo owner's).
export function reviewRequested(
  pull: GhPull,
  repo: string,
  me: string,
): { me: boolean; teams: string[] } {
  const org = repo.split("/")[0] ?? "";
  return {
    me: (pull.requested_reviewers ?? []).some(
      (u) => u.login?.toLowerCase() === me.toLowerCase(),
    ),
    teams: (pull.requested_teams ?? [])
      .map((t) => t.slug)
      .filter((slug): slug is string => Boolean(slug))
      .map((slug) => `${org}/${slug}`),
  };
}

export type GhApi = (path: string) => Promise<unknown>;

export function numberFromUrl(url: string | null): number | null {
  const m = url?.match(/\/(\d+)$/);
  return m ? Number(m[1]) : null;
}

const REASON_WORDS: Record<string, string> = {
  review_requested: "review requested",
  mention: "mentioned you",
  team_mention: "mentioned your team",
  assign: "assigned you",
  author: "on your thread",
  comment: "commented",
  manual: "subscribed",
  state_change: "state changed",
  ci_activity: "CI activity",
  security_alert: "security alert",
};

export function toMessage(
  n: GhNotification,
  item: GhItem | null,
  me: string,
  head: string | null = null,
  requested: { me: boolean; teams: string[] } | null = null,
): NewMessage | null {
  const repo = n.repository.full_name;
  const number = numberFromUrl(n.subject.url);
  const kind =
    n.subject.type === "PullRequest"
      ? "PR"
      : n.subject.type === "Issue"
        ? "issue"
        : n.subject.type;
  const author = item?.user?.login ?? "github";
  const threadKey = number
    ? `github:${repo}#${number}`
    : `github:${repo}:${n.id}`;
  return {
    channel: "github",
    externalId: `gh:${n.id}:${n.updated_at}`,
    threadKey,
    author,
    authorName: author,
    title: `${repo}${number ? `#${number}` : ""} ${kind}: ${n.subject.title} (${REASON_WORDS[n.reason] ?? n.reason})`,
    body: (item?.body ?? "").trim() || n.subject.title,
    url: item?.html_url ?? n.repository.html_url,
    receivedAt: n.updated_at,
    fromMe: author.toLowerCase() === me.toLowerCase(),
    meta: {
      repo,
      number,
      type: n.subject.type,
      reason: n.reason,
      ...(head ? { head } : {}),
      ...(requested ? { requested } : {}),
    },
  };
}

// Who gh is logged in as: one call, which the connector keeps for the
// process rather than asking every poll.
export async function ghLogin(api: GhApi): Promise<string> {
  return ((await api("user")) as { login: string }).login;
}

// Detail reads in flight at once: a burst of notifications reads in a few
// round trips, well inside GitHub's limit on concurrent requests.
const DETAIL_CONCURRENCY = 4;

// A PR's head branch is one more call, so it is only fetched for repos where
// some task has a worktree branch a PR could come from.
export async function pollGithub(
  sinceIso: string | null,
  api: GhApi,
  wantsHead: (repo: string) => boolean = () => false,
  login?: string,
): Promise<NewMessage[]> {
  const me = login ?? (await ghLogin(api));
  const query = new URLSearchParams({
    participating: "true",
    all: "false",
    per_page: "50",
  });
  if (sinceIso) query.set("since", sinceIso);
  const notifications = (await api(
    `notifications?${query}`,
  )) as GhNotification[];
  // Oldest first so a thread's messages land in the order they were written.
  const messages = await mapLimit(
    [...notifications].reverse(),
    DETAIL_CONCURRENCY,
    (n) => notificationMessage(n, api, me, wantsHead),
  );
  return messages.filter((m): m is NewMessage => m !== null);
}

async function notificationMessage(
  n: GhNotification,
  api: GhApi,
  me: string,
  wantsHead: (repo: string) => boolean,
): Promise<NewMessage | null> {
  let item: GhItem | null = null;
  const detail = n.subject.latest_comment_url ?? n.subject.url;
  if (detail) {
    try {
      item = (await api(detail.replace("https://api.github.com/", ""))) as GhItem;
    } catch (err) {
      item = unlessLimited(err);
    }
  }
  // A PR is one more call: for its head where a task could own the
  // branch, and for who a review request asks. The detail already read
  // may be the PR itself.
  let head: string | null = null;
  let requested: { me: boolean; teams: string[] } | null = null;
  const review = n.reason === "review_requested";
  if (
    n.subject.type === "PullRequest" &&
    n.subject.url &&
    (review || wantsHead(n.repository.full_name))
  ) {
    try {
      const pull = (
        detail === n.subject.url && item
          ? item
          : await api(n.subject.url.replace("https://api.github.com/", ""))
      ) as GhPull;
      head = pull.head?.ref ?? null;
      if (review) requested = reviewRequested(pull, n.repository.full_name, me);
    } catch (err) {
      head = unlessLimited(err);
    }
  }
  return toMessage(n, item, me, head, requested);
}
