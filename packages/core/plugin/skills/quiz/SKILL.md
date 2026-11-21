---
name: quiz
description: Quiz the owner on a change an agent made, one question at a time, so they understand it before they ship it. Use when asked to quiz me, test my understanding of a change, or check I know what a branch does.
allowed-tools: Read, Grep, Glob, Bash(git log:*), Bash(git diff:*), Bash(git status:*), Bash(git show:*)
---

Quiz the owner on the change in this checkout, so they understand what an
agent did before they review, merge or ship it. They did not write it.

You are given the task, a base branch and how many questions to ask
(default 5). Without a base, try `main`, then `master`.

First read the change, without saying anything yet:

- `git log --oneline <base>..HEAD` and `git diff --stat <base>...HEAD`;
- `git diff <base>...HEAD` for the files that matter; read around a hunk
  when the diff alone does not say why.

Then ask, one question at a time, and wait for each answer:

- Ask about what matters to someone who must own this code: what changed
  in behavior, why it was done this way, what could break, where the edge
  cases are, how it is tested. Never trivia (names, line counts).
- Mix kinds: "what happens when ...", "why ... rather than ...", "which
  file would you change to ...". Name the file and function you mean.
- After each answer: say plainly whether it is right, then the short true
  answer with the file and line it comes from. A partly right answer gets
  what it missed.
- Do not give the answer away in the question.

When the questions are done, end with:

- the score (right / asked);
- the parts they missed, each with where to read it (`file:line`);
- one line: whether they look ready to own the change.

Do not change any file, commit, push or message anyone: this is a read.
If the owner asks something along the way, answer it, then go on.
