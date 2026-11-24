// GitHub as a plugin: its connector (notifications and PR status) and its
// way out (comments, approvals, merges). Core knows neither.

import type { ReviewSource, RikerPlugin } from "@riker/core/plugins";
import { GithubConnector, type GithubOptions } from "./connector";
import { githubConfig, type GithubConfig } from "./config";
import { githubComment, type GithubComment } from "./draft";
import { githubReviews, type GraphqlRun } from "./review-context";

export { GithubConnector, githubConfig, type GithubConfig, githubComment, type GithubComment, type GithubOptions };

// The Assistant's gh reads (core grants them on its shell: GH_READS).
const GITHUB_LINES = [
  "## GitHub",
  "Look up issues, PRs and runs with gh's read commands: gh pr view|list|diff|checks|status, gh issue view|list|status, gh search, gh run view|list, gh repo view. Nothing that writes (no comments, no gh api).",
];

export function githubPlugin(
  // `reviews` stands in for the GitHub read (the sim's PRs are not there).
  options: GithubOptions & { graphql?: GraphqlRun; reviews?: ReviewSource } = {},
): RikerPlugin & { connector: GithubConnector } {
  const connector = new GithubConnector(options);
  return {
    name: "github",
    connector,
    connectors: [connector],
    drafts: [githubComment],
    config: [githubConfig],
    reviews: options.reviews ?? githubReviews(options.graphql),
    assistant: () => GITHUB_LINES,
  };
}
