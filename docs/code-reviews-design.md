# Code reviews

There are two kinds of review: a **self-review** of my own work in
progress, and a **requested review** of someone else's PR. Both are the
same Plannotator guided review: the AI's findings are added as comments,
I read them, add my own, ask the AI questions in Plannotator's ask mode,
and submit. They differ only in where my submission goes.

Nothing about a review runs by itself, and nothing reaches anyone until
I press Submit or Post.

## Self-review

- On any coding task of mine with a worktree, I start the guide from the
  `.` picker or the palette. Nothing is offered or run when the agent
  finishes.
- Plannotator opens on the worktree against its base, with the AI's
  findings in it.
- What I submit goes to the task's agent. If its session is live, the
  comments are delivered. If it has ended, Riker resumes that session in
  its window with my comments as its first message.
- An Approve with no comments sends nothing: the task gets one line
  saying so.

## Requested reviews

**What counts as an ask:**

- GitHub requests a review from me, or from a team listed in
  `triage.reviewTeams`.
- Someone tags me, or such a team, on a PR.
- A Slack message that tags me directly and points at a PR. Other Slack
  talk about a PR repeats what GitHub already sent, and is not an ask.
- A request to a team not in that list goes to the Inbox as FYI.

**One task per PR**, whatever the source. A later ask (a Slack tag, the
GitHub request, a re-request) joins the task the first one made.

**How it shows:** under Code Reviews on the rail. Each row says how long
the ask has waited, oldest first. The task is coding, on the PR's repo
and `pr:N`. Nothing runs when it arrives.

**Starting a review is my choice:** I run the guide from the picker or
the palette. Riker makes a worktree on the PR's branch, with no agent.
The AI reads the diff, the PR's title and body, its existing review
threads (so it does not repeat them) and the bodies of linked GitHub
issues. A ticket outside GitHub is read only through a connector I have
granted; otherwise the guide names it as a link it did not read.
Plannotator opens in PR mode with the findings as comments.

**Asking and posting:** questions to the AI go through Plannotator's ask
mode, which keeps only the comments meant for the author. Post to GitHub,
in Plannotator, sends my review. Riker never posts.

**After I post:** Riker reads Plannotator's decision (`--json`). A posted
review closes the task as done and drops the worktree. Closing
Plannotator without posting leaves the task open. The task reopens when
the PR is waiting on me again: a re-request, the author answering my
comments, or new commits after I asked for changes. A re-review's guide
covers the commits since my last review; the whole PR is a second choice
in the picker.

## Review activity generator (dogfooding)

I rarely get review requests, so a generator plays the other side.

- It lives beside the sim (`packages/fixtures/src/gen/`), shares the
  sim's scenario event list, and runs with `--target sim|github`.
- The GitHub target is a private repo, `botany-sanjuans/riker-review-lab`,
  seeded from a snapshot of Riker. A GitHub App installed only on that
  repo is the PR author. The team `botany-sanjuans/riker-reviewers`, with
  me in it, is in `triage.reviewTeams`.
- PRs replay Riker's own commits. With `--plant`, haiku writes changes
  with planted bugs, so I can check whether the guide catches them.
- It acts as a full author: asks me or the team for a review, pushes a
  follow-up and re-requests after I ask for changes, replies to my
  comments, merges when I approve, and closes PRs nobody has touched for
  7 days. It touches only its own PRs.
- `bun run gen once ask|team|tag|rerequest|tick` runs on demand.
  `bun run gen start` runs the stream in the background (`gen stream` in
  the foreground): at most 5 open PRs, a new one at most every 30
  minutes, 09:00 to 18:00 local time, my reviews answered within five
  minutes. `gen stop` ends it. The App's key and config live in
  `~/.riker/gen/` (0600); `gen setup` lists the steps only I can do, and
  `gen check` tests them. Haiku's cost is recorded in `spend` under the
  role `gen`; `--plant` is for the GitHub target only, since the sim makes
  its diffs from its own commits.
- GitHub only for now; a Slack target can come later.
