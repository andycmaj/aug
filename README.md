# aug

Your work manager in a terminal. GitHub and Slack become tasks, Claude does the
work, and nothing goes out until you approve it.

## Try it

```sh
bun install
bun run demo        # a fictional morning: no network, no AI, nothing sends
```

The demo runs the real interface on seeded GitHub and Slack work. The brain
answers from canned lines, Send says it is the demo, and a coding agent is a
small fake that fires the same hooks real Claude Code does. Each run starts from
a fresh scratch home.

## Run it for real

Requirements: [bun](https://bun.sh), the [`claude`](https://docs.claude.com/en/docs/claude-code) CLI (logged in),
[`gh`](https://cli.github.com/) (logged in), [tmux](https://github.com/tmux/tmux)
3.3a or newer (3.7 for live updates), and [worktrunk](https://worktrunk.dev) (`wt`) for coding tasks.

```sh
export SLACK_TOKEN=xoxp-...   # optional: a Slack *user* token
bun dev                       # or: bin/aug
```

- **GitHub** uses your `gh` login. The inbox is your participating
  notifications: review requests, mentions, assignments, and comments on threads
  you are part of. aug never marks a notification read.
- **Slack** has three transports, set with `slack.transport`:
  - **`token`** (default) uses a Slack _user_ token in `SLACK_TOKEN`, so
    replies go back as you. Scopes:
    `im:read mpim:read im:history mpim:history channels:history groups:history users:read chat:write`,
    plus `search:read` for mentions outside DMs.
  - **`claude-mcp`** is for when you have no token. aug runs a long-lived
    `claude -p` with a Slack MCP, such as the Slack connector added on
    claude.ai, and asks it each poll for new messages as JSON.
    - That reading session gets the Slack _read_ tools only. Every write tool is
      denied, so text inside a message has nothing to post with.
    - Each Send is a separate one-shot call whose only tool is the send tool
      and whose only input is your approved words.
    - Every poll is a model turn (haiku by default, `brain.slackModel`), so it
      polls every 180s unless you set `slack.pollSeconds`.
    - `slack.mcpServer` picks the server when its name doesn't say "slack".
  - **`mcp`** (aug as a direct MCP client to a local Slack MCP server) is
    reserved and not built. Selecting it says so in the status line.

State lives in `~/.aug` (`AUG_HOME` overrides): `aug.db` (SQLite), `config.json`,
`docs/`, and each general agent's scratch folder under `work/`.

`docs/` is seeded from this repo's `docs/defaults/`; a file you've already
got is never overwritten. `docs/examples/` holds filled-in ones to copy from,
e.g. `cp docs/examples/JOB.md ~/.aug/docs/`.

### Config

`~/.aug/config.json`. Every key is optional:

```json
{
  "github": {
    "pollSeconds": 120,
    "mergeMethod": "squash",
    "repos": { "northwind/ledger": "/Users/me/src/ledger" }
  },
  "slack": {
    "transport": "token",
    "pollSeconds": 60,
    "channels": ["C0123ABC"]
  },
  "brain": {
    "triageModel": "haiku",
    "agentModel": "sonnet",
    "assistantModel": "sonnet",
    "slackModel": "haiku"
  },
  "opener": "open",
  "maxActiveAgents": 4,
  "worktreeCommand": "wt -C {repo_path} switch {create} {branch} --no-cd --format json -y",
  "autostart": true,
  "learning": true,
  "theme": "default",
  "log": { "enabled": false, "level": "info" },
  "capabilities": {
    "grants": { "general": ["slack.read", "docs.read", "notion.read"], "assistant": ["slack.read", "notion.read"] }
  }
}
```

`github.repos` maps a repository to its local checkout; a coding task gets a
worktree of it (aug asks for the path the first time a repo is unmapped).
`worktreeCommand` makes that worktree: `{repo_path}`, `{create}` (`-c` for a new
branch) and `{branch}` are filled in, and it must print wt's JSON or a path on
its last line. Swap in your own alias, or add `--no-hooks`. `tmuxSocket` puts
agents on a private tmux server (`-L`); unset means your default one. `slack.channels` are channels where every message is triaged.
Anywhere else, only DMs and mentions of you are triaged. `opener` opens links
and files the agent made: a command or an argv array, with the target appended.
It defaults to `open` on macOS, `wslview` on WSL and `xdg-open` on Linux.

### Capabilities

Agents and the Home assistant get no connector tools unless you grant them.
`capabilities.grants` lists, per role (`general` for agents, `assistant` for
Home), the capabilities that role may use:

- `slack.read`: read and search Slack through the claude.ai Slack connector
  (threads, channels, canvases, files, lists, profiles, search)
- `docs.read`: read, export and query Claude Docs
- `notion.read`: fetch and search Notion pages and read their comments, through
  the claude.ai Notion connector

Sessions run with `--permission-mode dontAsk`, so any tool that isn't granted is
denied without a prompt. There is no capability for sending, drafting,
scheduling, reacting, or creating, editing or moving pages. A send is only
ever your press. `capabilities.servers` (capability to MCP server name, e.g. `"slack.read": "slack"`) and
`capabilities.tools` (capability to bare tool names) override the built-in
mapping, for example to point at a different Slack server. These overrides
still fail closed: an unknown capability grants nothing, and a tool name that
looks like a write (send, post, update, delete, add, …) or isn't a plain name
(a glob, say) is dropped with a warning in the log. The mapping lives in
`src/core/capabilities.ts`.

### Logging

aug can write a file log to `~/.aug/aug.log`: connector status changes (Slack,
GitHub, the Advisor), errors, a trace of every model call, agent turns, sends,
and timings for polls and calls. It is off unless one of these turns it on,
first match wins:

- `AUG_LOG=trace|debug|info|warn|error` (or `on`, which means debug, or `off`)
- `"log": { "enabled": true, "level": "info" }` in config (`log.file` and
  `log.maxBytes` are optional)
- dev mode: `bun run dev` sets `AUG_DEV=1`, which logs at debug

The file rolls over to `aug.log.1` at 10 MB. Read it live with
`tail -f ~/.aug/aug.log`.

## How it works

The loop: something arrives, triage gives it a verdict, the verdict decides who
does the work, and whatever comes out waits for you.

- **Triage** runs gates first: dedupe, your own message, greetings, bots and CI
  noise, and threading (a GitHub issue or Slack thread attaches to its open
  task). Then one `claude -p --json-schema` call reads `TRIAGE.md`, `SOUL.md`,
  `JOB.md` and `LEARNED.md` and returns `fyi`, `reply`, `general`, `coding`,
  `task` or `watch`. If triage fails, the message is filed as FYI. It is never
  assumed to be work.
- **A general or reply task is one chat.** Each agent turn is a headless
  `claude -p` call, resumed by session id. Its tool steps stream onto the turn
  live. It answers in three sections (_What this is about_, _What I did_,
  _Next steps_), and when a reply is owed it sets one up for you to send. Its
  tools are read-only look-ups plus writes in its own scratch folder; anything
  else is denied without asking. Files it writes there show under **What it
  made**: markdown rendered, CSV/TSV as a small table, anything else listed.
- **A coding task runs interactive Claude Code in tmux**, in its own worktree,
  in a window of its project's session (see [Projects](#projects)). The table
  embeds a view of that window. Hooks passed with `--settings`
  (`aug-tools hook ...`) move it through the agent states. Its brief tells it
  to finish with `aug-tools done`, leave handoff notes, use Knowledge, link the
  PR it opens (`aug-tools pr`) and read what came back (`aug-tools feedback`).
- **Nothing sends itself.** A draft (a Slack reply, or a GitHub comment with
  merge, close or approve riding along) goes out only on `y` plus a confirm.
  Sending never closes a task. Mark done (`d`) does.
- **Correcting it teaches it.** _Not a task_, a changed kind or priority, an
  edited draft and a redraft are each recorded. A small model call turns each
  one into a line in `LEARNED.md`. New lines start at strength 2 under
  _Watching_, where nothing reads them, and move into use at strength 4.
- **The Advisor** reads your open work every few hours and leaves at most three
  ideas on the rail. It also marks a thread _slipped_ when it has waited on
  someone for too long.
- **Home is the Assistant**, first on the rail; `a` jumps there from anywhere.
  It is one long chat about all your work: `@` names a task or a project (it
  offers matches as you type), and the Assistant reads it before answering. It runs aug for
  you through `aug-tools`: it looks up tasks and projects, makes tasks
  (`move new`, a coding task in a named project with a brief), moves them,
  starts and stops agents, and archives projects after you confirm. It never
  sends.
- **Moves go through the engine.** `aug-tools move <verb>` writes the move to
  the `moves` table and waits. The running aug makes it and prints one line
  back, or why it could not ("no project X; projects: ..."). A task's own agent
  may make tasks (`--from` its task, which then hears about it) and edit its
  own task; starting, stopping and closing stay yours and the Assistant's.

## Projects

A project is one tmux session; each coding task in it is one window, one
worktree and one claude. tmux owns the claudes, so they outlive aug and you can
work with them from any tmux client.

- **Make or adopt.** Board tab `5` makes a project (`c`) or adopts a session you
  already have (`A`). aug tags the session with `@aug_project` and each window
  with `@aug_task`; names are only names, so rename freely. A coding task
  started outside a project gets a project of its own.
- **Start.** `s` asks for the branch (a new one, an existing one, or `pr:N`),
  runs `worktreeCommand`, and opens the window. Esc on the checkout question
  works in a scratch folder instead.
- **Watch and jump.** The table shows the window through a grouped tmux session
  of aug's own, so it never moves your real client. `T` moves your real client
  there; on the Board, `enter` on a project jumps to its session.
- **Finish.** `S` closes the window and keeps the worktree, so `s` resumes the
  same claude. `d` closes the window and runs `wt remove`; a dirty worktree is
  kept and aug says so. A project made for one task is archived when that task
  is done. `x` on the Board archives a project; `M` moves a task (its window
  moves with it).
- **On the rail.** Each active project is a row in Tasks with its tasks under
  it (open and working counts, repos); tasks in no project come after. `space`
  folds a project's tasks away (a folded row still shows what they ask of
  you) and unfolds them; Next skips folded tasks and project rows. `enter`
  puts a project on the table (its open tasks with their lanes). `T` jumps to
  its session, `x` archives it, `I` shows everything.
- **PRs.** A PR whose head branch is a task's branch belongs to that task, so
  its reviews and CI land there. `u` types one line into the agent's window
  telling it to run `aug-tools feedback`. Nothing else is pasted or sent.
- **Claudes you start by hand.** `aug install hooks` adds hooks to
  `~/.claude/settings.json` (backed up once to `settings.json.before-aug`).
  A small `sh` guard exits at once unless the claude is in a project's session
  and is not one aug started. Then its first prompt makes it a task in that
  project. `aug uninstall hooks` removes them.

### Setting up a machine

`aug install` sets up everything aug adds to your other tools, and is safe to
run again; `aug install <name>` does one, `aug install --check` says what is
in, and `aug uninstall [name]` takes it back out. Each touches only what it
marked as its own and moves anything of yours aside first.

- `hooks`: the hand-started claude hooks above.
- `statusline`: the task (`AUG-0059 <title>`, plus its priority) in Claude
  Code's status line. A `[custom.aug_task]` block in `starship.toml` (or
  `$STARSHIP_CONFIG`), put in front of your `claude-code` profile, runs
  `aug-tools statusline`. Claude's `statusLine` is set to
  `starship statusline claude-code` only when you have none. Needs starship.
- `revdiff`: the revdiff plugin's user-layer launcher, so a review an agent
  opens shows in a split of its own window in aug's viewer. Needs the plugin.

When aug starts it rewrites any of these that no longer match it (a moved
checkout, a new hook), and only ones installed for its own `AUG_HOME`.

### Env contract

Every command aug runs for a task (the worktree command, the tmux window, the
claude in it) gets these, so your own wt and tmux hooks can skip what aug
already does with `[ -n "$AUG" ] && exit 0`:

| Variable         | Value                               |
| ---------------- | ----------------------------------- |
| `AUG`            | `1`                                 |
| `AUG_HOME`       | aug's home directory                |
| `AUG_PROJECT`    | the project id                      |
| `AUG_TASK_ID`    | the task id                         |
| `AUG_BRANCH`     | the branch                          |
| `AUG_SESSION_ID` | the claude session id (claude only) |

If one of your hooks opens a tmux window for every new worktree, guard it with
`$AUG`, or aug-made worktrees get two windows.

## Keys

| Where          | Keys                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anywhere       | `n`/`b` walk next/back · `/` search the rail (words, `AUG-23`, `#412`, `@someone` in Slack or GitHub) · `a` Home (the Assistant) · `v` Chat/Board · `N` new · `D` docs · `C` connections · `^r` check now · `:` palette · `?` help · `Tab` pane · `q` quit                                                                                                                                                                                                                                                                                                                                      |
| Rail           | `j`/`k` move the cursor · `enter` put the row on the table · `space` on a project: fold / unfold its tasks. Moves act on the row under the cursor.                                                                                                                                                                                                                                                                                                                                                               |
| Rail and table | `y` send (asks first) · `e` edit draft in `$EDITOR` (before an agent starts: edit the brief) · `E` redraft · `s` start/continue agent · `S` stop and save · `d` done · `r` remind me · `w` watch · `x` not a task / read · `m` make it a task · `p` priority · `t` kind · `W` waiting on someone · `o` open the link or a file the agent made · `O` edit a made file in `$EDITOR` · `i` type · `I` info (everything aug knows about the row; `c` copies a value) · coding: `T` jump to its tmux window · `u` nudge about feedback · `M` move to a project |
| Chat box       | `enter` send to the agent · `@` name a task (`tab`/`enter` takes it, `↑`/`↓` pick) · `esc` leave                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Agent terminal | everything goes to the agent · `^]` detach                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Board          | `1`–`4` Columns / Live handoffs / Knowledge / Projects · `h j k l` move · `enter` open · `c` write a note or Knowledge entry (new project on tab 4) · `A` adopt a tmux session · `x` archive a project · `M` move a task                                                                                                                                                                                                                                                                                          |

## What changed for a terminal

These Taskuary features were rethought for a TUI:

| Taskuary (web)                                 | aug (TUI)                                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chat / Board / Game switch                     | `v` toggles Chat and Board. Game is not built.                                                                                                                                                         |
| One-press **Send** button                      | `y` opens a confirm that shows the exact words; a stray key never sends.                                                                                                                               |
| Draft edited in place                          | `e` opens the draft in `$EDITOR` inside an embedded terminal. Saving updates it and teaches voice.                                                                                                     |
| Live terminal on the task page                 | The agent runs in tmux; aug embeds a view of its window ([ghostty-opentui](https://www.npmjs.com/package/ghostty-opentui)): attach by focusing it, `^]` to detach, `T` to jump there in your own tmux. |
| Docs page with an editor                       | `D` picks a doc, which opens in `$EDITOR`.                                                                                                                                                             |
| Rail click opens the task                      | Same as Taskuary: the cursor moves freely, `enter` puts the row on the table (marked `▸`), `n`/`b` walk the table.                                                                                     |
| Chat pill in the corner                        | `a` opens the Assistant as a modal. Its conversation survives the view switch.                                                                                                                         |
| File previews (workbooks, images)              | **What it made** renders markdown and CSV/TSV inline. `o` opens any file with your opener (`open`, `wslview`, ...), and `O` opens it in `$EDITOR`. No Slack attachments yet.                           |
| Browser hand-over, voice, attachments          | Not built.                                                                                                                                                                                             |
| Morning digest, reports, dashboards, routines  | Not built.                                                                                                                                                                                             |

## Develop

```sh
bun run typecheck
bun test            # core logic: triage gates, rail, lanes, agents, hooks, learning, ingest
bun run demo        # drive in tmux: tmux new -d -s aug 'bun run demo'; tmux capture-pane -p -t aug
```

See [AGENTS.md](AGENTS.md) for the layout and conventions.

# Credit

aug is inspired by [Taskuary](https://taskuary.com/) ([source](https://github.com/ldbumble/taskuary))
and built on [`@andycmaj/opentui-app`](https://github.com/andycmaj/opentui-app).
