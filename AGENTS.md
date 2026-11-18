# Agents

## Architecture

A TUI clone of Taskuary's Chat and Board views, with GitHub and Slack as the
only connections. The app shell is
[`@andycmaj/opentui-app`](https://github.com/andycmaj/opentui-app) (boot,
focus, keymap, theme, toast, modals, palette, help). The structure mirrors
`tilt-tui` and `kube-tui`, and the embedded terminal is copied from
`kube-tui/src/terminal`.

- **`src/core/` is the domain, with no opentui/solid imports.** It holds the
  store (`bun:sqlite`, `~/.aug/aug.db`), triage, the agent pool, hooks,
  outbound, ingest, learning, the Assistant, the Advisor and the engine that
  ties them together. Unit-test it in `test/` with `freshHome()` and
  `fakeBrain()`.
- **The brain is `claude -p`** (`core/brain.ts`), swappable with `setBrain` for
  tests and fixtures. User settings are skipped (`--setting-sources ""`) so the
  user's hooks never leak into what triage reads back.
- **Coding agents run as interactive `claude` in tmux**, one window per task
  in its project's session (`core/projects.ts`), in a worktree made by `wt`.
  `core/agents.ts` builds the command line and the brief. The table embeds a
  grouped viewer session in a PTY. Hooks call `src/bin/aug-tools.ts`, which is
  plain TS and needs no Solid preload. Those hooks write to SQLite, and the TUI
  notices through `PRAGMA data_version`.
- **`core/mux.ts` is the only door to tmux and wt**, and the only importer of
  `libtmux` (alpha, pinned exactly). Identity is the `@aug_project` /
  `@aug_task` user options, never names. Tests use `test/fake-mux.ts`; real
  tmux checks use a private server (`-L`), never the default one.
- **Where a repo is checked out is `core/repos.ts`**: `github.repos` in
  config is the owner's one path per repo; `core/checkouts.ts` (behind the
  Mux) inspects a path and scans `repoRoots` for checkouts. Every coding
  start checks the path first, and `needs: path` carries what is wrong and
  what was found. Nothing is mapped unless the owner picks it.
- **A terminal program an agent opens (a diff viewer) splits its own
  window**: `aug-tools pane [--zoom] [--wait] -- cmd`, so it shows in the
  viewer instead of a window of its own. `tagWindow` also sets `@aug_tools`
  (how to call aug-tools) for scripts in that pane; `contrib/revdiff/` is
  revdiff's user-layer launcher that does this.
- **What aug writes outside its home is `core/install.ts`**: one registry
  (`hooks`, `statusline`, `revdiff`) of idempotent install, uninstall and
  state, behind `aug install|uninstall [name] [--check]`. The engine rewrites
  stale ones at start, but only those made for its own `AUG_HOME`. Scripts
  it writes are embedded (`with { type: "text" }`) so the compiled binary
  carries them. Setup a user would otherwise do by hand goes here.
- **A task's PR is `core/pr.ts`**: found from its linked threads (the PR
  its agent or branch opened), its URL, a PR thread it came from, or a PR
  link. The engine reads each one's checks and reviews into `pr_status` on
  the GitHub clock, 25 PRs to one GraphQL query; the rail and the table's
  header show it (marked stale when the last read failed), and `P` opens
  ghdash on it in the table (`components/use-pr-dash.tsx`).
- **When aug may call GitHub is `core/github-gate.ts`**: a rate limit
  pauses that budget (REST or GraphQL) until its reset, kept in `kv` across
  restarts; a failed poll backs off (doubling, jittered, capped); a PR that
  keeps failing backs off alone; under `GRAPHQL_RESERVE` points PR status
  waits for the reset. The engine's GitHub status line says each of these.
- **Claudes started outside aug are `core/strays.ts`**: found through Claude
  Code's own `~/.claude/sessions/<pid>.json` (pid, session id, cwd, tmux
  pane). The `adopt` move and `A` on the Board make one a coding task: one in
  tmux keeps running and its window moves into the project's session; one in
  a plain terminal is recorded as saved, so Start resumes it in a window.
- **Slack goes through a `SlackTransport`** (`core/slack/`): `token`,
  `claude-mcp` (a persistent `claude -p` whose session can only read, plus a
  one-shot send call), or `mcp` (a stub). claude.ai connectors load even with
  `--setting-sources ""`, but under `-p` they connect before the first request
  only with `MCP_CONNECTION_NONBLOCKING=false` (`brainEnv`), and a tool runs
  only if a granted capability names it (Knowledge #26, claude 2.1.322).
- **The Slack remote is `core/slack/remote.ts`** (`docs/slack-remote.md`):
  opt-in (`remote.enabled`), separate from the triage poller. It reads one
  conversation only the owner is in (self-DM or a private channel), hears
  the owner's own plain lines into Home (author `SLACK_AUTHOR`) and posts
  the Assistant's answer in the thread, marked `[aug]`. A turn answering
  Slack asks as `SLACK_ASKER`; `runMove` holds the moves in `CONFIRM_MOVES`
  for the owner's yes in that thread (`core/slack/confirm.ts`).
- **Views read through the read model** (`core/read-model.ts`), never the
  store: `aug.task(id)`, `aug.turns(id)`, `aug.pendingAction(id)` and the
  rest sit on the aug context. Each read names the tables it queries, and
  re-runs only when one of them changes: triggers bump a counter per table
  in `table_versions`, so a write from any process says what it touched. A
  new read is one entry in `reads()`; `test/read-model.test.ts` fails if its
  SQL touches a table it does not name. Pure row helpers (`taskRef`,
  `turnSteps`) are `core/rows.ts`.
- **The rail has a cursor and a table** (`cursorKey` and `selectedKey` in
  `context/aug.tsx`). Task actions (`components/task-actions.ts`, the key
  handlers on a row) act on the cursor row from the rail and on the table row
  from the table, and `select()` moves both.
- **The desk owns every owner move** (`core/desk.ts`): one method per thing
  the owner can do, over the store, the lifecycle and the task's driver.
  Components call `components/actions.tsx`, which asks the desk, opens
  dialogs and toasts the outcome; `use-agent-start`, `use-editor` and
  `use-viewer` beside it hold the start dialogs, $EDITOR and the embedded
  viewer. Nothing in `components/` imports `core/projects`. The engine
  (`core/engine.ts`) is what runs: pollers, timers, the moves drain and the
  tmux watch; it owns a desk. Triage returns effects and does not start
  agents itself.
- **Triage is a chain of rules** (`TRIAGE_RULES` in `core/triage.ts`): each
  returns `ok(outcome)` to claim a message or `pass(why)` to hand it on
  (`core/result.ts`), in the order listed, and `runChain` runs them. Gates
  come first; the rules after them read the model's verdict, asked at most
  once. Only a message `triage.escalate` names (the `escalation` rule)
  reaches `new task`; other work is held in the Inbox for the owner's `m`.
  A new rule is one entry in that list. Rules get config as a value
  (`TriageDeps`, from the engine per message). Noise patterns live in
  `config.triage.noise`; the `noise` move (the owner's and the Assistant's)
  appends one through the desk, and the next message reads it. Every run
  is recorded (`triage_runs`, one `triage_steps` row per rule tried, and
  a `project` step when a new task is filed under a project: its repo's
  one project, else the one the model named). A pull request review is
  coding, on the PR's repo and `pr:N`, with a guided Plannotator review as
  its brief: the `review ask` rule always makes one when a PR requests a
  review of, or tags, the owner or a team in `github.reviewTeams` (who was
  asked is read at ingest, a tagged team from the comment), and a review
  the model finds elsewhere becomes one too. An
  unmapped repo is said on the task, never guessed; Start asks.
- **The Inbox is the Board's tab 5** (`core/inbox.ts`,
  `components/inbox-tab.tsx`): every message triage saw and every Advisor
  idea, newest first, with the chain that routed it. Every inbox and
  triage action lives there; the rail holds tasks and projects only.
- **Config is handed down, never reached for** (`core/config.ts`). An entry
  point makes the `ConfigSource`: `index.tsx` a `fileConfig()` (config.json,
  re-read when its mtime changes), tests (`freshHome()`, `testConfig()`) and
  the fixture day a `fixedConfig()`. The engine gives it to its pool,
  drivers and desk, which call `get()` each time they use a setting, so an
  edit applies without a restart; functions below them take the `AugConfig`
  value, and components read `desk.config()`. Writes (`noise`, a repo
  mapped mid-start) are `update()` on the desk. `loadConfig()` is one read
  for an entry point that has no source (aug-tools' log and tmux server).
- **The agent lifecycle is `core/lifecycle.ts`.** Every change to a task's
  `agent_state` or a session's state is one of its named transitions
  (`sessionStarted`, `sessionActivity`, `sessionEnded`, `turnFinished`,
  `workFinished`, `taskClosed`, ...). Nothing else writes those columns.
- **What a rail row says is `docs/rail-status-design.md`**: four axes,
  the task's lifecycle (`status` plus a phase derived from `merged_at`,
  `pr_status` and `task_blockers`: `phaseOf`), the agent's state, rail
  grouping (`laneOf` in `core/lanes.ts`, whose order is the rule) and tags
  (priority, watching, Wins). A new lane gets a filter pill in
  `RAIL_FILTERS` or a place in `UNFILTERED_LANES`; `test/rail.test.ts`
  fails otherwise.
- **A task's agent is behind `core/driver.ts`.** `ChatDriver` (the pool's
  `claude -p` turns) and `TmuxDriver` (`projects.ts`) implement `start`,
  `stop`, `close`, `deliver`, `wake` and `isLive`; the desk picks one with
  `inTmux(task)` (coding, and the onboarding interview's System task) and
  nothing above the driver branches on it. What a coding
  start still needs comes back as `needs: repo | path | branch`.
- **Other processes ask for moves through `core/moves.ts`.** One registry
  (verb, args, help, run) feeds `aug-tools move <verb>`, the Assistant's
  prompt and the engine's dispatch, which runs each on the desk. aug-tools
  inserts a `moves` row and waits; the engine claims it on `data_version`,
  runs it, and writes one line back. A new verb goes in the registry, nowhere
  else. A move that would open a dialog answers `needs ...` in words instead.
  `AGENT_MOVES` is what a task's agent may ask for. "Move" means this bus; the
  owner's keys are task actions.
- **A project carries a brief, goals and docs** (`projects.brief`,
  `project_goals`, `project_links`; a task's `goal_id`). `lookup.projectContext`
  puts them in every brief of a task in the project, so a task's own brief
  need not repeat them; `core/project-doc.ts` is the one file the owner edits
  them in. A goal is met only by the owner's say, never by its tasks closing.
- **The brain docs are `core/docs.ts`** (files under `~/.aug/docs`, budgets,
  the trash, LEARNED.md's header and sections), kept at start by
  `core/doc-sync.ts` (the SOUL rename, notify-only shipped updates by one
  hash per doc in `kv`, the onboarding offer). Every aug edit to a doc the
  owner has not asked for is a proposal on a `kind: system` task
  (`core/proposals.ts`, `doc_proposals`): the Advisor's daily
  `core/doc-pass.ts`, the onboarding interview (`core/onboard.ts`, the
  `propose_doc` move) and shipped versions. Nothing merges; no history.
  The interview is interactive claude in its System task's own window
  (`inTmux` in `core/driver.ts`), shown in that task's canvas; it writes
  drafts to `drafts/docs` and hands them in with `propose_doc --file`.
- **Home is a `kind: home` task** (`store.homeTask()`), and its agent is the
  Assistant (`core/assistant.ts`): a resumed `claude -p` allowed only
  `aug-tools`. `listTasks()` never returns it, so nothing that lists work
  sees it.
- **What a headless agent may call is `core/capabilities.ts`.** Config
  grants each role (`general`, `assistant`) capabilities: connector tools
  (`slack.read`), commands (`Bash(<cmd>:*)`) or a Claude Code plugin, loaded
  with `--plugin-dir` and its hooks off. A skill's `allowed-tools` join the
  allow list once it runs, so a plugin whose skills ask for more than its
  capability grants is not loaded. Coding agents load the user's settings and
  have every enabled plugin already. Writes are dropped (`WRITE_VERB`) except
  `docs.write`'s own Claude Docs writes. A denied connector call gets a
  `grant:` step naming the config key (`grantHint`), and `connectorNote`
  tells every headless agent where grants live.
- **Logging is `core/log.ts`**: `logger(scope)` writes lines to `aug.log`
  under `AUG_HOME`, never to the terminal (the TUI owns it). It is off unless
  `AUG_LOG`, `log.enabled` in config, or `AUG_DEV` (set by `bun run dev`)
  turns it on. Log where an error is swallowed into a status line, and use
  `log.time()` for timings.
- **Perf counters are `core/perf.ts`**, on with the log (off again with
  `log.perf: false`): per-minute histograms per op plus the slowest examples
  past `log.slowMs` (default 50), in `perf.db` under `AUG_HOME` (its own
  file, so a flush never moves aug.db's `data_version`). `log.time()` feeds
  it; hot paths call `timing`/`measure`/`perfStart` directly (read-model
  reads, the TUI's refresh fan-out, engine ticks, every real `mux.*` call,
  frames). Names and numbers only, never content. `aug-tools perf` reports
  p50/p95/max per op.
- `src/keymap.ts` is the single binding table. Each mode (Chat, Board) has its
  own `FocusProvider`. `TerminalsProvider` sits above both, so PTYs survive the
  switch. A key that means different things by row (`x`, `e`) gets one
  command per meaning, each `relevant` to its rows and declining the others,
  so the footer names the one that applies; `test/keymap.test.ts` checks a key
  means one thing for any row. A view's own `KeyHints` use the footer's words.
- The footer and the `?` help (`components/focus-help.tsx`) show the same
  thing: the bindings reachable from the focused pane, through
  `helpBindings` in `keymap.ts` (relevant to `HelpCtx` first, then the first
  binding per key; only the `terminal` scope while one is attached). A
  binding that applies only sometimes says so with `relevant`, or both will
  list it where it does nothing. The Board's tab is `HelpCtx.board`.
- Keymap layers run before a focused `<input>`. Any handler reachable while the
  chat box has focus must decline (`unlessTyping`).
- A key listed in the `terminal` scope gets past an attached agent (the
  passthrough lets that scope's keys through): `ctrl+]` detaches, and the
  go-to chord (`ctrl+\`, `keys.goTo` in config) detaches and opens the
  search list. `buildKeymap` swaps config's navigation keys in at start.
- Navigation history is `core/nav-history.ts`, held by the aug context:
  every change of the table's row or the view is a visit (recorded once per
  handler, so a switch plus a select is one), `[`/`]` go back and forward,
  and the go-to list puts the recent rows first.
- A `Pane` is `flexShrink=0`, so a growing child (scrollbox, terminal host)
  needs `flexBasis={0}` or it pushes the footer off-screen.

## TypeScript

- Never use `any`. Node/Bun types only.
- Comments explain why, not what. No JSDoc.
- Enums as `const X = {...} as const`, never TS `enum`.
- Read Solid props lazily. Annotate `<Show>`/`<Match>` accessor children (they
  do not infer here).

## Testing the TUI

- One aug runs per `AUG_HOME` (`core/home-lock.ts`), so a worktree's
  `bin/aug` on the real home is refused while the owner's aug runs. Try a
  change with `bun run demo` or a scratch `AUG_HOME`.
- `bun run demo` runs the fixture day. Drive it in tmux with a unique session
  name and `tmux capture-pane -p`.
- `bun test` covers the core. Reproduce a bug in a test before fixing it.
- Real-mode checks cost tokens: use `haiku` in a scratch `AUG_HOME`.
