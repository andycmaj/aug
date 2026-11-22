// GitHub's part of config.json, under "github". Where a repo is checked out
// is core's (repos), and whose review asks count is triage's
// (triage.reviewTeams).

import { configSection } from "@riker/core/config";

export interface GithubConfig {
  enabled: boolean;
  pollSeconds: number;
  // Merge method for "Approve and close" on a pull request.
  mergeMethod: "merge" | "squash" | "rebase";
}

export const githubConfig = configSection<GithubConfig>("github", {
  enabled: true,
  pollSeconds: 120,
  mergeMethod: "squash",
});
