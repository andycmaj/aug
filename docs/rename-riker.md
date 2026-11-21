# Rename aug to Riker

The owner first picked Squidmux (2026-11-13, AUG-0076; name checks in
Knowledge #13 and #14, topic `aug rename`), then settled on **Riker**
(AUG-0090). Phases 1 and 2 are done in code; Phase 3 is the owner's cutover.

## Names

Every name lives in `packages/core/src/brand.ts`, with the aug spellings in
`LEGACY`. Nothing else spells them inline.

| Thing | Before | After |
| --- | --- | --- |
| Brand, repo | aug, `andycmaj/aug` | Riker, `andycmaj/riker` |
| Command | `aug` (`dist/aug`) | `riker` (`dist/riker`); no short alias |
| Entry | `packages/cli/src/aug.ts` | `packages/cli/src/riker.ts` |
| Dev launch | `bun dev` (`AUG_DEV=1 packages/cli/script/aug.ts`) | `bun dev` (`RIKER_DEV=1 packages/cli/script/riker.ts`) |
| Agent tool | `aug-tools`, `packages/cli/src/aug-tools.ts` | `riker-tools`, `packages/cli/src/riker-tools.ts` |
| Packages | `@aug/core`, `@aug/tui`, ... | `@riker/core`, `@riker/tui`, ... |
| Home | `~/.aug` (`aug.db`, `aug.log`, `aug.pid`) | `~/.riker` (`riker.db`, `riker.log`, `riker.pid`) |
| Env vars | `AUG_HOME`, `AUG_TASK_ID`, `AUG_SESSION_ID`, `AUG_ASKED_BY`, `AUG_PROJECT`, `AUG_BRANCH`, `AUG_LOG`, `AUG_DEV`, `AUG_FIXTURE`, `AUG` | `RIKER_*`, same suffixes; `RIKER` |
| Task refs | `AUG-0076` | `RIKER-0076` (ids keep their numbers) |
| tmux options | `@aug_project`, `@aug_task`, `@aug_tools`, `@aug_client` | `@riker_*` |
| tmux viewer sessions | `aug-view-*`, `aug-placeholder` | `riker-view-*`, `riker-placeholder` |
| Claude entrypoint | `CLAUDE_CODE_ENTRYPOINT=aug` | `riker` |
| Task actions plugin | `aug:summarize`, ... | `riker:summarize`, ... |
| Stored values | `turns.author = 'aug'`, `sessions.started_by = 'aug'` | `riker` |
| Starship module | `[custom.aug_task]`, `# >>> aug statusline >>>` | `[custom.riker_task]`, `# >>> riker statusline >>>` |
| Install markers | ``# Installed by `aug install X` ``, `.before-aug`, `aug home …;` | `riker` spellings |
| Slack remote mark | `[aug]` | `[riker]` |
| Guide comment source | `aug-guide` | `riker-guide` |
| Local checkout | `~/workspace/andycmaj/aug` | `~/workspace/andycmaj/riker` |

The owner's project names (`aug-misc`, `aug-bugs`, `AUG-MISC`, ...) and their
tmux sessions stay as they are (owner, 2026-11-13).

## Why it needs a compatibility window

Things already running carry the old names and cannot be told about the new
ones:

- Every coding agent's brief and Bash allow rules name the aug-tools script
  and `aug-tools`, and its env has `AUG_TASK_ID` / `AUG_HOME`.
- Their tmux windows are tagged `@aug_task` / `@aug_project`; identity is
  those tags (`core/mux.ts`), so the engine would lose every live window.
- `~/.claude/settings.json` hooks run `sh ~/.aug/adopt-hook.sh`; starship
  runs `~/.aug/statusline.sh`; revdiff's launcher reads `@aug_tools`.
- `core/strays.ts` skips claudes whose entrypoint is `aug`; without that a
  live agent shows up as a stray to adopt.
- Old text keeps saying `AUG-0076`: notes, Knowledge, LEARNED.md, Slack, PR
  bodies, branch names.

So the new code reads both spellings until the cutover is over, and writes
only the new one.

## Phase 1: code rename (done)

- `brand.ts`: `NAME`, `CMD`, `TOOLS_NAME`, `HOME_DIR`, `ENV_PREFIX`,
  `ENV_FLAG`, `REF_PREFIX`, `OPTION_PREFIX`, `ENTRYPOINT`, `PLUGIN`, `SELF`,
  and `LEGACY`.
- `envVar(name)` reads `RIKER_<name>`, then `AUG_<name>`; every env read goes
  through it. Agents are started with only `RIKER_*`.
- Refs: `taskRef` prints `RIKER-0076`. `parseTaskRef` (`refNumber`),
  `mentions.ts` and `search.ts` accept `riker-`, `aug-` or a bare number,
  permanently.
- tmux: tags are written as `@riker_*` only; reads use
  `#{?@riker_x,#{@riker_x},#{@aug_x}}` (`optionFormat`), the hook guard and
  the revdiff launcher likewise. Viewer sessions named `aug-view-*` still count
  as viewers.
- `strays.ts`: our entrypoints are `riker` and `aug`.
- `install.ts` / `adopt.ts`: the aug markers, starship block and profile
  module, and a guard under `~/.aug` count as ours but stale, so `install`
  replaces them and `uninstall` removes them (restoring a `.before-aug`
  backup). `homeAliases()` says a home named `.riker` was the `.aug` beside it.
  The engine's refresh at start already rewrites stale ones, so the owner's
  hooks, statusline and revdiff launcher move over on first start.
- `toolsBin()` writes `bin/aug-tools` beside `bin/riker-tools`.
- A config action naming `aug:<skill>` runs `riker:<skill>` (`currentSkill`).
- The Slack remote treats an `[aug]` post as its own; the guide clears
  `aug-guide` comments as well as its own.
- `packages/cli/src/aug-tools.ts` is a shim that imports `riker-tools.ts`, so
  the path in running agents' briefs keeps working. (`src/bin/aug-tools.ts`,
  the path from before the monorepo split, went with AUG-0187.)
- `test/rename-compat.test.ts` has a test per legacy fallback.

## Phase 2: home migration (done, its own commit)

`core/migrate-home.ts`, run by `riker` at start before the home lock, and
`riker migrate --check` to show what it would do.

- Runs only for the default home: `RIKER_HOME` unset and `AUG_HOME` unset or
  `~/.aug`. A scratch `AUG_HOME` is used as the Riker home, untouched.
- Refuses while `~/.aug/aug.pid` is a live process (the old aug is running),
  or when `~/.riker` already exists; Riker then exits rather than start on an
  empty home. An agent's `AUG_HOME=~/.aug` names the default home.
- Until it has run, riker-tools refuses on the default home (a hook would
  otherwise make an empty `~/.riker` the move then refuses to overwrite).
- `~/.aug` moves to `~/.riker` (one `rename`, same filesystem). `aug.db*`,
  `aug.log` and `aug.pid` become `riker.*`. `~/.aug` is left as a symlink to
  `~/.riker`, so `~/.aug/bin/aug-tools`, `~/.aug/work/N` and old hook paths
  still resolve for running agents.
- DB, in one transaction: `turns.author`, `sessions.started_by`; repo slug
  `andycmaj/aug` to `andycmaj/riker` in `tasks.repo`, `projects.repos` and
  `pr_status.repo`; the slug at the start of `task_threads.thread_key` and
  `messages.thread_key` (`github:andycmaj/aug#10`, or the PR's thread would
  split once GitHub answers with the new name) and of PR URLs in `tasks.url`,
  `pr_status.url` and `task_links.url`. A slug that only starts the same
  (`andycmaj/aug-tools`) is left alone, and so is free text (titles, chat,
  notes, worktree paths).
- `config.json`: `github.repos` key renamed to `andycmaj/riker`; the path
  is left alone (Phase 3 moves the checkout).
- Live tmux windows: every session and window with `@aug_project` /
  `@aug_task` gets the `@riker_*` copies (`mux.copyLegacyTags`). Idempotent;
  the engine also does this at each start during the window.
- The owner's own docs in the home (PERSONA, JOB, STYLE, LEARNED, ...) are
  not rewritten: they are the owner's words, and old refs still parse.

Tested on a scratch home seeded with an aug layout, a DB and a private tmux
server (`-L`): `test/migrate-home.test.ts`.

## Phase 3: cutover on the owner's machine (runbook)

1. Merge Phase 1+2. Running agents can keep running.
2. Quit aug. In the checkout, pull main and `bun dev`: it migrates the home,
   re-tags the windows and refreshes the hooks, statusline and revdiff.
   (`bun packages/cli/src/riker.ts migrate --check` first, to see the plan.)
3. `riker install --check` shows all installed.
4. Rename the GitHub repo: `gh repo rename riker` (GitHub redirects the old
   URL, remotes and API calls), then `git remote set-url origin
   https://github.com/andycmaj/riker.git`. Do this right after step 2: the
   migration already calls the repo `andycmaj/riker`.
5. Move the checkout when no agent is mid-turn in the main checkout:
   `mv ~/workspace/andycmaj/aug ~/workspace/andycmaj/riker`, leave
   `~/workspace/andycmaj/aug` as a symlink to it, run `git worktree repair`
   from the new path, and set the path in `config.json` `github.repos`.
   Existing `aug.<branch>` worktrees stay where they are; new ones are
   `riker.<branch>`.
6. Claude Code keys its per-project history and memory by path: copy
   `~/.claude/projects/-Users-ac-workspace-andycmaj-aug/` to
   `-Users-ac-workspace-andycmaj-riker/` so memory and resumes follow the
   main checkout. Worktree folders need nothing; they did not move.
7. From then on, `bun dev` from `~/workspace/andycmaj/riker` (the old path
   still works through the symlink until Phase 4).

## Phase 4: drop the compat layer (later task)

When no open task's session started before the cutover (check `sessions`), and
after at least two weeks:

- Remove the `AUG_*` env fallback, `@aug_*` reads, the `aug` entrypoint check,
  `packages/cli/src/aug-tools.ts`, `~/.riker/bin/aug-tools`, the `~/.aug` and
  checkout symlinks, the legacy install markers, the `[aug]` mark, the
  `aug-guide` source and `currentSkill`: everything `LEGACY` in `brand.ts`
  feeds but the ref parsers.
- Keep `AUG-` in the ref parsers.

## Decided

- 2026-11-13: project names and their tmux sessions stay; the owner launches
  with `bun dev` from the checkout.
- AUG-0090: the name is Riker, command `riker` with no short alias.
