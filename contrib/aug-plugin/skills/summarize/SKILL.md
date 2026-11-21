---
name: summarize
description: Summarize the work done so far on an aug task, for its owner. Use when asked what a task's agent has done, where the work stands, or for a recap of a task.
allowed-tools: Read, Grep, Glob, Bash(git log:*), Bash(git diff:*), Bash(git status:*), Bash(git show:*)
---

Write a short summary of the work done so far on the task you are given,
for its owner, who has not been watching. They read it in a terminal.

Use what you already know of the work (the conversation so far, when you
have one), then check it against the code when there is a checkout:

- `git log --oneline <base>..HEAD` for what was committed;
- `git diff --stat <base>...HEAD`, and `git status --short` for work not yet
  committed;
- read a file only to settle a point the diff leaves unclear.

The base is the one you were given; without one, try `main`, then `master`.

Answer with Markdown only, under 15 lines, in these parts, leaving out any
that would be empty:

- **Goal**: one line, what the task is for.
- **Done**: what changed, the result first (files, behavior), not the steps.
- **Decisions**: choices made and why, when they are not obvious.
- **Left**: what is still to do.
- **Blocked**: what waits on someone or something, and on what.

Plain words. No preamble, no closing offer. Do not change any file, commit,
push, or message anyone: this is a read.
