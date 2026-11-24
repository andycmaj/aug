// GitHub as a plugin: its connector (notifications and PR status) and its
// way out (comments, approvals, merges). Core knows neither.

import type { RikerPlugin } from "@riker/core/plugins";
import { GithubClient, type GhRun } from "./client";
import { GithubConnector, type GithubOptions } from "./connector";
import { githubConfig, type GithubConfig } from "./config";
import { githubComment, type GithubComment } from "./draft";
import { githubReviews, type GraphqlRun } from "./review-context";

export { GithubClient, GithubConnector, githubConfig, type GithubConfig, githubComment, type GithubComment, type GithubOptions };

// The Assistant's gh reads (core grants them on its shell: GH_READS).
const GITHUB_LINES = [
  "## GitHub",
  "Look up issues, PRs and runs with gh's read commands: gh pr view|list|diff|checks|status, gh issue view|list|status, gh search, gh run view|list, gh repo view. Nothing that writes (no comments, no gh api).",
];

export function githubPlugin(
  options: GithubOptions & { graphql?: GraphqlRun; run?: GhRun } = {},
): RikerPlugin & { connector: GithubConnector; client: GithubClient } {
  // One client, so one gate: the poll, a Send and the guide's reads all
  // wait out the same rate limit.
  const client = new GithubClient({ run: options.run, clock: options.clock });
  const connector = new GithubConnector(options, client);
  return {
    name: "github",
    connector,
    client,
    connectors: [connector],
    drafts: [githubComment(client)],
    config: [githubConfig],
    reviews: githubReviews(options.graphql ?? ((query, vars) => client.graphql(query, vars, { owner: true }))),
    assistant: () => GITHUB_LINES,
  };
}
