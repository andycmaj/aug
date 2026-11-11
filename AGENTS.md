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
- **A terminal program an agent opens (a diff viewer) splits its own
  window**: `aug-tools pane [--zoom] [--wait] -- cmd`, so it shows in the
  viewer instead of a window of its own. `tagWindow` also sets `@aug_tools`
  (how to call aug-tools) for scripts in that pane; `contrib/revdiff/` is
  revdiff's user-layer launcher that does this.
- **Slack goes through a `SlackTransport`** (`core/slack/`): `token`,
  `claude-mcp` (a persistent `claude -p` whose session can only read, plus a
  one-shot send call), or `mcp` (a stub). claude.ai connectors load only with
  `--setting-sources user`.
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
- **The agent lifecycle is `core/lifecycle.ts`.** Every change to a task's
  `agent_state` or a session's state is one of its named transitions
  (`sessionStarted`, `sessionActivity`, `sessionEnded`, `turnFinished`,
  `workFinished`, `taskClosed`, ...). Nothing else writes those columns.
- **A task's agent is behind `core/driver.ts`.** `ChatDriver` (the pool's
  `claude -p` turns) and `TmuxDriver` (`projects.ts`) implement `start`,
  `stop`, `close`, `deliver`, `wake` and `isLive`; the desk picks one by the
  task's kind and nothing above the driver branches on it. What a coding
  start still needs comes back as `needs: repo | path | branch`.
- **Other processes ask for moves through `core/moves.ts`.** One registry
  (verb, args, help, run) feeds `aug-tools move <verb>`, the Assistant's
  prompt and the engine's dispatch, which runs each on the desk. aug-tools
  inserts a `moves` row and waits; the engine claims it on `data_version`,
  runs it, and writes one line back. A new verb goes in the registry, nowhere
  else. A move that would open a dialog answers `needs ...` in words instead.
  `AGENT_MOVES` is what a task's agent may ask for. "Move" means this bus; the
  owner's keys are task actions.
- **Home is a `kind: home` task** (`store.homeTask()`), and its agent is the
  Assistant (`core/assistant.ts`): a resumed `claude -p` allowed only
  `aug-tools`. `listTasks()` never returns it, so nothing that lists work
  sees it.
- **Logging is `core/log.ts`**: `logger(scope)` writes lines to `aug.log`
  under `AUG_HOME`, never to the terminal (the TUI owns it). It is off unless
  `AUG_LOG`, `log.enabled` in config, or `AUG_DEV` (set by `bun run dev`)
  turns it on. Log where an error is swallowed into a status line, and use
  `log.time()` for timings.
- `src/keymap.ts` is the single binding table. Each mode (Chat, Board) has its
  own `FocusProvider`. `TerminalsProvider` sits above both, so PTYs survive the
  switch.
- Keymap layers run before a focused `<input>`. Any handler reachable while the
  chat box has focus must decline (`unlessTyping`).
- A `Pane` is `flexShrink=0`, so a growing child (scrollbox, terminal host)
  needs `flexBasis={0}` or it pushes the footer off-screen.

## TypeScript

- Never use `any`. Node/Bun types only.
- Comments explain why, not what. No JSDoc.
- Enums as `const X = {...} as const`, never TS `enum`.
- Read Solid props lazily. Annotate `<Show>`/`<Match>` accessor children (they
  do not infer here).

## Testing the TUI

- `bun run demo` runs the fixture day. Drive it in tmux with a unique session
  name and `tmux capture-pane -p`.
- `bun test` covers the core. Reproduce a bug in a test before fixing it.
- Real-mode checks cost tokens: use `haiku` in a scratch `AUG_HOME`.
