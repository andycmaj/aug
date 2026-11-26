# Assistant lifecycle

The Assistant is Home's agent (`kind: home`, `store.homeTask()`): a headless
`claude -p` turn per thing the owner says, resumed by session id, with
`riker-tools` as its hands. This doc follows one turn from the owner's line to
the answer, and says what each turn carries into the prompt cache, which is
where its cost goes.

## One turn

1. **Asked.** The owner's line in Home (the chat box, or a Slack remote line
   with author `SLACK_AUTHOR`, `heardVia("Slack")`, `@riker/slack`
   remote.ts) is a turn row. The
   ChatDriver asks the pool for a turn: `AgentPool.request(taskId, reason,
   by)` in `core/agents.ts`. The owner's turns run now; `by: "Riker"` turns
   wait when the pool is full or the day's spend cap is reached
   (`config.spend`, `core/spend.ts`).
2. **Session.** `chatResume` picks the session the turn continues: the
   task's latest chat session, unless the last turn had a denied call (a
   resumed session replays its denials, so a new one starts and reads the
   conversation back). `leaveSession` also leaves it when the last answer is
   older than `config.chat.idleMinutes` (55: past the cache's hour a resume
   re-writes everything anyway), or when Home's context is past
   `config.chat.homeMaxTokens` (60k, `sessions.context_tokens`). No session
   means a new `--session-id`.
3. **Model.** `homeModel` (`core/home-model.ts`) picks it. A turn whose
   owner words since the last answer are one short line that is a single
   move or lookup (start, stop or done on one task, what is waiting, show a
   task, make a task with a given title) and names no project is simple
   (`simpleAsk`), and runs on `config.brain.assistantSimpleModel` when that
   is set; everything else runs on `assistantModel`. The prompt cache is per
   model, so a session keeps the model it started on (`sessions.model`): a
   simple turn on a warm `assistantModel` session stays on it, and a turn
   that needs `assistantModel` leaves a session on the simple model for a
   new one. The simple model only starts with a session that starts anyway.
   A project's manager (`core/manager.ts`) is not routed: even a short line
   on its row asks it to judge the plan (unblock the next task, start an
   agent, rewrite the standing), so it runs on `brain.projectManagerModel`
   (`assistantModel` when unset), and leaves a session started on another.
4. **Call.** `assistantCall` (`core/assistant.ts`) builds it:
   - `system`: `assistantSystem(config)`, the role, the riker-tools commands,
     the moves, grants (`grantedNote`, `connectorNote`, `docsNote`) and the
     brain docs (PERSONA, JOB, LEARNED).
   - `prompt`: `assistantPrompt`, where things stand (a snapshot of open
     work and projects), the last 20 Home turns when the session is new,
     tasks and projects the owner named, `deniedNote`, then what the owner
     said since the last answer.
   - `tools`: `ASSISTANT_TOOLS` (Bash, Write, reads) plus `Skill` when a
     granted capability is a plugin.
   - `allow`: `assistantAllow(config)`, riker-tools and gh reads, the reads,
     Write in the doc drafts folder, and `capabilityAllow("assistant")`.
   - `model`: what `homeModel` picked: `config.brain.assistantModel`
     (sonnet by default), or `assistantSimpleModel` (haiku by default, `""` off).
   - `env`: `RIKER_ASKED_BY` is `askedVia(place)` when the turn answers a
     line heard elsewhere (`SLACK_ASKER` for Slack), so that plugin's guard
     holds the moves that start or end work for the owner's yes there.
   - `system`: core's words plus each plugin's `assistant` lines (GitHub's
     gh reads, Slack's hold).
5. **Run.** `think()` (`core/brain.ts`) runs `claude` with `claudeArgs(call)`
   and `brainEnv(call)`, in `paths.work(taskId)`. Steps stream onto the turn
   row as they come. A move the Assistant makes goes through `riker-tools move`
   to the engine (`core/moves.ts`), which runs it on the desk.
6. **Finish.** The answer lands on the turn. Denied calls become `denied:`
   steps plus a `grant:` step naming the config key (`grantSteps`), and the
   next turn's prompt names them. `turnFinished` (`core/lifecycle.ts`) moves
   the session on. `recordSpend` writes the call's cost to `spend`.

## The command line

```
claude -p --output-format stream-json --verbose --setting-sources ""
  --model <homeModel's pick> --append-system-prompt <system>
  --resume <id> | --session-id <id>
  --tools Bash,Write,Read,Grep,Glob,WebSearch,WebFetch
  --permission-mode dontAsk --allowedTools <assistantAllow>
  [--strict-mcp-config]            # no mcp__ rule granted
env: MCP_CONNECTION_NONBLOCKING=false   # an mcp__ rule granted
```

The prompt goes on stdin. `--setting-sources ""` keeps the owner's hooks,
permission rules and plugins out (Knowledge #26).

## Connectors and the prompt cache

claude.ai connectors (Slack, Claude Docs; Notion when connected on
claude.ai) load in a headless call even with `--setting-sources ""`. What
happens to them depends on the Assistant's grant
(`capabilities.grants.assistant` in `~/.riker/config.json`):

- **No `mcp__` rule** (no connector capability granted): `claudeArgs` passes
  `--strict-mcp-config`, and no MCP server loads. The init line lists no
  `mcp_servers`.
- **A connector capability granted** (`slack.read`, `docs.read`, ...):
  `brainEnv` sets `MCP_CONNECTION_NONBLOCKING=false`, so every connector
  connects before the first request and its tools are present from the start
  of every turn. Strict mode is all or nothing: one grant loads every
  connector the account has (35 tools for Slack plus Claude Docs, about 33k
  tokens of context), and a tool runs only if a granted capability names it.

Before AUG-0162 a call with no grant had neither: connectors connected after
the first request, so each resumed turn appended their tools as removed, then
added again. The cache breakpoint then sat more than 20 content blocks past
the last cache write, the lookback missed, and the whole context was written
again at the 1h cache-write price. That was 49 of the 70 dollars spent on
2026-11-15 and 16 (AUG-0160).

Measured on claude 2.1.322, haiku, four resumed Assistant turns of one
`riker-tools` call each (two requests per turn), tokens per turn:

| Setup | mcp tools at init | Turn 1 read / write | Turns 2–4 write | Turns 2–4 read |
|---|---|---|---|---|
| No grant, before AUG-0162 | 0, connect mid-turn | 12k / 49k | 74k, 110k, 147k | 60k, 97k, 133k |
| No grant, `--strict-mcp-config` | 0 | 28k / 14k | 180–281 | ~29.5k each |
| `slack.read` granted | 35 | 86k / 9k | 192–254 | ~95k each |

Turns 2–4 at Sonnet 5.5 prices ($0.10 per million cache read, $4.00 per
million 1h cache write): about $1.35 before, $0.01 with no grant, $0.03 with
`slack.read`. Before, context grew about 37k tokens a turn for a few lines of
conversation; the cost grows with the session.

What still writes the cache on a resumed turn: anything that changes the
start of the context (the system prompt: a grant, a brain doc edit, the
moves list) and the new turn itself. A grant change also changes what the
session was told it may do (Knowledge #26); nothing starts a new session for
it, so it waits for the idle hour or the size bound.

## Simple turns on the cheaper model

`bun packages/core/script/home-model-eval.ts [--models haiku,sonnet]
[--out runs.json] [ask ...]` runs real Home asks, each on a new session in a
scratch `RIKER_HOME` seeded the same way, and prints each model's steps,
answer, tokens and cost. Only the Assistant's calls reach claude.

Measured on claude 2.1.322, the default eight asks (two status lookups, two
task lookups, done, stop, start, make a task with a title), one each:

| Model | Cost per ask | Time per ask | Cache write per ask |
|---|---|---|---|
| haiku | $0.0024 | 4.3s | 8.7–9.2k |
| sonnet | $0.0355 | 4.2s | 7.8–8.1k |

Both made the same move on every move ask, and both lookups named the
right tasks. Sonnet's lists were fuller ("what is waiting?" listed every
open task, haiku only the one waiting on the owner); haiku once added a
brief nobody asked for to a task it made.

## Checking it

- The stream's first `system`/`init` line lists `tools`, `mcp_servers` (with
  status) and plugins: what the call really had.
- `RIKER_REAL_CLAUDE=1 bun test packages/core/test/no-connectors-real.test.ts` reads only the
  init line for the Assistant, ungranted (no server) and with `slack.read`
  (Slack connected). It costs next to nothing.
- `packages/core/test/propose-doc-real.test.ts` runs a whole Assistant turn under its real
  allow list; `packages/core/test/docs-grant-real.test.ts` checks Docs grants for task Q/A.
- Per-request usage, cache writes split 1h and 5m, and the exact messages
  sent are in the session's jsonl under `~/.claude/projects/` (Knowledge #37,
  `docs/assistant-cost-analysis.md`).
