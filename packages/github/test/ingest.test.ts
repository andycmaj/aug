import { beforeEach, describe, expect, test } from "bun:test";
import { freshHome } from "@riker/core/test/support/helpers";
import { pollGithub, toMessage, type GhNotification } from "../src/ingest";

beforeEach(() => freshHome());

describe("notifications into messages", () => {
  test("a GitHub notification is one message on its issue's thread", () => {
    const m = toMessage(
      {
        id: "9",
        reason: "mention",
        updated_at: "2026-11-05T10:00:00Z",
        subject: {
          title: "Export drops transfers",
          url: "https://api.github.com/repos/a/b/issues/12",
          latest_comment_url: null,
          type: "Issue",
        },
        repository: { full_name: "a/b", html_url: "https://github.com/a/b" },
      },
      {
        user: { login: "erin" },
        body: "@me can you look?",
        html_url: "https://github.com/a/b/issues/12",
      },
      "me",
    )!;
    expect(m.threadKey).toBe("github:a/b#12");
    expect(m.title).toContain("mentioned you");
    expect(m.fromMe).toBe(false);
  });

  test("ingest fetches a PR's head only for repos with branch tasks", async () => {
    const n: GhNotification = {
      id: "1",
      reason: "comment",
      updated_at: "2026-11-07T10:00:00Z",
      subject: {
        title: "Keep transfers",
        url: "https://api.github.com/repos/acme/ledger/pulls/230",
        latest_comment_url: null,
        type: "PullRequest",
      },
      repository: { full_name: "acme/ledger", html_url: "https://github.com/acme/ledger" },
    };
    const calls: string[] = [];
    const api = async (path: string) => {
      calls.push(path);
      if (path === "user") return { login: "me" };
      if (path.startsWith("notifications")) return [n];
      return { user: { login: "erin" }, body: "LGTM?", head: { ref: "keep-transfers" } };
    };
    const without = await pollGithub(null, api);
    expect(without[0].meta?.head).toBeUndefined();
    const withHead = await pollGithub(null, api, (repo) => repo === "acme/ledger");
    expect(withHead[0].meta?.head).toBe("keep-transfers");
  });
});

describe("review requests at ingest", () => {
  test("who a review request asks is read off the PR, in the one call", async () => {
    const pullUrl = "https://api.github.com/repos/acme/ledger/pulls/231";
    const n: GhNotification = {
      id: "2",
      reason: "review_requested",
      updated_at: "2026-11-07T10:00:00Z",
      subject: { title: "Faster CSV", url: pullUrl, latest_comment_url: null, type: "PullRequest" },
      repository: { full_name: "acme/ledger", html_url: "https://github.com/acme/ledger" },
    };
    const calls: string[] = [];
    const api = async (path: string) => {
      calls.push(path);
      if (path === "user") return { login: "Me" };
      if (path.startsWith("notifications")) return [n];
      return {
        user: { login: "erin" },
        body: "please review",
        html_url: "https://github.com/acme/ledger/pull/231",
        head: { ref: "faster-csv" },
        requested_reviewers: [{ login: "me" }],
        requested_teams: [{ slug: "payments" }],
      };
    };
    const [m] = await pollGithub(null, api);
    expect(m.meta?.requested).toEqual({ me: true, teams: ["acme/payments"] });
    expect(calls.filter((c) => c.startsWith("repos/"))).toEqual(["repos/acme/ledger/pulls/231"]);
  });
});

describe("a burst of notifications", () => {
  test("details read a few at a time, and messages keep the oldest-first order", async () => {
    const notifications: GhNotification[] = Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      reason: "comment",
      updated_at: `2026-11-07T10:${String(59 - i).padStart(2, "0")}:00Z`,
      subject: {
        title: `issue ${i}`,
        url: `https://api.github.com/repos/acme/ledger/issues/${i}`,
        latest_comment_url: null,
        type: "Issue",
      },
      repository: { full_name: "acme/ledger", html_url: "https://github.com/acme/ledger" },
    }));
    let inFlight = 0;
    let most = 0;
    const calls: string[] = [];
    const api = async (path: string) => {
      calls.push(path.split("?")[0]!);
      if (path.startsWith("notifications")) return notifications;
      inFlight++;
      most = Math.max(most, inFlight);
      // Later issues answer first: order must come from the list, not the clock.
      await Bun.sleep(Number(path.split("/").pop()) % 3);
      inFlight--;
      return { user: { login: "erin" }, body: path };
    };
    const got = await pollGithub(null, api, () => false, "me");
    expect(calls.filter((c) => c === "user")).toEqual([]);
    expect(calls.filter((c) => c.startsWith("repos/"))).toHaveLength(12);
    expect(most).toBe(4);
    expect(got.map((m) => m.meta?.number)).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
  });
});
