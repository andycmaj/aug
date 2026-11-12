# Home: one Assistant thread that runs aug

Status: built 2026-11-07 (steps 1-5). "Later" is open.

## Problem

I asked AUG-0003's agent to "create a new coding task to complete this in the
aug-bootstrap project". It couldn't. A general agent's only outlet is a
`DraftAction` (Slack reply, GitHub comment), it is never told projects exist,
and nothing it runs can make a task.

The Assistant is no better placed. It is a modal (`a`) whose history lives in
a signal, it answers in one `claude -p` call with no tools, and it moves things
by naming one of twelve verbs about the task "on the table". It can't look
something up and then act on it, and it can't make tasks or touch projects.

I want the Assistant to be the main way I drive aug: one thread, always there,
able to do anything I can do from the keyboard.

## Design

### Home thread

- **A singleton task, `kind: home`**, made on first boot. It reuses everything
  task chats have: turns, steps, files, `--resume`, persistence. It is never
  done, archived, walked by Next, counted, or shown on the Board.
- **First on the rail**, in a `home` section of its own.
- **`a` jumps there** from anywhere and focuses its input. The modal goes.
- **"On the table" goes away.** The Assistant can talk about any task. The
  input autocompletes `@AUG-` refs, fuzzy-matching titles, so I name the task
  I mean. Each turn carries a fresh snapshot: open work, projects with their
  repos, running agents.
- **Model:** `brain.assistantModel` (sonnet). Multi-step tool use needs it.

### Moves bus

`claude -p` tool calls run in a child process; the engine lives in the TUI.
The engine still makes every owner move, so tools ask it to:

- **Reads** (`aug-tools tasks`, `task show`, `projects`, `knowledge search`, `notes`)
  query the store directly.
- **Writes** insert a row in `moves` (verb, args JSON, who asked) and wait for
  it. The engine notices through `PRAGMA data_version`, runs the verb, and
  writes back `done` or `failed` with one line of result. The tool prints it,
  so the model sees what happened ("AUG-0012 created in aug-mvp", "no project
  aug-bootstrap; projects: aug-mvp").
- **One registry** (`core/moves.ts`): verb, help, arg parsing, and the engine
  call. The Assistant's prompt, `aug-tools`' help and the engine's dispatch all
  read it. The `askAssistant` switch and its `hands` go.
- **Moves that open a dialog today answer in words instead.** A coding task
  with no repo returns `needs repo: andycmaj/aug | ...`; the Assistant asks me
  in the thread and calls again with my answer.
- If no engine drains the move (aug isn't running), the tool times out and
  says so.

### Who may do what

| Move | Assistant | Task agents |
| --- | --- | --- |
| Read anything | yes | yes |
| Create tasks (any kind, in a project) | yes | yes |
| Edit, move, prioritize, remind | yes | own task |
| Start or stop agents | when asked | no |
| Archive a project, not-a-task, bulk done | confirms in the thread first | no |
| Send to Slack or GitHub | never: drafts, I press Send | never |

## Steps

1. **Bus.** `moves` table, `core/moves.ts` registry with today's verbs, engine
   drain, `aug-tools` write commands that enqueue and wait, read commands.
2. **New verbs.** Task new (kind, project, repo, `--from` parent, brief), set
   kind, move to project; project new, archive, list. `needs-*` answers.
3. **Home.** `kind: home` task, rail section, `a` jump, `@AUG-` autocomplete,
   Assistant turns over `--resume` with `Bash(aug-tools:*)`.
4. **Task agents** get the subset; AUG-0003's handoff works.
5. **Remove** `assistant-modal.tsx`, the verb switch, and `tableTaskId`.

## Later

- Advisor ideas and a morning brief post into Home.
- A coding task made `--from` another reports back to its parent on `done`.
