# TODO: a Docs screen that explains what the models are told

Status: idea, not started. Part of it exists already (see "Today").

## Problem

aug's models are steered by eight Markdown docs. I can edit them, but nothing
in the app tells me which model reads which doc, when it reads it, how much of
it gets through, or whether my copy still matches the shipped default. I had
to read the code to find out. I want one place in the app where I can pick a
doc, see what it does, and open it in `$EDITOR`.

## How the docs work

### Where they live

- The shipped defaults are in `docs/defaults/*.md` in the repo. They are
  templates only.
- The live copies are in `~/.aug/docs/` (`$AUG_HOME/docs/`). Every prompt reads
  these.
- On first start, `engine.start()` calls `ensureDocs()`
  (`src/core/engine.ts:114`), which copies each default into place if that
  file isn't there yet. Existing files are never overwritten, so editing a
  default later doesn't change a home that already has a copy.
- If a home copy is missing when it's needed, `readDoc()` returns the repo
  default instead (`src/core/docs.ts:54`).
- The demo fixture also calls `ensureDocs()`.

### When they are read

Every read happens when a prompt is built, so an edit applies on the next
agent start or model call. No restart is needed.

| Doc          | Read by                                                        | Cut to          | When                                     |
| ------------ | -------------------------------------------------------------- | --------------- | ---------------------------------------- |
| SOUL.md      | triage, general agent turns, Assistant                         | 2.5k / 4k / 3k  | every triage pass, agent turn, Assistant turn |
| JOB.md       | triage, general agent turns, Assistant, Advisor                | 2.5k / 2.5k / 2k / 2.5k | same, plus each Advisor run       |
| TRIAGE.md    | triage (`triage.ts:119`)                                       | whole           | every triage pass                        |
| STYLE.md     | general agent turns only, for drafting replies                 | 2.5k            | every agent turn                         |
| COUNSEL.md   | Assistant (`assistant.ts:75`), Advisor (`advisor.ts:88`)       | whole           | every Assistant turn, each Advisor run   |
| ASSISTANT.md | general agent turns: top of `turnSystem()` (`agents.ts:188`)   | whole           | every agent turn                         |
| CODING.md    | coding agents: top of `codingBrief()` (`agents.ts:498`)        | whole           | once, when the agent starts in tmux (`--append-system-prompt`) |
| LEARNED.md   | written by `learn.ts`; everything but `## Watching` goes to the coding brief, agent turns, triage, the Assistant and the Advisor | whole | as each of those runs |

"Cut to" is the `head()` limit in characters, given in the same order as the
readers in that row. Text past the limit is dropped silently.

## Today

- `D` (`Commands.DOCS_OPEN`, `src/keymap.ts:218`) opens a chooser, "Docs: what
  the models are told" (`actions.docs()`, `src/components/actions.tsx:762`).
  It lists the eight docs, each with its one-line `DOC_PURPOSE`, and opens the
  chosen one in `$EDITOR` in an embedded terminal.
- The palette has `Edit <NAME>.md` entries too (`src/components/shell.tsx:136`).

What's missing: the chooser says what each doc is for in one line, but not who
reads it, when, the size limit, or whether my copy differs from the default.

## Want

A Docs screen (or a richer `D` modal) with a list on the left and a detail
pane on the right. For the selected doc, the detail pane shows:

- **Purpose:** what the doc is for, in two or three sentences.
- **Read by:** which models read it, and when (the table above).
- **Size:** the current length against each reader's `head()` limit, with a
  warning when text is being cut ("JOB.md: 3,100 chars; triage sees the first
  2,500").
- **State:** default, edited, or missing (falling back to the repo default).
- **Path:** the live file's path.

Keys:

- `enter` / `e`: open in `$EDITOR` (the existing `openEditor`).
- `r`: reset to the shipped default, after a confirm. This overwrites the file.
- `d`: diff my copy against the default.

## Notes

- Keep the help text next to the code. Grow `DOC_PURPOSE` into a record per
  doc (`purpose`, `readers`, `limit`) in `src/core/docs.ts`, and have
  `triage.ts`, `agents.ts`, `assistant.ts` and `advisor.ts` take their `head()`
  limits from it, so the screen can't drift from what the prompts do.
- LEARNED.md writes itself. Say so in its detail pane, and explain the
  `## Watching` section, which no model reads.
- SOUL.md outranks LEARNED.md (the current modal hint says so). Keep that line.
