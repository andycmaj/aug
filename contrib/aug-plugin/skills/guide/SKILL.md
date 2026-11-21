---
name: guide
description: Write a guided review of a branch's change, with review findings pinned to their lines, as Plannotator guide JSON. Use when asked for a guided review, a walkthrough of a change in chapters, or a review of an aug task's branch.
allowed-tools: Read, Grep, Glob, Bash(git log:*), Bash(git diff:*), Bash(git status:*), Bash(git show:*), Bash(git merge-base:*)
---

Write a guided review of the change in this checkout, for the owner, who
reads it in Plannotator beside the diff. It does two jobs in one: it orders
the change into chapters a reviewer reads in one sitting, and it carries
your review: the problems you found, each pinned to its lines.

You are given the task, a base branch and maybe a pull request. Without a
base, try `main`, then `master`.

## Read

When you are given a diff file, that file is the change: read all of it
(in parts if it is long) and skip step 1's git commands. Its hunk lines
carry their old and new line numbers in two columns: those are the numbers
for notes, not the line numbers of the file itself. Run one plain
command per Bash call, no chaining or shell variables.

1. `git merge-base <base> HEAD`, then `git diff <merge-base>`: that diff
   (it includes uncommitted edits) is what the guide describes, plus new
   files not yet added (`git status --short` lists them as `??`; read
   them too). Read it once, carefully. It is your main and usually only
   source.
2. `git log --oneline <merge-base>..HEAD` for intent. A pull request's
   description, when you were given one and can read it.
3. A few targeted reads only, each answering a question you can name: a
   definition the diff calls, one call site. Do not explore the repository.

## Chapters

- Order by importance: the heart of the change first, then what follows
  from it (call sites, tests with the code they test), glue last (wiring,
  imports, renames, config) in one plainly named chapter.
- A chapter is one logical change, not a file: three files changed for one
  reason are one chapter; one file with two unrelated changes is two.
- Typically 2 to 6 chapters, never more than 10. One is fine for a small
  change.
- `title`: the concept ("Retry policy for webhooks"), never a file name.
- `overview`: Markdown, 2 to 6 sentences: what changed, why (decisions the
  diff cannot show), and what it implies for behavior. Say plainly which
  chapter deserves the closest read.
- Each file of the diff appears exactly once: in one chapter's `diffs`, or
  in `unplacedFiles`. Paths copied exactly from the diff.
- `summary` per file: 1 or 2 sentences on what this file's change does.

## Review notes

Then review the change as a careful senior engineer would: bugs, missed
edge cases, broken contracts, missing tests for new behavior, risky
changes, security problems. For each real finding, add a note on the file
it is in:

- `{ "lineStart": 42, "lineEnd": 44, "text": "..." }`, with line numbers
  of the new file from the diff's hunk headers, inside one hunk; add
  `"side": "old"` for removed lines.
- `text`: one or two sentences, at most 1000 characters. Start with how
  much it matters, `Bug:`, `Risk:`, `Test:` or `Nit:`, then what is wrong
  and what to do.
- Only findings that hold up when you check them against the code. No
  praise, no style preferences, no notes that restate the diff. A change
  with nothing wrong gets no notes: that is a fine result.
- At most 20 notes per file.

## Voice

Plain words, short sentences, code names in backticks. No em dashes, no
emoji, no selling words ("elegant", "robust").

## Answer

Answer with one JSON object only, in a ```json fence, nothing before or
after:

```json
{
  "title": "one line",
  "intent": "1 or 2 sentences: why this change exists",
  "sections": [
    {
      "title": "...",
      "overview": "...",
      "diffs": [
        { "file": "src/x.ts", "summary": "...",
          "notes": [{ "lineStart": 12, "lineEnd": 12, "text": "Bug: ..." }] }
      ]
    }
  ],
  "unplacedFiles": []
}
```

Do not change any file, commit, push or message anyone: this is a read.
