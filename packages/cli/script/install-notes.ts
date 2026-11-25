#!/usr/bin/env bun
// The install lines at the top of every GitHub release's notes
// (.github/workflows/riker-release.yml). mise installs the binary straight
// from the release's assets.
//
//   bun run packages/cli/script/install-notes.ts <owner/repo>

export function installNotes(repo: string): string {
  return [
    "## Install",
    "",
    "Install and update `riker` with [mise](https://mise.jdx.dev):",
    "",
    "```sh",
    `mise use -g github:${repo}`,
    "```",
    "",
    `Re-run \`mise use -g github:${repo}\` later to upgrade to the newest release.`,
    "",
    "`riker --demo` runs a fictional day: no network, no AI, nothing sends. For real work Riker needs",
    "the `claude` and `gh` CLIs (logged in), tmux 3.3a or newer, and worktrunk (`wt`) for coding tasks.",
  ].join("\n");
}

if (import.meta.main) {
  const repo = process.argv[2];
  if (!repo) {
    console.error("usage: install-notes.ts <owner/repo>");
    process.exit(1);
  }
  console.log(installNotes(repo));
}
