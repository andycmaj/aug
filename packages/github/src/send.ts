// GitHub's way out: a drafted comment, an approval, a merge or a closed
// issue, through gh, sent only when the owner presses Send.

import type { RikerConfig } from "@riker/core/config";
import { SendError } from "@riker/core/outbound";
import type { GithubComment } from "./draft";

export async function gh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new SendError(err.trim() || `gh exited ${code}`);
  return out.trim();
}

export async function githubSend(
  action: GithubComment,
  config: RikerConfig,
): Promise<string> {
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
      await gh([
        "api",
        `repos/${action.repo}/issues/${action.number}/comments`,
        "-f",
        `body=${action.body}`,
      ]);
      const method = config.github.mergeMethod;
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
      await gh([
        "api",
        `repos/${action.repo}/issues/${action.number}/comments`,
        "-f",
        `body=${action.body}`,
      ]);
      return `commented on ${ref}`;
  }
}
