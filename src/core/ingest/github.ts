// GitHub through the `gh` CLI, so whatever auth gh has works here. The
// participating notifications feed is the inbox: review requests, mentions,
// assignments, and comments on threads you are part of. Read-only: aug never
// marks a notification read.

import type { NewMessage } from "../store";

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

export type GhApi = (path: string) => Promise<unknown>;

export async function ghApi(path: string): Promise<unknown> {
  const proc = Bun.spawn(["gh", "api", path], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0)
    throw new Error(err.trim() || `gh api ${path} exited ${code}`);
  return JSON.parse(out) as unknown;
}

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
    meta: { repo, number, type: n.subject.type, reason: n.reason },
  };
}

export async function pollGithub(
  sinceIso: string | null,
  api: GhApi = ghApi,
): Promise<NewMessage[]> {
  const me = ((await api("user")) as { login: string }).login;
  const query = new URLSearchParams({
    participating: "true",
    all: "false",
    per_page: "50",
  });
  if (sinceIso) query.set("since", sinceIso);
  const notifications = (await api(
    `notifications?${query}`,
  )) as GhNotification[];
  const out: NewMessage[] = [];
  // Oldest first so a thread's messages land in the order they were written.
  for (const n of [...notifications].reverse()) {
    let item: GhItem | null = null;
    const detail = n.subject.latest_comment_url ?? n.subject.url;
    if (detail) {
      try {
        item = (await api(
          detail.replace("https://api.github.com/", ""),
        )) as GhItem;
      } catch {
        item = null;
      }
    }
    const message = toMessage(n, item, me);
    if (message) out.push(message);
  }
  return out;
}
