# Session digests: the project journal and the story

Code: `core/digests.ts` (the digest, switches, redaction),
`core/journal.ts` (the file and the engine's tick), `core/story.ts`,
`core/digest-watcher.ts`. Tests: `packages/core/test/session-digests.test.ts`.

One record per finished agent session, made once, read twice:

- the **project journal**: a plain text file per project, newest first,
  one entry per finished session and one line per other task event;
- the **story**: a task's current state (goals, now, decisions,
  blocked, next steps, open questions), kept beside the owner's brief.

Both are off by default.


## Decisions

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

A row in `digests`:

    id, task_id, session_id, at
    by            agent | watcher
    outcome       ready | blocked | waiting | stopped
    goals         the task's goals as the agent left them (empty: unchanged)
    did           what changed, result first
    decisions     choices made and why
    learned       lines: surprises, gotchas, what to do differently
    next          next steps, one per line
    blocked       what waits on whom
    questions     open questions for the owner
    links         JSON: pr, branch, docs made (task links added this session)
    knowledge     JSON: hub ids made from learned lines
    covers_to     how far into the session's transcript it reaches (bytes)

Made by:

- `riker-tools done`, with optional flags, each given once per item:
  `--goal`, `--did`, `--decision`, `--learned`, `--next`, `--blocked`,
  `--question`, and `--outcome`. `--summary` stays required and is `did`
  when `--did` is left out. With both features off for the task, no
  digest is kept. The digest records how long the transcript was (from
  the Stop hook's `transcript_path`, kept on `sessions`).
- the watcher, when a coding session ends (SessionEnd; not a Riker
  restart) and `done` did not write up this run of it. A resumed session
  keeps its id, so "this run" is since its previous end. It reads the
  transcript past the furthest digest of the session, and goes on only
  when that part has an Edit, MultiEdit, Write, NotebookEdit or
  `git commit` call. It sends `digests.watcherModel` (haiku) the part as
  text (the owner's and the agent's words, one line per tool call with
  its file or command, never tool output), with no tools, gets the fields
  above as JSON, and records spend under the role `digest`. Past the
  daily spend cap it asks nothing.

The coding brief asks for the flags when either feature is on for the
task.


## The journal

    ~/.riker/projects/<project-slug>/journal.md        this month, status on top
    ~/.riker/projects/<project-slug>/journal/2026-10.md  older months
    ~/.riker/projects/<project-slug>/tasks/<REF>/        reserved: the task doc library

Written by the engine only (one process, no races), from `task_events`
behind its own cursor, the way action triggers are heard:

- `finished` (the agent's `done`): the full entry from its digest;
- `ended` (a coding session's end, on `sessions.ended_at`; the Wins
  history leaves it out): the watcher's digest as a full entry, or one
  line saying why there is none ("nothing changed", "the daily spend cap
  is reached");
- `created`, `merged`, `unmerged`, `done`, `dropped`, `later`, `reopened`:
  one line each.

A full entry, plain text, blank lines between parts:

    2026-11-22 14:05  RIKER-0042  Fix the CSV import  (agent)
    Outcome: ready for review

    Did: ...

    Learned:
    - ...
    - (Knowledge #31) ...

    Next:
    - ...

    Links: PR https://github.com/..., branch fix-csv-import, doc ...

The file is the owner's as much as Riker's. Riker owns only what lies
between its markers and writes only there:

    <!-- riker:status -->   rewritten each write: one line per open task
    <!-- /riker:status -->  in the project, from its latest digest
    <!-- riker:journal -->  new entries go in right after this line;
    ...                     entries already written are never rewritten
    <!-- /riker:journal -->

Each entry starts with `<!-- riker:entry YYYY-MM -->`. Text outside the
markers is never touched, nor is an entry's text once written. Markers
gone: Riker puts a new pair at the top and logs it. On the first write of
a month, entries of earlier months move out of the block, as written, into
`journal/<YYYY-MM>.md`. Files are written whole (a temp file, then a
rename), readable by the owner only.

On first write the journal is attached to its project as a doc
(`project_links`, a `file://` URL titled "Journal"), so every task brief
in the project names it and the Documents view lists it.


## The story

`stories`: one row per version (`task_id`, `digest_id`, `at`, `by`,
`goals`, `now`, `decisions`, `blocked`, `next`, `questions`, `pinned`);
the newest is current. The task's brief (`tasks.summary`) stays the
owner's text. A digest makes a new version; goals carry forward unless
the digest sets them.

`pinned` is the owner's lines (a goal or a next step). Every new version
copies them forward and shows them first; nothing drops them. The owner
pins and unpins with `riker-tools move pin <ref> "<line>" [--off yes]`,
which is also how the Assistant does it. `move story_undo <ref>` makes the
version before current again, as a new row, keeping the pins as they are.

Read by: the coding brief of a started, resumed or restarted agent (the
current version, before the turns); `riker-tools task` (and so the
Assistant, for a task the owner names); the Canvas, one line under the
task's header (pins, the next step, what blocks it); `I`, all of it.

## Reading them

`V` on a task's row or Canvas reads its story, and on a project's its
journal, as markdown over the Canvas (`ReaderModal`): j/k and space
scroll, c copies, e opens it in `$EDITOR` in the Canvas. The story is
`storyMarkdown`, a heading per part; in `$EDITOR` every part's heading is
there, and saving reads it back (`parseStory`) as a new version by the
owner, which `story_undo` steps back from. A line under no part is
refused, and the file is kept. The journal's `e` edits a copy, since the
engine may write an entry while it is open: saving lays the edit over the
file as it is then (`saveJournalEdit`, git merge-file), so both are kept.
An edit on the lines the engine wrote meanwhile (the newest entry, the
status block) writes nothing and keeps the copy, and the toast says where. The journal is written as
plain lines, which markdown would run together, so the reader shows it
through `journalMarkdown`: markers dropped, the title and `Now:` as
headings, a session's first line a heading, an event's line a list item.


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
config. `J` on a task's row or Canvas flips its story; on a project's,
its journal: an unset switch takes the opposite of what it follows. `I`
and `riker-tools task|project` say whether each is on and where that
comes from ("story: on (project)"). The moves set all three, `default`
clearing one: `riker-tools move story <ref> on|off|default` (ctrl+z
undoes it), `move journal <project> on|off|default`, and `--stories yes`
for the project's story default. A digest is made when either feature is
on for the task.


## Not built

A per-turn refresh of the story, the story on the rail line and in the
Wins and Inbox boards, publishing a copy of a journal as a claude.ai doc,
the per-task doc library (`tasks/<REF>/`), and re-reading the brief when
`move brief` changes it under a running agent.
