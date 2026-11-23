# Session digests: the project journal and the story

Status: draft spec, waiting on the owner's OK.

One record per finished agent session, made once, read twice:

- the **project journal**: a plain text file per project, newest first,
  one entry per finished session and one line per other task event;
- the **story**: a task's current state (goals, now, decisions,
  blocked, next steps, open questions), kept beside the owner's brief.

Both are off by default.


## Decisions (owner, 2026-11-22)

- Who writes a digest: the agent, as part of `riker-tools done`. A cheap
  watcher (haiku) writes one only for a session that changed something
  and ended without `done`, reading only the transcript since the last
  digest.
- The journal and the story are one piece of work: one digest
  feeds both, nothing is summarized twice.
- The journal lives under Riker's home, not in a repo.
- The journal records every task event.
- The story refreshes at the same moments as the journal (done and
  session end), not every turn.
- The story is versioned rows; the owner's brief is never rewritten.
- The journal rolls up by month, with a short status block at the top.
- A learning the agent marks general also goes to Knowledge, once.
- Config holds the defaults only. Turning either feature on or off for
  one project or task is data on that row, flipped from its Canvas or
  info view.


## The digest

A row in a new `digests` table:

    id, task_id, session_id, at
    by            agent | watcher
    outcome       ready | blocked | waiting | stopped
    did           what changed, result first
    decisions     choices made and why
    learned       lines: surprises, gotchas, what to do differently
    next          next steps, one per line
    blocked       what waits on whom
    questions     open questions for the owner
    links         JSON: pr, branch, docs made (task links added this session)
    knowledge     JSON: hub ids made from learned lines
    covers_to     byte offset in the session's transcript it read up to

Made by:

- `riker-tools done` with new optional flags, all repeatable where a list:
  `--did`, `--decision`, `--learned`, `--next`, `--blocked`, `--question`,
  `--outcome`. `--summary` stays required and is `did` when `--did` is
  left out. With both features off, the flags are accepted and ignored
  past the turn, so a brief can name them either way.
- the watcher, on a session that ended (SessionEnd, not a Riker restart)
  with no digest since its last one, when its transcript since then has an
  Edit, Write, NotebookEdit or `git commit` call. It sends haiku the
  slice as text (assistant words, tool names and short inputs, no tool
  output), with no tools, asks for the fields above as JSON, and records
  spend under a new role `digest`. Over the daily cap it skips and the
  journal gets a plain "session ended" line instead.

The coding brief's "When finished" line names the new flags when either
feature is on for the task.


## The journal

    ~/.riker/projects/<project-slug>/journal.md        this month, status on top
    ~/.riker/projects/<project-slug>/journal/2026-10.md  older months
    ~/.riker/projects/<project-slug>/tasks/<REF>/        reserved: the task doc library

Written by the engine only (one process, no races), from `task_events`
behind its own cursor, the way action triggers are heard:

- `finished` (the agent's `done`): the full entry from its digest;
- `ended` (a new task event, on `sessions.ended_at`): the watcher's digest
  as a full entry, or one line when the session changed nothing;
- `created`, `merged`, `done`, `dropped`, `reopened`: one line each.

A full entry, plain text, blank lines between parts:

    2026-11-22 14:05  RIKER-0178  Project journal: ...  (agent)
    Outcome: ready for review

    Did: ...

    Learned:
    - ...
    - (Knowledge #31) ...

    Next:
    - ...

    Links: PR https://github.com/..., branch project-journal-..., doc ...

The file is the owner's as much as Riker's. Riker owns only what lies
between its markers and writes only there:

    <!-- riker:status -->   rewritten each write: one line per open task
    <!-- /riker:status -->  in the project, from its latest digest
    <!-- riker:journal -->  new entries go in right after this line;
    ...                     entries already written are never rewritten
    <!-- /riker:journal -->

Text outside the markers is never touched. Markers gone: Riker puts a new
pair at the top and logs it. On the first write of a month, entries of
earlier months move out of the block into `journal/<YYYY-MM>.md`.

On first write the journal is attached to its project as a doc
(`project_links`, a `file://` URL titled "Journal"), so every task brief
in the project names it and the Documents view lists it.


## The story

A new `stories` table: one row per version (`task_id`, `digest_id`,
`at`, `by`, `goals`, `now`, `decisions`, `blocked`, `next`, `questions`,
`pinned`). `tasks.brief` stays the owner's text. A digest makes a new
version; goals carry forward from the last version unless the digest
changes them.

`pinned` is the owner's lines (a goal or a next step). Every new version
copies them forward and shows them first; nothing drops them. The owner
pins and unpins with a move (`riker-tools move pin RIKER-0178 "..."`,
`--off`), which is also how the Assistant does it.

Read by: the coding brief of a started, resumed or restarted agent (the
latest version, before the history it already gets); `riker-tools task`;
the Canvas, above the turns. Undo of a bad version is a move that makes
the previous version current again. The rail line, the Wins and Inbox
boards and a per-turn refresh come later.


## Knowledge

A `--learned` line written `knowledge:<topic>: <text>` also goes to
Knowledge (`addKnowledge`, author the agent), and the journal entry shows
`(Knowledge #id)` before it. The watcher does not make Knowledge.


## Privacy

Digests and journals stay under Riker's home. Their text is never logged
(log lines name ids only) and never sent anywhere but the watcher's own
haiku call. Before a digest is stored, obvious secrets are replaced with
`[redacted]`: GitHub, Slack, Anthropic, OpenAI and AWS token shapes,
private key blocks, and `password=`, `token=`, `secret=` values.


## Switches

Config holds only the defaults:

    "journal": { "enabled": false },
    "story":   { "enabled": false },
    "digests": { "watcherModel": "haiku" }

The overrides are data, beside the rows they switch: `projects.journal`,
`projects.story` (the default for the project's tasks) and `tasks.story`,
each on, off or unset (follow the level above). A task's story follows the
task, then its project, then config; a journal follows its project, then
config. The owner flips them where the row is shown: a key on a project's
or a task's Canvas and its info view, which says whether each is on and
where that comes from ("story: on (project)"). The same switch is a move
(`riker-tools move story RIKER-0178 --on|--off|--default`, `move journal
<project> ...`), so the Assistant can flip it too. A digest is made when
either feature is on for the task.


## First build (this task)

1. `digests` table, `done` flags, redaction; tests.
2. Journal writer in the engine: markers, entries, status block, month
   roll-up, `project_links` row, the `ended` task event; tests on a fresh
   home.
3. Knowledge lines.
4. Story rows, pins, the coding brief and `riker-tools task`
   showing them; the Canvas section.
5. The watcher, with a fake brain in tests and one real haiku check in a
   scratch home.

Left for later: per-turn refresh, rail line, Wins and Inbox boards,
publishing a copy as a claude.ai doc, the per-task doc library, the
`move brief` rule while an agent runs.
