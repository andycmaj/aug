# Brain docs: updating, onboarding, evolution (AUG-0081)

Decided with the owner in four grilling rounds. AUG-0054 (core vs per-user
docs) is folded in here.

## The docs

Seven docs in `~/.aug/docs`, down from eight:

| Doc | Holds | Who writes it |
| --- | --- | --- |
| PERSONA.md | red lines that outrank everything, and how aug speaks to you | owner (onboarding drafts it) |
| JOB.md | what your job is; weighs importance | owner (onboarding drafts it) |
| STYLE.md | your voice in drafts sent for you | owner (onboarding drafts it) |
| TRIAGE.md | what makes a task, reply, watch, FYI | shipped |
| ASSISTANT.md | how a general agent works | shipped |
| CODING.md | how a coding agent works | shipped |
| LEARNED.md | lessons from corrections | aug, automatically |

SOUL.md becomes PERSONA.md and absorbs COUNSEL.md. Every doc stays a plain
file the owner can edit.

## Shipped updates: notify, never merge

No version history, no merge. Per doc, aug keeps one value in `kv`:
`doc.shipped.<NAME>` = hash of the shipped text it last saw.

On engine start, for each doc whose shipped text hash differs from the
stored one:

- File missing: write the shipped text.
- File equals the previously shipped text (never edited): replace it
  silently.
- File edited: leave it alone and open one SYSTEM task, "CODING.md: new
  shipped version". Keys: view (revdiff, your file vs shipped), take shipped,
  keep mine. Either answer closes it.

Then store the new hash, so each shipped change is announced once. A doc that
differs from the shipped text on the first run after this ships counts as
edited: one notice, no guessing at older shipped versions.

LEARNED.md is the exception. Its header and section list come from code
(`LEARNED_SECTIONS`). The header is rendered at prompt time, not stored. aug
adds a missing section and never touches a line.

## Safety net

Before any aug write to an existing doc (take shipped, an accepted proposal,
compaction, the rename migration), the old file is copied to
`~/.aug/docs/.trash/<NAME>.<stamp>.md`. That copy is never injected and is
pruned after 30 days. Restore by copying it back.

## SYSTEM tasks

`Kind.system` is a new task kind with its own rail section. It covers aug
asking about its own install: shipped updates you didn't get, the onboarding
offer, doc proposals, compaction. It is not AUG-MISC (coding work on aug).

A proposal's task carries the old and proposed text. Its view key opens
revdiff in the viewer on `git diff --no-index old new`, or the plain diff in
a pane when revdiff is missing. Annotations left in revdiff go back to the
drafter (Advisor or Assistant) as redraft feedback, and the proposal is
updated. Shipped-update notices ignore annotations. Accept writes the doc;
reject closes.

## Onboarding

Triggered on first run when PERSONA.md and JOB.md are both untouched
templates. Existing installs get a SYSTEM task offering it, never an
automatic start. It can be run again with a new `onboard` move.

Start runs the interview in Home with the Assistant:

1. It reads Slack and GitHub first, to pre-fill channels, teams and repos.
2. It asks only what it couldn't find: role, team, company; the channels and
   repos that matter; what is high priority; who you serve; red lines; tone
   and length.
3. It drafts PERSONA, JOB and STYLE as one SYSTEM proposal (one diff per
   doc), reviewed as above.

Skipping leaves the templates in place.

## Evolution

- LEARNED stays automatic. A lesson goes "in use" at strength 3 (was 4).
- Watching lines not seen for 30 days move to `LEARNED.archive.md` (why:
  stale). The archive sits beside the docs, is readable, and is never
  injected.
- Advisor gets a daily doc pass (once a day, on its 3-hour clock). It is
  skipped unless something is new since the last pass: a line went in use,
  or new corrections came in. It proposes edits to PERSONA, JOB and STYLE, at
  most one open proposal per doc, and a new pass updates the open one. An
  accepted proposal moves the LEARNED lines it absorbed to the archive.
- aug never proposes edits to shipped docs, because an edit would stop that
  doc's updates. A lesson that fits one becomes an AUG-MISC idea instead,
  e.g. "change shipped CODING.md to say X".

## Budgets

Character budgets, constants overridable in config:

| Doc | Budget |
| --- | --- |
| PERSONA | 1500 |
| JOB | 3000 |
| STYLE | 1000 |
| LEARNED in use | 3000 |
| TRIAGE | 2000 |
| CODING | 2000 |
| ASSISTANT | 2000 |

- Over 1x: the doc is still injected whole, and a SYSTEM task proposes a
  shrink. For LEARNED that means compacting, with dropped lines going to the
  archive.
- Over 2x: hard cut with a visible "(cut at budget)" note, as a cost guard.
- The Watching section counts toward no budget.

This replaces today's silent `head()` cuts of SOUL, JOB and STYLE.

## Rename migration (once)

1. Copy every doc to `.trash`.
2. Rename SOUL.md to PERSONA.md and append COUNSEL.md's text under a heading.
   Delete COUNSEL.md.
3. Rewrite the literal `SOUL.md` to `PERSONA.md` inside every doc. This is the
   one time aug edits owner text, and it changes only that name.

## Out of scope

- Doc history or diff UI.
- Syncing across machines (sync by hand if ever needed).
- Moving the prompts hardcoded in code (triage, learn, the brief template)
  into docs.
- A changelog for shipped doc changes; the diff is enough.

## Touches

- `core/docs.ts`: names, classes, budgets, the shipped-hash check, trash,
  LEARNED rendering.
- `core/install.ts` or the engine start: migration, shipped check.
- `core/types.ts`: `Kind.system`.
- `core/prompts.ts`: budgets.
- `core/learn.ts`: PROMOTE_AT, staleness.
- `core/advisor.ts`: the daily doc pass.
- `core/assistant.ts`: onboarding.
- `core/moves.ts`: `onboard`.
- `core/desk.ts`: accept, reject, take, keep.
- `components/`: System section, keys, revdiff view.
- `docs/defaults/`: PERSONA.md, drop SOUL and COUNSEL.
- README, AGENTS.md.

Tests in `test/` use `freshHome()` and `fakeBrain()`.
