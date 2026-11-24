// The generator on a real GitHub repo, acting as a GitHub App installed on
// that repo only: the App is the PR author, so GitHub notifies the owner of
// its review requests, tags and replies as it would of a colleague's. Its
// key lives under RIKER_HOME/gen (0600) and never in a repo. Every call goes
// through `fetch`, which a test replaces.

import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { Ask, PrState, Verdict, type GenPr } from "./plan";
import type { Change, GenTarget, Opened } from "./target";

export interface GithubGenConfig {
  // owner/name of the lab repo.
  repo: string;
  appId: string;
  installationId: string;
  // The App's private key (.pem).
  keyPath: string;
  // The owner's login: whose review is asked, and whose reviews it answers.
  me: string;
  // org/slug of a team the owner is on, or null.
  team: string | null;
  // The branch PRs go into.
  base?: string;
}

// Its PRs' branches, so it never touches anyone else's.
export const GEN_BRANCH = "riker-gen/";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const API = "https://api.github.com";

function b64url(data: string | Buffer): string {
  return Buffer.from(data).toString("base64url");
}

// The App's own token: a JWT signed with its key, good for ten minutes.
export function appJwt(appId: string, key: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60;
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat, exp: iat + 540, iss: appId }));
  const sign = createSign("RSA-SHA256");
  sign.update(`${head}.${body}`);
  return `${head}.${body}.${b64url(sign.sign(key))}`;
}

interface GhPullRow {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged_at: string | null;
  updated_at: string;
  head: { ref: string; sha: string };
}

interface GhReviewRow {
  user: { login: string } | null;
  state: string;
  submitted_at: string | null;
}

export function githubTarget(
  config: GithubGenConfig,
  fetcher: Fetch = fetch,
  key: () => string = () => readFileSync(config.keyPath, "utf8"),
): GenTarget {
  const base = config.base ?? "main";
  let token: { value: string; until: number } | null = null;

  async function installationToken(): Promise<string> {
    if (token && token.until > Date.now() + 60_000) return token.value;
    const res = await fetcher(`${API}/app/installations/${config.installationId}/access_tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${appJwt(config.appId, key())}`, accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`the App's token: ${res.status} ${await res.text()}`);
    const got = (await res.json()) as { token: string; expires_at: string };
    token = { value: got.token, until: Date.parse(got.expires_at) };
    return got.token;
  }

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetcher(`${API}/repos/${config.repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await installationToken()}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return (res.status === 204 ? null : await res.json()) as T;
  }

  // A commit of `change` over `parent`, as one tree.
  async function commit(parent: string, change: Change, message: string): Promise<string> {
    const { tree } = await call<{ tree: { sha: string } }>("GET", `/git/commits/${parent}`);
    const entries = await Promise.all(
      change.files.map(async (f) => {
        if (f.content === null) return { path: f.path, mode: "100644", type: "blob", sha: null };
        const blob = await call<{ sha: string }>("POST", "/git/blobs", { content: f.content, encoding: "utf-8" });
        return { path: f.path, mode: "100644", type: "blob", sha: blob.sha };
      }),
    );
    const made = await call<{ sha: string }>("POST", "/git/trees", { base_tree: tree.sha, tree: entries });
    const c = await call<{ sha: string }>("POST", "/git/commits", { message, tree: made.sha, parents: [parent] });
    return c.sha;
  }

  async function ask(pr: number, who: Ask): Promise<void> {
    const slug = config.team?.split("/")[1];
    await call(
      "POST",
      `/pulls/${pr}/requested_reviewers`,
      who === Ask.team && slug ? { team_reviewers: [slug] } : { reviewers: [config.me] },
    );
  }

  const comment = (pr: number, body: string) => call("POST", `/issues/${pr}/comments`, { body });

  return {
    name: "github",
    hasTeam: Boolean(config.team),
    async list() {
      const pulls = await call<GhPullRow[]>("GET", "/pulls?state=all&sort=updated&direction=desc&per_page=50");
      const ours = pulls.filter((p) => p.head.ref.startsWith(GEN_BRANCH));
      return Promise.all(
        ours.map(async (p): Promise<GenPr> => {
          const open = p.state === "open";
          const reviews = open ? await call<GhReviewRow[]>("GET", `/pulls/${p.number}/reviews?per_page=100`) : [];
          const mine = reviews
            .filter((r) => r.user?.login.toLowerCase() === config.me.toLowerCase() && r.submitted_at && r.state !== "PENDING")
            .at(-1);
          const head = open
            ? await call<{ commit: { committer: { date: string } } }>("GET", `/commits/${p.head.sha}`)
            : null;
          return {
            number: p.number,
            url: p.html_url,
            state: p.merged_at ? PrState.merged : open ? PrState.open : PrState.closed,
            updatedAt: p.updated_at,
            pushedAt: head?.commit.committer.date ?? p.updated_at,
            mine: mine ? { verdict: mine.state as Verdict, at: mine.submitted_at! } : null,
            repliedAt: null,
          };
        }),
      );
    },
    async open(change, who): Promise<Opened> {
      const main = await call<{ object: { sha: string } }>("GET", `/git/ref/heads/${base}`);
      const sha = await commit(main.object.sha, change, change.title);
      const branch = `${GEN_BRANCH}${Date.now().toString(36)}`;
      await call("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha });
      const pr = await call<{ number: number; html_url: string }>("POST", "/pulls", {
        title: change.title,
        body: change.body,
        head: branch,
        base,
      });
      await ask(pr.number, who);
      return { number: pr.number, url: pr.html_url };
    },
    async followUp(pr, change, reply) {
      const p = await call<GhPullRow>("GET", `/pulls/${pr}`);
      const sha = await commit(p.head.sha, change, change.title);
      await call("PATCH", `/git/refs/heads/${p.head.ref}`, { sha });
      await comment(pr, reply);
      await ask(pr, Ask.me);
    },
    async reply(pr, body) {
      await comment(pr, body);
    },
    async tag(pr, body) {
      await comment(pr, body);
    },
    async rerequest(pr) {
      await ask(pr, Ask.me);
    },
    async merge(pr) {
      await call("PUT", `/pulls/${pr}/merge`, { merge_method: "squash" });
    },
    async close(pr) {
      const p = await call<GhPullRow>("PATCH", `/pulls/${pr}`, { state: "closed" });
      await call("DELETE", `/git/refs/heads/${p.head.ref}`);
    },
  };
}
