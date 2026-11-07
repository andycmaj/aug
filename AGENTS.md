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
- **Slack goes through a `SlackTransport`** (`core/slack/`): `token`,
  `claude-mcp` (a persistent `claude -p` whose session can only read, plus a
  one-shot send call), or `mcp` (a stub). claude.ai connectors load only with
  `--setting-sources user`.
- **The rail has a cursor and a table** (`cursorKey` and `selectedKey` in
  `context/aug.tsx`). Rail keys act on the cursor row, table keys on the table
  row, and `select()` moves both.
- **The engine owns every owner move.** Components call
  `components/actions.tsx`, which talks to the engine. Triage returns effects
  and does not start agents itself.
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
