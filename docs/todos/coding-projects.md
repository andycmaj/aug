# Projects: one tmux session per project, one claude per task

Status: designed (grilled 2026-11-07), in progress.

## Problem

My work is organised by project. Each project gets a tmux session, and inside
it each piece of work gets a worktree (made by worktrunk) and a claude. A
project is often a single PR, but a large one runs many PRs, sometimes across
several repos.

I'd like aug to track project tasks and use persistent agents in tmux
sessions for them, and I'd like to work with those sessions in my own tmux,
outside aug.

## Design

### Model

- **Project** is a new `projects` table: name, tmux session, `repos[]`
  (`owner/repo` keys, not paths), and status (`active`, `archived`). One
  project is one tmux session.
- **Task** gets a nullable `project_id`, plus `branch` and `worktree`. One task
  is one worktree, one tmux window and one claude session. A multi-PR or
  multi-repo project is several tasks, each with a worktree in its own repo. A
  task that has not started has no window.
- **Identity is tmux user options, never names.** The session carries
  `@aug_project <id>` and the window carries `@aug_task <id>`. Renaming either
  breaks nothing. Only tagged sessions are projects, so untagged ones
  (`home`, `revdiff`, ...) stay invisible to aug.

### Who owns what

- **tmux owns the claude process.** aug spawns it into a window of the
  project's session, so agents survive aug restarts and can be reached from
  any tmux client.
- **Chat embeds a grouped viewer session.** Two clients attached to one
  session share its current window, so aug attaches its own
  `aug-view-<project>` session grouped with the project (`status off`,
  `destroy-unattached on`, `prefix None`) and selects the task's window there.
  Your real client is never moved. A key jumps your real client to the window
  with `switch-client`.
- **All tmux and wt calls go through `core/mux.ts`.** It is built on
  [`libtmux`](https://github.com/libtmux/libtmux-ts), pinned to an exact
  version because the alpha API breaks between `0.1.N` releases. Only that
  file imports it, and tests use a fake. If libtmux misbehaves on macOS, only
  that file changes.

### Lifecycle

- **Creating a project.** Either "new project" (name and first repo), which
  creates and tags a session, or "adopt", which offers a picker over untagged
  live sessions. A new session is named after the project slug. If an
  untagged session already has that name, aug adds a suffix (`foo-2`) and
  never takes the existing one over.
- **Starting a task.**
  1. aug runs the worktree command template from config. The default is
     `wt -C {repo_path} switch {create} {branch} --no-cd --format json -y`,
     where `{create}` is `-c` for a new branch and empty for an existing one
     or `pr:{N}`.
  2. It reads the worktree path from the JSON on stdout. A custom alias or
     script works if it prints that JSON, or just a path on the last line.
  3. It runs `tmux new-window -t <session> -c <path>` with the env contract
     (below) and the existing coding command line and brief.
  - The default branch name is a slug of the task title, editable before
    start.
  - wt hooks run by default (pre-start installs deps before claude starts).
    Add `--no-hooks` to the template to mute them.
- **Repos on disk.** `config.github.repos` (`owner/repo` mapped to a checkout)
  gives `{repo_path}`. Starting a task in an unmapped repo asks for the path
  once and saves it. If you decline, or the task has no repo, the window opens
  in the scratch dir (today's `codingCwd` fallback) with no worktree.
- **Coding task with no project.** Inbound GitHub or Slack work gets a
  project-of-one when its agent starts. There is a single code path, and the
  old in-aug PTY launch for coding agents goes away. General (non-coding)
  agents are unchanged.
- **Moving a task** to another project re-parents it in the DB and runs
  `tmux move-window` into that session, so the window and its claude keep
  running. A project-of-one left empty is archived and its session killed.
- **Ending a task.** When the agent says it is done, the window stays, because
  you may still talk to it. When you close the task, aug kills the window and
  runs `wt remove`, which deletes the branch only if it is merged and refuses
  on a dirty tree (aug reports the refusal). When the last task closes, aug
  offers to kill the session and archive the project.
- **Restarts and drift.** `server.watch()` events (window closed, pane exited,
  window renamed) keep the DB in step live, and a slow poll catches what
  watch misses and runs at boot.
  - Window gone: the session is stopped.
  - Window alive but claude exited: the session is stopped and the shell is
    kept.
  - Resume opens a fresh window running `claude --resume <id>` in the same
    worktree.

### Hand-started claudes (adoption)

- When you run `wt switch -c foo && claude` inside a project's session, aug
  adopts it. If its window has no `@aug_task`, aug creates a task in that
  project (titled from the branch, then from the first prompt) with
  `started_by = owner` and tags the window.
- aug-launched claudes keep getting hooks through `--settings`. User-level
  hooks in `~/.claude/settings.json` exist only for adoption. Their command is
  a tiny `sh` guard that exits before any bun startup, so other claudes pay
  close to nothing. It exits:
  - if `AUG_TASK_ID` is set, to avoid double firing with `--settings`;
  - unless `$TMUX` is set and the current session has `@aug_project`.
- `aug hooks install|uninstall` manages them. aug offers it the first time you
  create or adopt a project and never writes them silently.
- `maxActiveAgents` (renamed from `agentsAtOnce`, with the old key still read)
  counts only aug-started claudes. Adopted ones never count and are never
  queued.

### Env contract

Every command aug spawns (the wt template, `tmux new-window`, claude) gets:

| Variable         | Value                         |
| ---------------- | ----------------------------- |
| `AUG`            | `1`                           |
| `AUG_HOME`       | aug's home dir                |
| `AUG_PROJECT`    | project id                    |
| `AUG_TASK_ID`    | task id                       |
| `AUG_BRANCH`     | branch                        |
| `AUG_SESSION_ID` | claude session id (claude only) |

Your own wt and tmux hooks test `[ -n "$AUG" ]` to skip what aug already
does. This contract is stable and documented in the README.

**Reminder:** remove or guard your own hooks that open tmux windows for new
worktrees, or aug-made worktrees will get two windows.

### PRs and feedback

- **Link (DB only).** The task stores `(repo, branch)`. GitHub ingest already
  sees each PR's head branch, so a matching PR, and later its reviews and CI,
  attaches to that task rather than making a new one. For odd cases,
  `aug-tools pr <url>` from inside the agent, or a key in aug, links one by
  hand.
- **Delivery to the agent.** `aug-tools feedback` prints the task's unread
  review comments and CI failures. If the window is alive, one press in aug
  sends a one-line nudge into it ("New review on #12, run
  `aug-tools feedback`"). Nothing is pasted or sent automatically.

### UI

- **Rail.** Rows never move, so there is no regrouping. Each task row gets a
  project chip, and a key cycles a project filter.
- **Board.** A new `Projects` tab shows one row per project with its tasks,
  worktrees and agent states. Keys: new, adopt, jump (`switch-client`) and
  close.
- **Chat.** A project task's canvas embeds the viewer session on the task's
  window.

### Tests and demo

- Core tests use the fake `Mux`.
- `bun run demo` and any test that needs real tmux use a private server
  (`tmux -L aug-demo`), never your default one. Real mode uses your default
  server.

## Build order

1. [x] Schema (`projects`, task `project_id`/`branch`/`worktree`), store,
   config (`maxActiveAgents`, `worktreeCommand`), types.
2. [x] `core/mux.ts`: the seam, a libtmux implementation and a fake.
3. [x] `core/projects.ts`: create, adopt, start task (worktree, window, env),
   close, move, reconcile. Engine wiring.
4. [x] Replace the in-aug PTY coding launch, and embed the viewer session in
   Chat. `shift+t` jumps your client to the window.
5. [x] Adoption hooks (`aug hooks install|uninstall|status`, the `sh` guard
   at `$AUG_HOME/adopt-hook.sh`), and auto tasks for hand-started claudes.
   `aug-tools done|note` work in an adopted window too (found by its tag).
   The offer to install on first create/adopt lands with the Projects tab.
6. PR link by branch, `aug-tools pr`, `aug-tools feedback`, the nudge.
7. Board `Projects` tab, rail chip and filter.
8. `watch()`-driven reconcile, README env contract.
