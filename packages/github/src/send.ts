// GitHub's way out: a drafted comment, an approval, a merge or a closed
// issue, through gh, sent only when the owner presses Send.

import type { RikerConfig } from "@riker/core/config";
import { SendError } from "@riker/core/outbound";
import { githubConfig } from "./config";
import { errorMessage } from "@riker/core/log";
import type { GithubClient } from "./client";
import type { GithubComment } from "./draft";

// The owner pressed Send: it may spend the budget Riker keeps in reserve,
// never past a rate limit, which it names with its end instead.
export async function githubSend(
  client: GithubClient,
  action: GithubComment,
  config: RikerConfig,
): Promise<string> {
  try {
    return await sendVia(client, action, config);
  } catch (err) {
    if (err instanceof SendError) {
      throw err;
    }
    throw new SendError(errorMessage(err));
  }
}

async function sendVia(
  client: GithubClient,
  action: GithubComment,
  config: RikerConfig,
): Promise<string> {
  const owner = { owner: true };
  const gh = (args: string[]) => client.cli(args, owner);
  const comment = () =>
    client.api(
      `repos/${action.repo}/issues/${action.number}/comments`,
      { body: action.body },
      owner,
    );
  const ref = `${action.repo}#${action.number}`;
  switch (action.close) {
    case "approve":
      await gh([
        "pr",
        "review",
        String(action.number),
        "-R",
        action.repo,
        "--approve",
        "--body",
        action.body,
      ]);
      return `approved ${ref} with your comment`;
    case "merge": {
      await comment();
      const method = githubConfig.of(config).mergeMethod;
      await gh([
        "pr",
        "merge",
        String(action.number),
        "-R",
        action.repo,
        `--${method}`,
      ]);
      return `commented and merged ${ref}`;
    }
    case "issue":
      await gh([
        "issue",
        "close",
        String(action.number),
        "-R",
        action.repo,
        "--comment",
        action.body,
      ]);
      return `closed ${ref} with your comment`;
    default:
      await comment();
      return `commented on ${ref}`;
  }
}
