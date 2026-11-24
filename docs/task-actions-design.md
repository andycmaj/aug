# Pluggable task actions (AUG-0073) — plan

Status: approved by the owner (2026-11-20), and built (Build order, steps 1-8). Decisions below.

## What exists today

- A task action is a key on a row: one `BindingSpec` in `taskActions`
  (`packages/tui/src/keymap.ts`), one `Commands.*` id, and one handler in
  `useActions().taskActions` (`components/actions.tsx`) that asks the desk.
  Adding one touches four places; nothing is data.
- Moves (`core/moves.ts`) are the other-process bus: one registry, verb + args
  + `run(desk, task, args, by)`. Triage is a rule chain (`TRIAGE_RULES`) that
  returns effects. Both are the registry shape to copy.
- Ways Riker already runs work for a task, which actions reuse:
  - headless `claude -p` (`brain.think`, `BrainCall`): prompt, system, model,
    tools, allow, `pluginDirs`, `resume`;
  - telling the task's own agent (`driver.deliver`, `projects.tell`);
  - a program on the table (`useDocReview` runs revdiff with `terminals.open`)
    or in a split of the agent's window (`riker-tools pane`);
  - capabilities (`core/capabilities.ts`, AUG-0057): a plugin loaded with
    `--plugin-dir` (refused if its skills' `allowed-tools` widen the grant),
    commands allowed on Bash, per role.
- Output lands on a task as turns, as files under What it made
  (`paths.work(id)`), or as links.

## Core idea: an action is a skill, registered by name

A skill already is "a named recipe an agent runs". Riker adds only what a skill
cannot say: which rows it applies to, how Riker runs it, where its output goes,
and when it runs by itself. So:

- **The recipe is a skill** (`SKILL.md`): prompt, `allowed-tools`, any files
  it needs. The same skill works by hand in any claude session.
- **The registration is Riker's**: a short entry by name in `config.json`
  `actions`. Nothing is an action until it is registered, the same way nothing
  is granted until a role lists a capability.

```jsonc
"actions": {
  "summarize": { "skill": "riker:summarize", "via": "fork", "output": "turn" },
  "guide":     { "skill": "riker:guide", "via": "fork", "capability": "plannotator",
                 "kinds": ["coding"], "needs": ["worktree"],
                 "on": [{ "event": "ready" }] },
  "quiz":      { "skill": "quiz-me", "via": "pane", "kinds": ["coding"],
                 "args": "5 questions", "key": "shift+q" }
}
```

- Built-in recipes ship as skills in Riker's own plugin (`riker:summarize`,
  later `riker:guide`, `riker:quiz`), embedded in the binary (`with { type:
  "text" }`, `packages/core/plugin/`) and written under `RIKER_HOME/plugin`
  whenever a run needs it, so headless runs load it with `--plugin-dir` and
  need no install step. `riker install actions` (an `install.ts` entry, with
  the `pane` step) will put it in the user's Claude Code plugins too, for
  interactive sessions and coding agents (`/riker:summarize`).
- Built-ins are registered by default. An entry in config with the same name
  changes it field by field; `"summarize": false` turns it off.
- A registered skill that is missing is reported by name, with where Riker
  looked (`riker install --check` lists it too).

### Fields of a registration (`TaskActionSpec`, `core/task-actions.ts`)

| field        | meaning                                                                 |
|--------------|-------------------------------------------------------------------------|
| `skill`      | skill to invoke: `name` (user skill) or `plugin:name`                   |
| `args`       | text passed to the skill (`/quiz-me 5 questions`), with `{ref}` `{title}` `{worktree}` `{branch}` `{base}` `{pr}` filled in |
| `via`        | `headless`, `fork`, `agent` or `pane` (below)                           |
| `capability` | an extra capabilities grant for this run (plugin, commands)            |
| `kinds`, `needs` | which rows it applies to (`worktree`, `session`, `pr`)              |
| `output`     | `turn`, `file` or `none`                                                |
| `key`        | optional direct key on the rail and table                               |
| `on`         | events that run it by itself (see Triggers)                             |
| `model`      | default `brain.agentModel`                                              |
| `title`      | picker label; default the skill's `description`                         |

## How an action runs (`via`)

One runner per `via`, behind `desk.runAction(taskId, name, by)`, the way
`Drivers.for(task)` picks a driver. Nothing above it branches on `via`.

- **headless**: `brain.think` with the task's context (`turnPrompt`), the
  general role's allow list plus `capability`, cwd = the worktree or
  `paths.work(id)`. The prompt is `/<skill> <args>`.
- **fork**: as headless, plus `resume: <the agent's session>` and a new
  `BrainCall.fork` that adds `--fork-session`. The run sees everything the
  agent saw and cannot disturb it. To check while building: a coding session
  ran with the user's settings in the worktree, so the fork must run in the
  same cwd for claude to find the transcript. With no session, it falls back
  to headless.
- **agent**: what typing does (`addTurn(you, pending)` + `driver.deliver`),
  with `/<skill> <args>` as the text. It spends the agent's context and waits
  on it. Use it for actions that should change the agent's own work.
- **pane**: interactive `claude "/<skill> <args>"` in a split of the agent's
  window (the `riker-tools pane` mechanism), zoomed, shown in the viewer. With
  no live agent window, it opens on the table, as revdiff does. Interactive
  claude loads user settings, so every installed skill is there.

How skills load headless: `--setting-sources ""` skips the user's skills.
A plugin skill loads with `--plugin-dir` (AUG-0057's path, with its
`allowed-tools` check). A bare user skill (`~/.claude/skills/quiz-me`) is
wrapped: Riker links it into a throwaway plugin folder and passes that. The
same widening check applies, so a skill that asks for more than its
`capability` grants is refused with a reason, not run.

An action never touches `agent_state` (the lifecycle's columns). A headless
or fork run writes its own turn (`author: "action:<name>"`, running, then
done or failed), so the rail does not say the agent is working. An action
the owner asks for runs now. One Riker starts by itself (Triggers) waits its
turn under `maxActiveAgents`, as Riker's chat turns do.

## Triggers: actions in triage and the lifecycle

`on` lists the events that run an action without a key press. Each event is
matched by plain rules (no model call), in the noise rules' shape:

```jsonc
"on": [
  { "event": "triaged", "kind": "coding", "channel": "github",
    "githubReason": ["review_requested"] },
  { "event": "ready" },
  { "event": "merged" }
]
```

- `triaged`: triage made or updated a task. It is a new effect in
  `core/triage.ts`, `runAction(name)`, which the engine runs after the task
  exists. Triage still never starts agents itself; the engine does, as now.
  Matchers: `kind`, `channel`, `githubReason`, `author`, `title`, `body`
  (regex, as in `NoiseRule`), `project`.
- Lifecycle events, from the transitions in `core/lifecycle.ts`: `ready`
  (the agent marked its work ready for review), `pr` (a PR was linked),
  `merged`, `done`.
- One run per task per action per event, kept in a small
  `action_runs(task_id, action, event, at)` table, so a re-triaged message
  does not run it twice.
- Optional, later: the triage verdict could also suggest actions from the
  registered list (`when` text per action). Not in the first build.

## The initial three

- **summarize** (`riker:summarize`, `fork`, output `turn`). The skill: the
  goal, what changed (commits and diff against `{base}`), decisions and why,
  what is left, what is blocked, in under 15 lines. A non-coding task falls
  back to `headless` over the turns.
- **guide** (`riker:guide`, `fork`, output `guide`). One run does both the
  guided review and the agentic review: chapters, plus findings pinned to
  their lines. As built, see Build order, step 6: Plannotator keeps a saved
  guide's notes but draws them nowhere, so Riker posts the findings as
  comments into the review it opens.
- **quiz** (`riker:quiz`, shipped with Riker, `pane`, `kinds: [coding]`). The
  skill and its `args` are configurable: point `skill` at your own quiz skill
  to use it instead.

## In the TUI

- `.` on a rail or table row opens the **Actions** picker (`ChoiceModal`):
  the registered actions that apply to this row, each with its key as a hint
  and its last run ("summarized 2h ago").
- An action with `key` gets its own binding: `buildKeymap` adds one
  `BindingSpec` per action in the `rail` and `task` scopes (`cmd:
  action:<name>`, `relevant` from `kinds` and `needs`), so the footer and `?`
  list it only where it runs. `packages/tui/test/keymap.test.ts` rejects an action key
  that clashes with a built-in key for the same row. Keys are read at start,
  as `keys` already are.
- The palette lists every registered action that applies to the row under
  the table, one entry each ("Action: summarize the work so far").
- A running action shows as its running turn on the table. When it ends, a
  toast says so ("summary ready", "guide ready: opening plannotator").
- A coding task whose agent is live shows the agent's terminal on the
  Canvas, not the chat its answer lands in (`chatHidden`,
  `components/canvas.tsx`). There, an answer the owner ran from the TUI
  opens over the Canvas when done (`ActionAnswerModal`, the `ActionTurn` in
  a scrollbox: j/k, space, c copies), and the `.` picker lists `Read:
  <title>` for each action's last finished answer (`actionAnswers`,
  `core/rows.ts`; the guide's is its review, a pane action's only says
  where it opened, so neither is listed). An answer a move or a trigger
  ran is read the same way.
- A guide says where it is (AUG-0192): `reviewInBatches` and `saveGuide`
  take a `progress` callback (`GuideProgress` in
  `@riker/code-review-plannotator` `progress.ts`: diff read, one call, batches
  done and running, chapters, fitting, saving), and Riker writes each stage
  as one short line on the action turn's `progress` column
  (`guideProgressLine`, `core/guide-turn.ts`). The Canvas shows it above
  the turn's steps; the rail's sub line leads with it (`guide: batches 3/5
  done, 2 running`), spinning, its PR chip set aside while it runs, then
  says `guide done` or `guide failed` for two minutes (`actionRailWord`,
  `core/rows.ts`, from the `latestActionTurns` read). A failed turn keeps
  the stage it stopped at. A run a trigger started writes the same turn,
  so it shows the same way.

## As a move

`riker-tools move action AUG-0073 summarize` (verb `action`, positional `name`),
so the Assistant can do "summarize AUG-0073". It is not in `AGENT_MOVES`, so
agents cannot run actions on each other in a loop. A `pane` action answers
"needs the TUI" as a move. AUG-0017's rename of `move` applies here like
everywhere else.

## Build order

Done (steps 1-3):

- `core/task-actions.ts`: the registry (built-ins merged with config
  `actions`), `whyNot`/`actionsFor`, the arg template, Riker's plugin under
  `RIKER_HOME/plugin`, skill resolution (Riker's plugin, or the plugin the
  action's `capability` grants).
- `core/run-action.ts`: the headless and fork runners (`BrainCall.fork` adds
  `--fork-session --no-session-persistence`); `desk.runAction`; the `agent`
  via says the invocation to the agent.
- An action's answer is its own turn role, `TurnRole.action`, so nothing
  that reads the agent's turns (resume, denials, the latest answer, Slack
  remote) takes it for one. The chat draws it whole on an accent rule; the
  transcript names it as the action's.
- `riker:summarize`; `.` opens the picker on rail and table rows; the palette
  lists one entry per action that applies, beside the row's keys.
- Checked for real (haiku, scratch home): a fork of a coding session in its
  worktree ran the skill, and its declared `git log`/`git diff` rules
  allowed those calls.

Done (steps 4-5):

- `actions.<name>.key` binds an action on the rail and the Canvas at start
  (`buildKeymap(keys, keyedActions(config))`); a key Riker already uses there,
  or one an earlier action took, is refused (`actionKeys`) and logged, and
  the action stays in the picker. `.` also works on the Board's Columns.
- `riker:quiz` (`pane`, coding with a worktree). The pane runner splits the
  agent's live window, zoomed, with `claude --plugin-dir <riker's plugin>
  "/riker:quiz ..."`; with no window it opens on the Canvas. The pane claude
  gets `RIKER_TASK_ID` and no `RIKER_SESSION_ID`, so neither Riker hook takes it
  for the task's agent (or adopts it). Its turn records only that it opened.
  Checked for real (haiku, private tmux): the skill read this branch's diff
  and asked its first question.
- A bare user skill (`"skill": "quiz-me"`) runs headless wrapped in a plugin
  of its own (`RIKER_HOME/wrapped/<name>`, the skill linked in, invoked as
  `/riker-user:<name>`). Its `allowed-tools` must stay within the action's
  capability (`pluginWidens`), or it is refused with the rules it asked for.
  In a pane it needs no wrapping: interactive claude loads the user's skills.
- `riker install actions` is left out: every runner loads Riker's plugin with
  `--plugin-dir`, so nothing needs it installed. It would only make
  `/riker:summarize` available in the owner's own sessions.

Done (step 6), the guide:

- `riker:guide` (`fork`, coding with a worktree, output `guide`) answers with
  Plannotator guide JSON only: chapters (Plannotator's own methodology) and
  review findings as line notes. It needs no plannotator capability: the
  skill only reads git, and Riker does the rest (`@riker/code-review-plannotator`, `guide.ts`).
- Riker makes the patch itself (`git diff <merge-base>`, main then master),
  fits the guide to it (files not in the patch dropped, files left out
  listed as unplaced, each file once, a note outside its file's hunks kept
  off the file), writes a v4 snapshot under What it made and saves it with
  `plannotator guide import --snapshot` (`--pr` when the task has one).
  The turn lists the chapters and every finding; the TUI opens
  `plannotator review` on the Canvas, and what the owner writes there goes
  to the agent when it exits (an approval, or a review closed without
  feedback, sends nothing: `reviewNotes`).
- The diff is in the prompts, in batches (AUG-0185). A forked run kept
  its session's habit of chained shell (`mb=$(git merge-base ...); git
  diff $mb | head`), which riker's allow rules deny, and wrote its chapters
  from memory with no findings; and nothing made a run read a big diff
  whole. So the guide no longer forks or reads the diff itself:
  - Base: `origin/<base>` when the remote has moved past the local branch
    (an unpulled local main put others' merged work in the change), else
    the local one (`mergeBase` in `@riker/code-review-plannotator` `guide.ts`). The review Riker opens
    takes the same ref (`plannotator review --base origin/main` works).
  - Riker takes the patch before the run (no change: refused before anything
    is spent) and plans it (`@riker/code-review-plannotator` `batches.ts`): lock files are left
    out of every prompt (and so unplaced); a file past 400k characters is
    named on the turn, not reviewed; the rest are grouped by what relates
    them, with no parser: files changed in the same commit of the branch,
    a test and what it tests (same stem, one in a test path or the same
    folder), and a diff that names what another file's diff defines
    (declarations on changed lines and git's hunk-header function names)
    or imports it by path. Groups fill batches of about 100k characters
    (about 25k tokens); a group too big is split by folder, then by file.
  - One batch (most changes) is one headless call, `job: whole`: the
    whole diff in the prompt, each hunk line with its old and new numbers
    in two columns (`numberedPatch`; given a bare diff, haiku pinned notes
    to the diff's own line numbers). Several are one call per batch, three
    at a time (`job: notes`: its files' summaries and notes, the index of
    every file beside them, Read allowed for the rest), then one `job:
    chapters` call from the index and the summaries; riker lays the notes
    into the chapters, and a reviewed file no chapter names goes in a last
    "Other changes", so no note is lost (`@riker/code-review-plannotator` `run.ts`).
  - So every file's diff is in exactly one prompt, whatever the model
    chooses to read. What no call answered for, chapters that did not
    parse, files too large and denied calls are said on the turn and in
    the toast, never "nothing stood out".
  - Checked with haiku on scratch homes: one call for a small change, no
    tool reads, three findings on their lines; a change forced into two
    batches: three calls, both planted bugs found on their lines, and the
    chapters put a test back with its code though the batches split them.
- Checked (plannotator 0.28.61, headless Chrome): Plannotator keeps v4
  notes but draws them nowhere: not in `plannotator review`'s Guides view,
  not in an exported page, not in an Inbox review (even with
  `inboxCodeReview` on). The notes stay in the snapshot for when it does.
- What it draws instead: comments posted into a live review
  (`POST /api/external-annotations`, in 0.28.61 and 0.29). The guide's
  review starts on a port Riker picks (`PLANNOTATOR_PORT`), and the TUI posts
  every finding once it answers (`postComments`, retrying for a minute): on
  its lines when one hunk shows them, else on its file naming the lines;
  Bug and Risk as concerns. They are pinned in the diff and in the guided
  review alike, from "Riker guide" (source `riker-guide`): decision 5. The
  owner's Send Feedback carries every comment still there, unlabelled, so
  the message to the agent says it includes the findings the owner kept.
  An earlier build wrote findings into each chapter's overview instead.
- Gaps (closed by AUG-0185, below): a guide a trigger saved had no review
  Riker opened, so no comments; the review offers the last session's
  comments as a recovered draft, so restoring it after a re-run doubled
  them.
- Plannotator cannot hold the findings for a review opened later (checked
  in the 0.29.1 source): drafts are written by the browser page, a comment
  with a `source` is not counted as the reviewer's, `/api/draft` is
  internal, and the external-annotation store lives only as long as the
  review process. So Riker keeps them (AUG-0185, the owner's pick over
  keeping a background review alive):
  - `saveGuide` writes `guide-findings.json` beside `guide.json`: the
    guide's id, title, base and each finding as its file and note, as the
    skill wrote it (not yet fitted, so a later patch can place it again).
  - **Open the guide's review** in the `.` picker and the palette, on a
    task with saved findings (`desk.hasGuideReview`, `desk.guideReview`):
    no model run. It takes the patch as it is now, refits the findings
    (`reviewComments`: on their lines when one hunk shows them, else on
    their file naming the lines; a file no longer in the change has nowhere
    to show one, so its findings are left out and the toast counts them),
    and opens `plannotator review` on a port Riker picks, as after a run.
  - Every post first clears Riker's own (`DELETE
    /api/external-annotations?source=riker-guide`), then posts the batch, so
    the findings are there once. Feedback goes to the agent on exit as
    before.
  - A guide a trigger ran opens nothing; its turn ends by pointing at Open
    the guide's review instead of "the review Riker opens".
  - Checked live (plannotator 0.29.1, scratch HOME, `PLANNOTATOR_BROWSER=none`):
    saved findings refit, posted 0.55s after the review started, posted
    again into the same review: it held 2 comments, not 4.
  - Restoring a recovered draft, checked in headless Chrome on 0.29.1: the
    page saves Riker's comments into its draft, and the next review of the
    same change offers "Draft Recovered ... restore them?". Restored after
    Riker posts, before, or with the re-run's findings reworded, the page
    shows each finding once (badge 2), and Send Feedback carries each
    once: a restored comment with a `source` gives way to the live ones
    from that source. Not doubled on 0.29.1 whether or not Riker clears
    first; the clear guards a review that is reused.
- Not the Inbox: `submit_guide` refuses a v4 snapshot, drops notes unless
  `inboxCodeReview` is on, and the Inbox's first start writes
  `~/.claude/rules/plannotator-inbox.md` into the owner's Claude config.
- Checked for real (haiku, scratch home and Plannotator data dir): the run
  read the diff, found an unguarded zero divisor, saved the guide, and the
  review UI showed the chapter with the finding under Review notes. The
  comments, again on 0.28.61 with a scratch home: posted 0.5s after the
  review started, drawn under the line and as a file banner.

Done (step 8): `riker-tools move action AUG-0012 [name]` (no name lists the
ones that apply). It starts the run and answers at once (moves run one at
a time, and an action takes minutes); a `pane` action answers that it
needs the TUI. Not in `AGENT_MOVES`; from Slack it waits for the owner's
yes (`CONFIRM_MOVES`), since it spends money. README: Task actions.

Done (step 7), triggers:

- `on` in a registration, plain rules only (`ActionTrigger`): `kind`,
  `channel`, `githubReason`, `author`, `title`, `body` (case-blind
  regexes, as in `triage.noise`), `project`. An unknown event is left out
  and logged. `triggeredBy` never picks a `pane` action: nobody is at the
  keyboard.
- `triaged`: not a new triage effect after all (every test that compares
  `effects` would change): `desk.afterTriage(outcome, message)` runs the
  effects and fires the actions, from the worker, a re-triage and `m` on a
  held message. The owner's own message on a thread fires nothing.
- `ready`, `merged`, `done`: the engine reads `task_events` past a cursor
  (`kv` `actions.events`) every 2 s, so an agent's `done` from riker-tools in
  another process is heard. `ready` is `finished` (sessions.result, which
  only `workFinished` sets). The first look starts at the newest event, so
  history runs nothing. No `pr` event yet: linking a PR writes no
  task_event.
- `action_runs(task_id, action, event)` makes each one once per task,
  action and event. Auto runs go one at a time behind each other (not the
  agents' pool), none past the day's spend cap; their turn says the event
  ("Summarize the work so far (on done)"). A guide run by itself is saved
  in Plannotator; its review waits for the owner to open it (Open the
  guide's review).

All eight steps are built.

Offered on a review that just arrived:

- A review triage files is coding on `pr:N` with a repo and no worktree,
  so the guide's `needs: [worktree]` hid it until Start, which runs a paid
  agent. What is offered and what runs are now two checks:
  `whyNotOffered` (the picker, the palette, `move action` with no name,
  an action key's footer word) counts a worktree the task's repo can make
  (`makesCheckout`); `whyNot` (`runAction`, every trigger) needs it on disk.
  So a trigger never makes a worktree, and never runs the guide on arrival.
- `desk.prepareAction(task, name)` makes the worktree when the action needs
  one: `projects.ensureCheckout`, the same wt call Start makes, on the
  task's branch, with no agent, session or window. An unmapped repo answers
  `needs` (the TUI asks where it is, as Start does; the move says how to
  map it). A branch that does not exist yet is refused before anything is
  made: there is no change to read. The TUI's picker, palette and keys and
  `move action` all go through it, so the trigger is the task-action seam,
  not the guide by name.
- The task arrives with a line saying so (`guideOffer`,
  `core/guide-turn.ts`, written by the `review ask` path in triage): the
  picker entry (and the key, when `actions.guide.key` sets one), what
  running it does, and where the review goes. No key ships by
  default: `g`, `G` and `q` are taken.
- A PR the owner was asked to review is marked when triage files it (a
  task link added by `REVIEW_LINK_BY`, read by `reviewedPr` in
  `core/pr.ts`: a task's URL, thread or `pr:N` branch can be the owner's
  own PR too). Its guide's review, after a run or from Open the guide's
  review, is Plannotator's PR mode (`plannotator review <PR URL>`): the
  saved guide is listed there (`guide import --pr`), Riker's findings are
  posted into it as before, and Plannotator's own Post to GitHub submits
  the owner's review (approve, comment or request changes, with line
  comments). On exit nothing goes to the agent; the toast says
  Plannotator's status line, or that nothing was posted (`reviewExit`,
  `core/guide-turn.ts`). The sim turns PR mode off (`setGuidePrReviews`),
  since its PRs are not on GitHub.
- The owner's own work (no mark) is reviewed on the worktree against its
  base, and what they send goes to its agent, never GitHub; with no agent
  running it waits on the task as the owner's message, and Start hands it
  over.

## Decisions (owner, 2026-11-20)

1. quiz: Riker ships `riker:quiz`; a registration can point at another skill.
2. Picker key: `.`. Actions are also listed in the palette.
3. Triggers: plain rules only (`on` matchers). No model-suggested actions.
4. Registrations live in `config.json` `actions`.
5. Guide: one run writes the guided review and pins review findings as
   notes in the same guide (snapshot v4).
6. Actions are skills, registered by name; `move action` runs them by name.
