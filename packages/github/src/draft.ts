// GitHub's kind of draft: a comment on the issue or PR the task came from,
// with the close-out riding along (approve, merge, close the issue), sent
// through gh in the same press.

import { messageMeta } from "@riker/core/meta";
import type { DraftKind } from "@riker/core/plugins";
import type { GithubClient } from "./client";
import { githubSend } from "./send";

// A type, not an interface, so it fits core's open DraftAction.
export type GithubComment = {
  type: "github_comment";
  repo: string;
  number: number;
  body: string;
  // The close-out riding with the comment, done in the same press.
  close?: "issue" | "merge" | "approve";
};

// Sent through the plugin's client, so a Send waits out a rate limit with
// the rest of Riker's calls.
export const githubComment = (client: GithubClient): DraftKind<GithubComment> => ({
  type: "github_comment",
  build(message, answer) {
    const meta = messageMeta(message);
    if (meta.channel !== "github" || !meta.repo || !meta.number) return null;
    const isPr = meta.type === "PullRequest";
    const close =
      answer.kind === "close_issue" && !isPr
        ? ("issue" as const)
        : answer.kind === "merge_pr" && isPr
          ? ("merge" as const)
          : answer.kind === "approve_pr" && isPr
            ? ("approve" as const)
            : undefined;
    return { type: "github_comment", repo: meta.repo, number: meta.number, body: answer.text, close };
  },
  describe(action) {
    const what =
      action.close === "merge"
        ? "comment + merge"
        : action.close === "issue"
          ? "comment + close issue"
          : action.close === "approve"
            ? "approve with comment"
            : "comment";
    return `GitHub ${what} on ${action.repo}#${action.number}`;
  },
  text: (action) => action.body,
  withText: (action, body) => ({ ...action, body }),
  send: (action, config) => githubSend(client, action, config),
});
