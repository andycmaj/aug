# aug

Your work manager in a terminal. GitHub and Slack become tasks, Claude does the
work, and nothing goes out until you approve it.

aug is a TUI clone of [Taskuary](https://taskuary.com/) ([source](https://github.com/ldbumble/taskuary))
built on [`@andycmaj/opentui-app`](https://github.com/andycmaj/opentui-app),
in the visual style of [tilt-tui](https://github.com/andycmaj/tilt-tui). It
covers Taskuary's **Chat** and **Board** views with **GitHub** and **Slack** as
the only connections. Game mode, reports, dashboards, the browser hand-over and
the other connectors are out of scope.

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
and [`gh`](https://cli.github.com/) (logged in).

```sh
export SLACK_TOKEN=xoxp-...   # optional: a Slack *user* token
bun dev                       # or: bin/aug
```

- **GitHub** uses your `gh` login. The inbox is your participating
  notifications: review requests, mentions, assignments, and comments on threads
  you are part of. aug never marks a notification read.
- **Slack** has three transports, set with `slack.transport`:
  - **`token`** (default) uses a Slack *user* token in `SLACK_TOKEN`, so
    replies go back as you. Scopes:
    `im:read mpim:read im:history mpim:history channels:history groups:history users:read chat:write`,
    plus `search:read` for mentions outside DMs.
  - **`claude-mcp`** is for when you have no token. aug runs a long-lived
    `claude -p` with a Slack MCP, such as the Slack connector added on
    claude.ai, and asks it each poll for new messages as JSON.
    - That reading session gets the Slack *read* tools only. Every write tool is
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

### Config

`~/.aug/config.json`. Every key is optional:

```json
{
  "github": {
    "pollSeconds": 120,
    "mergeMethod": "squash",
    "repos": { "northwind/ledger": "/Users/me/src/ledger" }
  },
  "slack": { "transport": "token", "pollSeconds": 60, "channels": ["C0123ABC"] },
  "brain": { "triageModel": "haiku", "agentModel": "sonnet", "assistantModel": "sonnet", "slackModel": "haiku" },
  "opener": "open",
  "agentsAtOnce": 4,
  "autostart": true,
  "learning": true,
  "theme": "default",
  "log": { "enabled": false, "level": "info" }
}
```

`github.repos` maps a repository to its local checkout, which is where a coding
agent works. `slack.channels` are channels where every message is triaged.
Anywhere else, only DMs and mentions of you are triaged. `opener` opens links
and files the agent made: a command or an argv array, with the target appended.
It defaults to `open` on macOS, `wslview` on WSL and `xdg-open` on Linux.

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
  live. It answers in three sections (*What this is about*, *What I did*,
  *Next steps*), and when a reply is owed it sets one up for you to send. Its
  tools are read-only look-ups plus writes in its own scratch folder; anything
  else is denied without asking. Files it writes there show under **What it
  made**: markdown rendered, CSV/TSV as a small table, anything else listed.
- **A coding task runs interactive Claude Code in a terminal embedded on the
  table**, in the repository's checkout. Hooks passed with `--settings`
  (`aug-tools hook ...`) move it through the agent states. Its brief tells it
  to finish with `aug-tools done`, leave handoff notes, and use the Hub.
- **Nothing sends itself.** A draft (a Slack reply, or a GitHub comment with
  merge, close or approve riding along) goes out only on `y` plus a confirm.
  Sending never closes a task. Mark done (`d`) does.
- **Correcting it teaches it.** *Not a task*, a changed kind or priority, an
  edited draft and a redraft are each recorded. A small model call turns each
  one into a line in `LEARNED.md`. New lines start at strength 2 under
  *Watching*, where nothing reads them, and move into use at strength 4.
- **The Advisor** reads your open work every few hours and leaves at most three
  ideas on the rail. It also marks a thread *slipped* when it has waited on
  someone for too long.
- **The Assistant** (`a`) answers about the item on the table and moves things
  when you ask: done, remind, watch, start, redraft, not a task, priority,
  remember. It never sends.

## Keys

| Where           | Keys                                                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anywhere        | `n`/`b` walk next/back · `a` ask · `v` Chat/Board · `N` new · `D` docs · `C` connections · `^r` check now · `:` palette · `?` help · `Tab` pane · `q` quit                                     |
| Rail            | `j`/`k` move the cursor · `enter` put the row on the table. Moves act on the row under the cursor. |
| Rail and table  | `y` send (asks first) · `e` edit draft in `$EDITOR` · `E` redraft · `s` start/continue agent · `S` stop and save · `d` done · `r` remind me · `w` watch · `x` not a task / read · `m` make it a task · `p` priority · `t` kind · `W` waiting on someone · `o` open the link or a file the agent made · `O` edit a made file in `$EDITOR` · `i` type · `I` info (everything aug knows about the row; `c` copies a value) |
| Chat box        | `enter` send to the agent · `esc` leave                                                                                                                                                       |
| Agent terminal  | everything goes to the agent · `^]` detach                                                                                                                                                    |
| Board           | `1`–`4` Columns / Wall / Live handoffs / Hub · `h j k l` move · `enter` open or attach · `c` write a note or Hub entry · `L` tiles across                                                       |

## What changed for a terminal

These Taskuary features were rethought for a TUI:

| Taskuary (web)                                    | aug (TUI)                                                                                         |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Chat / Board / Game switch                        | `v` toggles Chat and Board. Game is not built.                                                    |
| One-press **Send** button                         | `y` opens a confirm that shows the exact words; a stray key never sends.                         |
| Draft edited in place                             | `e` opens the draft in `$EDITOR` inside an embedded terminal. Saving updates it and teaches voice. |
| Live terminal on the task page and on the Wall    | Embedded PTY ([ghostty-opentui](https://www.npmjs.com/package/ghostty-opentui)): attach by focusing it, `^]` to detach. |
| Docs page with an editor                          | `D` picks a doc, which opens in `$EDITOR`.                                                         |
| Rail click opens the task                         | Same as Taskuary: the cursor moves freely, `enter` puts the row on the table (marked `▸`), `n`/`b` walk the table. |
| Chat pill in the corner                           | `a` opens the Assistant as a modal. Its conversation survives the view switch.                      |
| File previews (workbooks, images)                 | **What it made** renders markdown and CSV/TSV inline. `o` opens any file with your opener (`open`, `wslview`, ...), and `O` opens it in `$EDITOR`. No Slack attachments yet. |
| Browser hand-over, voice, attachments             | Not built.                                                                                         |
| Morning digest, reports, dashboards, routines     | Not built.                                                                                         |

## Develop

```sh
bun run typecheck
bun test            # core logic: triage gates, rail, lanes, agents, hooks, learning, ingest
bun run demo        # drive in tmux: tmux new -d -s aug 'bun run demo'; tmux capture-pane -p -t aug
```

See [AGENTS.md](AGENTS.md) for the layout and conventions.
