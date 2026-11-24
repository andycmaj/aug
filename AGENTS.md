# Agents

A terminal work manager with Chat and Board views, and GitHub and Slack as
the only connections. The app shell is
[`@andycmaj/opentui-app`](https://github.com/andycmaj/opentui-app) (boot,
focus, keymap, theme, toast, modals, palette, help). The structure mirrors
`tilt-tui` and `kube-tui`, and the embedded terminal is copied from
`kube-tui/src/terminal`.

## Packages

A bun workspace (`packages/*`, hoisted installs). A package imports another
by name, `@riker/core/store`, from its `src/` (each `exports` `"./*":
"./src/*.ts"`), never by relative path across packages; nothing is built.
One root `tsconfig.json` and one `bun test` cover them all. Dependencies run
one way: cli → tui → fixtures → {triage, github, slack} → core →
code-review-plannotator; the three plugins never import each other, and
`packages/core/test/boundaries.test.ts` fails on an import that goes the
other way (a new package gets a line in its `ALLOWED`).

- **`@riker/core`**: the domain (below: `core/x.ts` means
  `packages/core/src/x.ts`), its embedded text (`defaults/`, Riker's plugin
  `plugin/`, `contrib/revdiff/`) and the test helpers other packages' tests
  import (`@riker/core/test/support/helpers`: `freshHome()`, `fakeBrain()`,
  `fake-mux`).
- **Plugins** (`core/plugins.ts`): what another package adds to Riker. A
  `RikerPlugin` brings a `Triage` (at most one), `connectors` (each a
  status line, attached at construction, started off the fixture day),
  `drafts` (each a `DraftKind`: it builds a draft from a task's last
  message, words it, rewrites its text and sends it; core holds them in
  `Drafts`, `desk.drafts` for the TUI), move `guards`, its `config`
  sections (`configSection(key, defaults, merge)`: core keeps what the file
  holds under that key as written, the plugin reads it whole with
  `section.of(config)`) and `assistant` lines for the Assistant's system
  prompt. Core's vocabulary stays open: a `Channel` is a string, a
  `DraftAction` a `type` plus the plugin's own fields. An entry point hands
  the engine its list (`rikerPlugins()` in `tui/src/plugins.ts`, which
  `index.tsx` and riker-tools both read; the fixture day and the sim have
  their own); core imports none of them. A test picks only what it drives: `githubPlugin({ api,
  prs, clock })`, `slackPlugin({ transport, remoteLink })`.
- **`@riker/triage`**: the chain of rules (`src/triage.ts`) and the inbox's
  worker (`src/worker.ts`); `triagePlugin()`.
- **`@riker/github`**: notifications in (`ingest.ts`), the rate-limit gate
  (`gate.ts`), each task's PR status read (`pr-status.ts`; the rail's words
  for it stay `core/pr.ts`), its draft (`draft.ts`, sent through gh in
  `send.ts`), its config (`config.ts`), the poll (`connector.ts`);
  `githubPlugin()`.
- **`@riker/slack`**: the transports (`transport.ts`, `token.ts`,
  `claude-mcp.ts`, `mcp.ts`), the poller and the remote (`connector.ts`,
  `remote.ts`, `remote-links.ts`), its draft (`draft.ts`), its `slack` and
  `remote` config (`config.ts`), the hold on moves asked from Slack
  (`confirm.ts`, `confirmGuard`); `slackPlugin()`.
- **`@riker/code-review-plannotator`**: the guided review as a library, runnable
  without Riker: the patch (`patchFor`, origin/<base> merge base), batches of
  related files (`planBatches`), the calls with an injected `ask`
  (`reviewInBatches`), fitting the guide to the patch, the Plannotator
  snapshot, import and live comments, and the job instructions
  (`skill/SKILL.md`, which Riker's plugin ships as `riker:guide`). It knows
  nothing of Riker: warnings go to `setGuideLog`, which Riker points at
  riker.log. Without Riker, `review()` runs it end to end with any `ask`;
  `claudeAsk` is one on a fresh read-only `claude -p` that keeps each
  call's cost and tokens; `bun packages/code-review-plannotator/src/cli.ts
  review [--model] [--batch-chars] [--no-plannotator] [--open]` writes
  guide.json, guide-findings.json and usage.json (what evals compare).
- **`@riker/fixtures`**: the demo day, the offline GitHub sim and a fake
  claude.
- **`@riker/tui`**: the UI (`index.tsx`, app, components, context, terminal,
  keymap, palette) and `cli.ts`, the `riker` argv parser.
- **`@riker/cli`**: what a shell runs. `src/riker.ts` is the one entry (`bun
  run demo|sim`, the dev launcher, the compiled binary; `riker tools ...` is
  riker-tools) and `src/riker-tools.ts`; `script/riker.ts` is the dev launcher
  (`bun dev`: runs from anywhere, restarts on `RESTART_CODE`) and
  `script/compile.ts` builds `dist/riker`. The entry tells core where
  riker-tools is (`setToolsEntry`, `core/self.ts`); core never reaches up for
  it. Run from a linked worktree, it names the main checkout's copy
  (`lastingEntry`), since briefs and hooks outlive the worktree;
  `RIKER_TOOLS_ENTRY` pins one, and a start refuses when it is gone.

Tests live beside their package (`packages/<name>/test/`).

## Architecture

- **`packages/core/src/` is the domain, with no opentui/solid imports.** It holds the
  store (`bun:sqlite`, `~/.riker/riker.db`), the agent pool, hooks,
  outbound (drafts; plugins send), learning, the Assistant, the Advisor and
  the engine that ties them together and runs its plugins. Triage and the
  connections are plugin packages. Unit-test it in `packages/core/test/` with
  `freshHome()` and `fakeBrain()`.
- **The brain is `claude -p`** (`core/brain.ts`), swappable with `setBrain` for
  tests and fixtures. User settings are skipped (`--setting-sources ""`) so the
  user's hooks never leak into what triage reads back.
- **Coding agents run as interactive `claude` in tmux**, one window per task
  in its project's session (`core/projects.ts`), in a worktree made by `wt`.
  `core/agents.ts` builds the command line and the brief. The Canvas embeds a
  grouped viewer session in a PTY. Hooks call `packages/cli/src/riker-tools.ts`, which is
  plain TS and needs no Solid preload. Those hooks write to SQLite, and the TUI
  notices through `PRAGMA data_version`.
- **`core/mux.ts` is the only door to tmux and wt**, and the only importer of
  `libtmux` (alpha, pinned exactly). Identity is the `@riker_project` /
  `@riker_task` user options, never names. Tests use `packages/core/test/support/fake-mux.ts`; real
  tmux checks use a private server (`-L`), never the default one. tmux
  refuses a command past about 16KB, so long text never rides one: a coding
  start's brief is a file (`--append-system-prompt-file`, under
  `paths.launch`), and `sendLine` pastes a long line through `load-buffer -`.
- **Where a repo is checked out is `core/repos.ts`**: `repos` in
  config is the owner's one path per repo; `core/checkouts.ts` (behind the
  Mux) inspects a path and scans `repoRoots` for checkouts. Every coding
  start checks the path first, and `needs: path` carries what is wrong and
  what was found. Nothing is mapped unless the owner picks it.
- **A terminal program an agent opens (a diff viewer) splits its own
  window**: `riker-tools pane [--zoom] [--wait] -- cmd`, so it shows in the
  viewer instead of a window of its own. `tagWindow` also sets `@riker_tools`
  (how to call riker-tools) for scripts in that pane; `packages/core/contrib/revdiff/` is
  revdiff's user-layer launcher that does this.
- **Every name Riker goes by is `core/brand.ts`** (command, tools, home,
  `RIKER_*` env, `RIKER-` refs, `@riker_*` tmux options, entrypoint), with
  aug's spellings in `LEGACY`: never spell one inline. Riker was aug, and
  until the compat window closes (docs/rename-riker.md) reads take both:
  `envVar()`, `optionFormat()`, `refNumber()` (AUG- forever), legacy
  install markers as ours but stale. `core/migrate-home.ts` moves `~/.aug`
  to `~/.riker` at start (`riker migrate --check` says how).
- **What Riker writes outside its home is `core/install.ts`**: one registry
  (`hooks`, `statusline`, `revdiff`) of idempotent install, uninstall and
  state, behind `riker install|uninstall [name] [--check]`. The engine rewrites
  stale ones at start, but only those made for its own `RIKER_HOME`. Scripts
  it writes are embedded (`with { type: "text" }`) so the compiled binary
  carries them. Setup a user would otherwise do by hand goes here.
- **A task's PR is `core/pr.ts`**: found from its linked threads (the PR
  its agent or branch opened), its URL, a PR thread it came from, or a PR
  link. The engine reads each one's checks, reviews and merge queue entry
  into `pr_status` on the GitHub clock, 25 PRs to one GraphQL query; the rail and the Canvas's
  header show it (marked stale when the last read failed), and `P` opens
  ghdash on it in the Canvas (`components/use-pr-dash.tsx`).
- **When Riker may call GitHub is `@riker/github` `gate.ts`**: a rate limit
  pauses that budget (REST or GraphQL) until its reset, kept in `kv` across
  restarts; a failed poll backs off (doubling, jittered, capped); a PR that
  keeps failing backs off alone; under `GRAPHQL_RESERVE` points PR status
  waits for the reset. The engine's GitHub status line says each of these.
- **Claudes started outside Riker are `core/strays.ts`**: found through Claude
  Code's own `~/.claude/sessions/<pid>.json` (pid, session id, cwd, tmux
  pane). The `adopt` move and `A` on the Board's Columns make one a coding task: one in
  tmux keeps running and its window moves into the project's session; one in
  a plain terminal is recorded as saved, so Start resumes it in a window.
- **Slack goes through a `SlackTransport`** (`@riker/slack`): `token`,
  `claude-mcp` (a persistent `claude -p` whose session can only read, plus a
  one-shot send call), or `mcp` (a stub). claude.ai connectors load even with
  `--setting-sources ""`, but under `-p` they connect before the first request
  only with `MCP_CONNECTION_NONBLOCKING=false` (`brainEnv`), and a tool runs
  only if a granted capability names it. A call with no `mcp__` rule gets
  `--strict-mcp-config` and loads none: late-connecting connectors re-add
  their schemas every resumed turn and miss the prompt cache (Knowledge #26,
  claude 2.1.322).
- **The Slack remote is `@riker/slack` `remote.ts`** (`docs/slack-remote.md`):
  opt-in (`remote.enabled`), separate from the triage poller. It reads one
  conversation only the owner is in (self-DM or a private channel), hears
  the owner's own plain lines into Home (author `SLACK_AUTHOR`, core's
  `heardVia("Slack")`) and posts the Assistant's answer in the thread,
  marked `[riker]`. A turn answering Slack asks as `SLACK_ASKER`
  (`askedVia`); `runMove` holds the moves in `CONFIRM_MOVES`
  for the owner's yes in that thread (`confirm.ts`, the plugin's move guard).
- **Views read through the read model** (`core/read-model.ts`), never the
  store: `riker.task(id)`, `riker.turns(id)`, `riker.pendingAction(id)` and the
  rest sit on the Riker context. Each read names the tables it queries, and
  re-runs only when one of them changes: triggers bump a counter per table
  in `table_versions`, so a write from any process says what it touched. A
  new read is one entry in `reads()`; `packages/core/test/read-model.test.ts` fails if its
  SQL touches a table it does not name. Pure row helpers (`taskRef`,
  `turnSteps`) are `core/rows.ts`.
- **The rail has a cursor and a selection** (`cursorKey` and `selectedKey`
  in `context/riker.tsx`). The selected row shows on the Canvas
  (`components/canvas.tsx`, focus pane `canvas`), Chat's main pane. Say "the
  Canvas" and "selected", never "the table", "content" or "on the table".
  Task actions (`components/task-actions.ts`, the key handlers on a row) act
  on the cursor row from the rail and on the selected row from the Canvas,
  and `select()` moves both. A Win or watched task has a second row under
  its heading (`t<id>@wins`, `copy: true`): `selectedKey` is always the
  task's `t<id>`, the cursor a row key, so find rows with `rowFor` and
  compare with `baseKey`, and leave copies out of anything that counts or
  lists tasks (rail-status-design.md, Listed twice).
- **The desk owns every owner move** (`core/desk.ts`): one method per thing
  the owner can do, over the store, the lifecycle and the task's driver.
  Components call `components/actions.tsx`, which asks the desk, opens
  dialogs and toasts the outcome; `use-agent-start`, `use-editor` and
  `use-viewer` beside it hold the start dialogs, $EDITOR and the embedded
  viewer. Nothing in `components/` imports `core/projects`. The engine
  (`core/engine.ts`) is what runs: pollers, timers, the moves drain and the
  tmux watch; it owns a desk. Triage returns effects and does not start
  agents itself.
- **`messages` is the inbox** (`@riker/triage` `worker.ts`): each row has a
  `state` (`new | triaging | done | failed`), `attempts` and `next_at`.
  Pollers only insert and then save their cursor; the engine's one worker
  (`triageInbox`, calling the plugin's `Triage.next`) claims due rows oldest first, resets stale claims at
  start, retries a failed model call with backoff up to
  `TRIAGE_MAX_ATTEMPTS`, then leaves it on the Inbox tab. A burst on one
  thread (rows within `BATCH_WINDOW_MS`) is one chain run on the latest,
  carrying all their text; the earlier rows follow it (rule `batch`).
  Ask a row's state, never its `reason` string.
- **Triage is a chain of rules** (`TRIAGE_RULES` in `@riker/triage` `triage.ts`): each
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
  review of, or tags, the owner or a team in `triage.reviewTeams` (who was
  asked is read at ingest, a tagged team from the comment), and a review
  the model finds elsewhere becomes one too. An
  unmapped repo is said on the task, never guessed; Start asks.
- **Wins history is `task_events`** (triggers in `core/db.ts`, read by
  `core/wins-board.ts`): what happened to a task, kept after its columns
  move on. The Board's tab 1 (`components/wins-tab.tsx`) shows a day's
  Wins and what else got done (docs/rail-status-design.md, Wins).
- **The Inbox is the Board's tab 4** (`core/inbox.ts`,
  `components/inbox-tab.tsx`): every message triage saw and every Advisor
  idea, newest first, with the chain that routed it. Every inbox and
  triage action lives there; the rail holds tasks and projects only.
- **Config is handed down, never reached for** (`core/config.ts`). An entry
  point makes the `ConfigSource`: `index.tsx` a `fileConfig()` (config.json,
  re-read when its mtime changes), tests (`freshHome()`, `testConfig()`) and
  the fixture day a `fixedConfig()`. The engine gives it to its pool,
  drivers and desk, which call `get()` each time they use a setting, so an
  edit applies without a restart; functions below them take the `RikerConfig`
  value, and components read `desk.config()`. A plugin's keys (`github`,
  `slack`, `remote`) are its `ConfigSection`s, read with `section.of`;
  the engine refuses one that takes a core key. Writes (`noise`, a repo
  mapped mid-start) are `update()` on the desk. `loadConfig()` is one read
  for an entry point that has no source (riker-tools' log and tmux server).
- **The agent lifecycle is `core/lifecycle.ts`.** Every change to a task's
  `agent_state` or a session's state is one of its named transitions
  (`sessionStarted`, `sessionActivity`, `sessionEnded`, `turnFinished`,
  `workFinished`, `taskClosed`, ...). Nothing else writes those columns.
- **What a rail row says is `docs/rail-status-design.md`**: four axes,
  the task's lifecycle (`status` plus a phase derived from `merged_at`,
  `pr_status` and `task_blockers`: `phaseOf`), the agent's state, rail
  grouping (`laneOf` in `core/lanes.ts`, whose order is the rule) and tags
  (priority, watching, Wins). A new lane gets a filter pill in
  `RAIL_FILTERS` or a place in `UNFILTERED_LANES`; `packages/core/test/rail.test.ts`
  fails otherwise.
- **A task's agent is behind `core/driver.ts`.** `ChatDriver` (the pool's
  `claude -p` turns) and `TmuxDriver` (`projects.ts`) implement `start`,
  `stop`, `close`, `deliver`, `wake` and `isLive`; the desk picks one with
  `inTmux(task)` (coding, and the onboarding interview's System task) and
  nothing above the driver branches on it. What a coding
  start still needs comes back as `needs: repo | path | branch`.
- **Task actions are skills Riker runs on one task** (`core/task-actions.ts`,
  `docs/task-actions-design.md`). Built-ins (`summarize`) are registered
  there and their skills ship in Riker's own plugin (`packages/core/plugin`,
  written under `RIKER_HOME/plugin`); config `actions` changes, turns off or
  adds one. `desk.runAction` runs it headless or on a fork of the agent's
  session (`core/run-action.ts`), and its answer is a `TurnRole.action` turn,
  never the agent's; `pane` (the quiz) runs interactive claude in a split
  of the agent's window. `guide` saves its answer into Plannotator
  (`@riker/code-review-plannotator`; Riker's words for its turn are
  `core/guide-turn.ts`). `.` opens the picker; the palette lists each one;
  `actions.<name>.key` binds one at start, in the footer on the rows it
  applies to. What is offered (`actionsFor`, `whyNotOffered`) counts a
  worktree the task's repo can make; what runs (`whyNot`, and every
  trigger) needs it on disk. `desk.prepareAction` makes it in between, on
  the task's branch with no agent (`projects.ensureCheckout`), so a review
  triage files offers its guide on arrival and never runs it by itself.
  Triage marks that PR as one to review (`reviewedPr`, `core/pr.ts`): its
  guide's review opens in Plannotator's PR mode, whose Post to GitHub
  sends the owner's review, and nothing goes to the agent (`reviewExit`).
- **Other processes ask for moves through `core/moves.ts`.** One registry
  (verb, args, help, run) feeds `riker-tools move <verb>`, the Assistant's
  prompt and the engine's dispatch, which runs each on the desk. riker-tools
  inserts a `moves` row and waits; the engine claims it on `data_version`,
  runs it, and writes one line back. A new verb goes in the registry, nowhere
  else. A move that would open a dialog answers `needs ...` in words instead.
  `AGENT_MOVES` is what a task's agent may ask for, on its own task and the
  tasks it made (`from_task_id`; its `new` defaults `--from` to its own). "Move" means this bus; the
  owner's keys are task actions.
- **Timers are `core/timers.ts`** (the `timers` table): a follow-up
  (once; `followup`, an agent's too), a schedule (a tiny rule: daily,
  weekdays or day names at a local time; `schedule`, the owner's and the
  Assistant's) and the owner's reminder (`remind`, mirrored in
  `tasks.remind_at` for the rail). A timer never wakes anyone itself: the
  engine's tick turns a due one into a `timer`-channel message and marks it
  done, or moves a schedule to its first slot after now, in one write (a
  missed one fires once at start). The `timer` triage rule, first in the
  chain, files it on its task and returns a `timer` effect; the desk wakes
  the agent (a chat turn, a line in a live coding window, or a resume). A
  timer message is `from_me`, so it is never a reply target. A reminder, or
  a follow-up or schedule the owner or the Assistant set, stays unread,
  which lists its task under the rail's **Due** (first under Home) until
  the owner opens it; an agent's own follow-up only wakes the agent. The Canvas header and the
  Inbox's `timers` filter show them.
- **ctrl+z is `core/undo.ts`**: the desk keeps this session's moves (the
  owner's keys and the Assistant's verbs, never a task's own agent's),
  newest first, 50 deep, in memory. A desk method that changes a task wraps
  itself in `onTask(what, ...)`, which keeps the task as it was before and
  after; undo puts back only the parts the move changed, and refuses when
  any of them changed since. One with outside effects (start, send, archive)
  wraps itself in `cannot(what, why, ...)`, and a verb that reached no
  recording desk method is kept as one by `runMove`, so ctrl+z names it
  rather than reaching past it. A new desk method that changes a task
  goes through `onTask`; one that writes outside Riker's rows, `cannot`.
- **A project carries a brief, goals and docs** (`projects.brief`,
  `project_goals`, `project_links`; a task's `goal_id`). `lookup.projectContext`
  puts them in every brief of a task in the project, so a task's own brief
  need not repeat them; `core/project-doc.ts` is the one file the owner edits
  them in. A goal is met only by the owner's say, never by its tasks closing.
- **A finished session is written up once** (`core/digests.ts`,
  docs/session-digests-design.md): a `digests` row from `riker-tools done`'s
  flags, or from the haiku watcher (`core/digest-watcher.ts`) for a coding
  session that ended without `done` but changed something. Two readers,
  both off by default: the project journal (`core/journal.ts`, a file
  under `RIKER_HOME/projects/<slug>/`; the engine is its only writer, from
  `task_events`, and writes only between its markers) and the task's story
  (`core/story.ts`, versioned rows beside the brief, owner pins). Config
  holds the defaults; `projects.journal|story` and `tasks.story` override
  them (`J`, `move story|journal`). Digests are redacted and never logged.
- **The brain docs are `core/docs.ts`** (files under `~/.riker/docs`, budgets,
  the trash, LEARNED.md's header and sections), kept at start by
  `core/doc-sync.ts` (the SOUL rename, notify-only shipped updates by one
  hash per doc in `kv`, the onboarding offer). Every Riker edit to a doc the
  owner has not asked for is a proposal on a `kind: system` task
  (`core/proposals.ts`, `doc_proposals`): the Advisor's daily
  `core/doc-pass.ts`, the onboarding interview (`core/onboard.ts`, the
  `propose_doc` move) and shipped versions. A proposal is a whole text
  drafted against `base`; review and accept lay only its own changes over
  the doc as it is now (`rebased`, git merge-file), so lines written since
  are kept, and one whose lines changed since stays open. A shipped version
  replaces yours. No history. The pass also reads Knowledge (`core/knowledge.ts`,
  with facts it checks: an entry's task gone, files it cites gone from the
  repo) and may propose merging and retiring entries, on a System task of
  their own (`doc: Knowledge`); accept retires the old rows (`hub.retired_at`,
  `superseded_by`), which `listKnowledge` then leaves out.
  The interview is interactive claude in its System task's own window
  (`inTmux` in `core/driver.ts`), shown in that task's Canvas; it writes
  drafts to `drafts/docs` and hands them in with `propose_doc --file`.
- **Home is a `kind: home` task** (`store.homeTask()`), and its agent is the
  Assistant (`core/assistant.ts`): a resumed `claude -p` allowed only
  `riker-tools`. `listTasks()` never returns it, so nothing that lists work
  sees it. A turn's path, its command line and what it costs in the prompt
  cache are `docs/assistant-lifecycle.md`.
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
- **Logging is `core/log.ts`**: `logger(scope)` writes lines to `riker.log`
  under `RIKER_HOME`, never to the terminal (the TUI owns it). It is off unless
  `RIKER_LOG`, `log.enabled` in config, or `RIKER_DEV` (set by `bun run dev`)
  turns it on. Log where an error is swallowed into a status line, and use
  `log.time()` for timings.
- **What model calls cost is `core/spend.ts`**: `think()` records each
  call's `total_cost_usd` and tokens in `spend` (local day, task, role from
  the call's `spend` tag); the Slack reader's persistent session reports a
  running total, so it records the difference per turn. `config.spend` caps
  the day: past it the pool queues `by: "riker"` turns with the reason and the
  Advisor and doc pass skip; the owner's turns and coding Starts still run.
  The sidebar's status line, the table header, the Board's Cost tab and
  `riker-tools spend` show it. A resumed general turn sends only the turns
  since its last finished answer (`unheard`), and the coding brief only the
  last `CODING_BRIEF_TURNS`; the Advisor asks only when `workPicture()`'s
  hash moved. A chat turn leaves a session idle past the prompt cache's
  hour, and Home one past `chat.homeMaxTokens` of context (`leaveSession`,
  from `sessions.context_tokens`), for a new one that reads the talk back.
  The Assistant's "Where things stand" is counts, not rows,
  and a resumed session gets only its changed lines (or one "unchanged"
  line) against what that session last heard (`heardWhere`, in `kv`).
- **Perf counters are `core/perf.ts`**, on with the log (off again with
  `log.perf: false`): per-minute histograms per op plus the slowest examples
  past `log.slowMs` (default 50), in `perf.db` under `RIKER_HOME` (its own
  file, so a flush never moves riker.db's `data_version`). `log.time()` feeds
  it; hot paths call `timing`/`measure`/`perfStart` directly (read-model
  reads, the TUI's refresh fan-out, engine ticks, every real `mux.*` call,
  frames). Names and numbers only, never content. `riker-tools perf` reports
  p50/p95/max per op.
- `packages/tui/src/keymap.ts` is the single binding table. Each mode (Chat, Board) has its
  own `FocusProvider`. `TerminalsProvider` sits above both, so PTYs survive the
  switch. A key that means different things by row (`x`, `e`) gets one
  command per meaning, each `relevant` to its rows and declining the others,
  so the footer names the one that applies; `packages/tui/test/keymap.test.ts` checks a key
  means one thing for any row. A view's own `KeyHints` use the footer's words.
- The footer and the `?` help (`components/focus-help.tsx`) show the same
  thing: the bindings reachable from the focused pane, through
  `helpBindings` in `keymap.ts` (relevant to `HelpCtx` first, then the first
  binding per key; only the `terminal` scope while one is attached). A
  binding that applies only sometimes says so with `relevant`, or both will
  list it where it does nothing. The Board's tab is `HelpCtx.board`.
  The `:` palette lists the same set (`packages/tui/src/palette.ts`: one entry per
  command, movement left out, a binding about the row is the one whose
  `relevant` declines with no row) plus the moves with no key, and runs a
  key's command through `keymap.dispatchCommand` on the pane under it.
  It opens on Context (the pane's and the row's, flat, titled for the row:
  each view's `subject`); tab shows All (app-wide and keyless too,
  grouped). The mode is `paletteMode` on the Riker context, one per session.
- Keymap layers run before a focused `<input>`. Any handler reachable while the
  chat box has focus must decline (`unlessTyping`).
- A key listed in the `terminal` scope gets past an attached agent (the
  passthrough lets that scope's keys through): `ctrl+]` detaches, and the
  go-to chord (`ctrl+\`, `keys.goTo` in config) detaches and opens the
  search list, `ctrl+t` jumps your tmux client to the agent, and `ctrl+e`
  shows or hides the rail and stays attached (the agent loses them; a
  terminal with no agent gets them). `buildKeymap` swaps config's navigation
  keys in at start.
- `ctrl+o` (and `ctrl+[`) goes back and `ctrl+a` goes Home from anywhere:
  a modal, the chat box, the Board, an attached agent (detach first). They
  are a layer with no target under every other (`shell.tsx`), which the
  terminal's own layer detaches and declines to. `ctrl+[` is the Esc byte
  unless the terminal speaks the kitty keyboard protocol to Riker, and tmux
  folds it into Esc whatever `extended-keys` says, so there it is Esc and
  its hint hides (`HelpCtx.kittyKeys`); `ctrl+o` works in both.
- A default ctrl chord must reach Riker inside tmux with `extended-keys`
  off: never `ctrl+j/m/i/h` (the newline, Enter, Tab and Backspace bytes),
  `ctrl+b` (tmux's prefix) or `ctrl+h/j/k/l` (vim-tmux-navigator).
  `packages/tui/test/keymap.test.ts` fails on one.
- Navigation history is `core/nav-history.ts`, held by the Riker context:
  every change of the selected row or the view is a visit (recorded once per
  handler, so a switch plus a select is one), `[`/`]` go back and forward,
  and the go-to list puts the recent rows first.
- A `Pane` is `flexShrink=0`, so a growing child (scrollbox, terminal host)
  needs `flexBasis={0}` or it pushes the footer off-screen.
- **`docs/architecture.html` is the public architecture walkthrough**
  (standalone HTML, hosted as is). A change to what it shows (a package or
  `RikerPlugin` field, a triage rule, a lifecycle transition, a move verb,
  a task action, a table, a one-door file, a source file) updates the page
  in the same branch, and its footer's commit stamp. Done when headless
  Chrome's `--dump-dom` shows every section filled and no console errors.
- **`docs/keyboard.html` is the keyboard reference** (standalone, beside
  it): what the footer lists in each place and every binding by scope, as
  JSON that `packages/tui/src/keys-doc.ts` makes from the keymap through
  `helpBindings`. A key change runs `bun run docs:keys`;
  `packages/tui/test/keys-doc.test.ts` fails until it does. A new place to
  stand (a pane, a Board tab) is one entry in its `PLACES`.
- **Both pages are published to GitHub Pages**
  (https://andycmaj.github.io/riker/) by `.github/workflows/pages.yml` on
  every push to main. `bun run docs:site` (`packages/tui/src/site.ts`)
  builds `_site/`: the two pages with a shared nav, the keyboard data
  rebuilt from the keymap, and an index. Nothing else under `docs/` is
  published; a new public page is one entry in `SITE_PAGES`.
  `packages/tui/test/site.test.ts` fails on anything that reads like a
  token, a home path, an email or a Slack id.

## TypeScript

- Never use `any`. Node/Bun types only.
- Comments explain why, not what. No JSDoc.
- Enums as `const X = {...} as const`, never TS `enum`.
- Read Solid props lazily. Annotate `<Show>`/`<Match>` accessor children (they
  do not infer here).

## Testing the TUI

- One Riker runs per `RIKER_HOME` (`core/home-lock.ts`), so a worktree's
  `bun dev` on the real home is refused while the owner's Riker runs. Try a
  change with `bun run demo` or a scratch `RIKER_HOME`.
- A Riker run from a worktree hands its agents and hooks the main
  checkout's riker-tools (`lastingEntry`, `core/self.ts`), so a branch's own
  riker-tools change (a new verb, a changed hook) is not what they run. Pin
  the branch's copy with
  `RIKER_TOOLS_ENTRY=$PWD/packages/cli/src/riker-tools.ts bun dev`, and the
  briefs and hooks it writes name that path.
- `bun run demo` runs the fixture day. Drive it in tmux with a unique session
  name and `tmux capture-pane -p`.
- `bun run sim [review-cycle|review-ask] [--brain fake|haiku]` is the real
  TUI on a scratch home against an offline GitHub (`packages/fixtures/src/sim/`):
  the engine's `github.api`/`github.prs` seam reads a JSON state file, Send
  writes to it, so triage, `pr_status`, the rail, `riker-tools feedback` and
  nudges run unchanged with no GitHub call. From another terminal,
  `bun run sim:do pr-open [--mine] | comment | mention | review --verdict
  approve|changes|comment --comments N | ci fail|pass | push | merge |
  play <scenario> | state` changes it, and the sim polls on the write. Its
  repo `sim/riker` is a remote-less clone of Riker whose PR branches are real
  commits, so a task on one starts in a worktree with a real diff; the
  seeded coding task's `--mine` PR is linked to it. A scenario is a list of
  events in `SCENARIOS` (`events.ts`); `packages/fixtures/test/sim.test.ts` reads the fake
  through `pollGithub` and `readPrBatch`, so it cannot drift from them.
- `bun test` covers the core. Reproduce a bug in a test before fixing it.
- Real-mode checks cost tokens: use `haiku` in a scratch `RIKER_HOME`.
