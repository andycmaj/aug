// GitHub as a plugin: its connector (notifications and PR status) and its
// way out (comments, approvals, merges). Core knows neither.

import type { RikerPlugin } from "@riker/core/plugins";
import { GithubConnector, type GithubOptions } from "./connector";
import { githubSend } from "./send";

export { GithubConnector, type GithubOptions };

export function githubPlugin(options: GithubOptions = {}): RikerPlugin & { connector: GithubConnector } {
  const connector = new GithubConnector(options);
  return {
    name: "github",
    connector,
    connectors: [connector],
    senders: { github_comment: githubSend },
  };
}
