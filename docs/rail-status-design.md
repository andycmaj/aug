# Rail status model (AUG-0106)

One model for what a task's row says, before adding blocked-on-task
(AUG-0018), pending PR (AUG-0056), merged (AUG-0099), stopped vs saved
(AUG-0100), working / idle / waiting (AUG-0101) and Wins (AUG-0050). The
filter bar (AUG-0060) is already built; every lane below gets a pill or a
deliberate omission.

Four axes, each with one owner in the code:

| axis | what it answers | stored as | owner |
| --- | --- | --- | --- |
| 1. task lifecycle | where is the work in its life | `tasks.status` + facts (`pr_status`, `merged_at`, `task_blockers`) | `store` / `lifecycle.ts` |
| 2. agent state | what is its agent doing right now | `tasks.agent_state`, `sessions.state` | `lifecycle.ts` only |
| 3. rail grouping | where the row sits and what mark it wears | derived, never stored | `lanes.ts`, `rail.ts` |
| 4. task tagging | marks on a row that move nothing else | `priority`, `watching`, `wins`, project, goal | `desk.ts` |

Agent state lives inside the lifecycle: only a task that is open (or
later) has a live agent state worth showing. Done and dropped tasks keep
the last one as history (the table shows it), and the rail ignores it,
except an agent-closed task whose result is unread.

## Today

- `status`: open, later, done, dropped.
- `agent_state`: none, queued, working, blocked, saved, stopped, agentdone.
- `blocked` means "agent waiting on you", and the Stop hook sets it at the
  end of every turn ("is waiting at its prompt"), so every idle coding
  agent reads as asking you something. Claude's own idle notification
  ("Claude is waiting for your input") also lands as blocked.
- Esc in a coding agent fires no Stop hook, so the row stays `working`
  until the window goes. Nothing checks.
- `saved` is the owner's Stop (and close while live, and an adopted stray);
  `stopped` is everything else (crash, window gone, `/exit`, aug restart).
  Both resume the same way with `s`. `/exit` typed by the owner reads as
  stopped, so the split does not even track intent.
- `waiting_on` is free text ("waiting on them"); one task waiting on
  another is typed by hand and nothing links them.
- `pr_status` exists (checks, review, mergeable, state) and shows as a chip
  on the row, but no lane reads it.

## 1. Task lifecycle

`tasks.status` keeps its four values. An open task gets a **phase**,
derived from facts already stored, so nothing can go stale and no status
check elsewhere changes:

| phase | when | means |
| --- | --- | --- |
| open | open, none of the below | being worked, or on you |
| blocked | open, one or more rows in `task_blockers` | waits for other tasks to finish |
| review | open, its PR's last read is open or draft | in the PR loop: checks, review, merge |
| merged | open, `merged_at` set | landed; ready to clean up, not done |
| later | `status = later` | put away until `remind_at` |
| done | `status = done` | closed by you, or by its agent |
| dropped | `status = dropped` | not a task |

`phaseOf(task, facts)` in `lanes.ts`, first match: merged, review,
blocked, open.

### Blocked on another task (AUG-0018)

- Table `task_blockers(task_id, blocker_id, by, created_at)`, primary key
  both ids. A task may wait on several.
- Moves `block_on --on AUG-0012` and `unblock --on AUG-0012` (empty: all),
  in `AGENT_MOVES` so an agent can say it is stuck on another task. A task
  cannot block on itself or on a task that (transitively) waits on it.
- When a blocker is done or dropped (`lifecycle.taskClosed`,
  `workFinished` that closes, `notATask`, a dropped stray), one function
  `blockerResolved(id)` removes its rows and adds a turn on each dependent:
  "AUG-0012 done: <title>; nothing else blocks this" (or "still waits on
  AUG-0013"). That turn is the notification; the row leaving the blocked
  lane is the signal on the rail.
- Never slipped: the blocker's own row says how it is doing.
- `waiting_on` stays for people (theirs). The two are different lanes.

### Pending PR (AUG-0056)

- Derived from `pr_status` (already refreshed on the GitHub clock by
  `core/pr.ts`). Phase review while the last read of the task's current PR
  is open or draft. The row keeps its PR chip (what is in the way: conflict,
  ci, changes, review, ready), so the lane need not repeat it.
- A closed, unmerged PR is no phase: the task is open again.

### Merged (AUG-0099)

- New column `tasks.merged_at`. One lifecycle transition sets it,
  `workMerged(taskId, how)`, with a turn "merged (PR #12 / into main); ready
  to clean up". `mergeUndone(taskId)` clears it.
- Detection runs on the GitHub clock for open coding tasks with a branch:
  - PR: the current PR's state is merged (squash and rebase merges
    included: GitHub says so).
  - Local merge (the usual flow here: rebase, fast-forward local main):
    through the Mux, in the repo's checkout, base = `origin/HEAD`'s branch,
    else `main`. Merged when the branch has work (its tip is not the point
    it was created from, read from the branch's reflog) and either its tip
    is an ancestor of base, or a squash of it is already in base (`git
    commit-tree` of the branch's tree on the merge base, then `git cherry`
    base reports it `-`). No reflog and no PR: not checked.
- New commits on the branch after the merge (it is no longer merged by
  either test, or its task now points at a new open PR): `mergeUndone`, the
  task is open (or review) again. A revert in base is not detected: the
  branch is still in base. The owner reopens it with new work.
- Clean-up is the existing mark done (`x`): for a coding task it already
  kills the window and removes the worktree (`wt` keeps an unmerged branch,
  so a squash-merged one stays; fine). Nothing is cleaned without the
  owner's key. The footer says "clean up" for x on a merged row.
- Done stays the owner's (or the agent's `done`). Merged never closes.

## 2. Agent state

Only meaningful while the task is open or later. Seven values (same count
as today):

| state | mark | word | means | from |
| --- | --- | --- | --- | --- |
| none | | | no agent was ever asked | |
| queued | ◌ | waiting to start | held for Start, or behind the pool limit | `holdForStart`, `queued` |
| working | spinner | agent working | a turn is running | `prompt` hook, a chat turn starts |
| idle | ◇ | agent idle | turn over, at its prompt, not asking | `stop` hook, no question |
| waiting | ◆ | waiting on you | needs your answer: a question, a permission, a choice | AskUserQuestion, permission notification, a turn that ends asking |
| stopped | ■ | agent stopped | not running; `s` resumes it | any session end |
| agentdone | ✓ | agent finished | it said it is done | `aug-tools done`, a chat turn that answered |

### Changes

- **blocked is renamed waiting** (`AgentState.waiting`, value `waiting`,
  migrated). The word "blocked" now means only blocked on another task.
- **saved merges into stopped** (AUG-0100). Both resume the same way, and
  the split was not reliable (`/exit` read as a crash). Why it ended goes in
  a new `sessions.end_reason` ("you stopped it", "you closed the task",
  "its window closed", "claude exited", "aug restarted", "failed: ...");
  the table and the row's sub line show it. Migrated: `saved` -> `stopped`.
- **idle is new** (AUG-0101). Turns are bracketed by explicit signals:
  - start: `prompt` hook (UserPromptSubmit; typed by you or delivered by
    aug), any `tool` hook while not finished.
  - end: `stop` hook. It reads the last assistant message
    (`last_assistant_message` in the payload, else the transcript's tail):
    ending in a question is **waiting**, otherwise **idle**.
  - waiting: AskUserQuestion, a permission notification. Claude's idle
    notification ("waiting for your input", `notification_type:
    idle_prompt`) changes nothing: it is idle already.
- **Stale working is checked** (`turnCheck` on the engine's tmux clock):
  a tmux session working with no hook for 2 minutes reads the tail of its
  claude transcript (`~/.claude/projects/<cwd>/<session>.jsonl`). An
  interruption (`[Request interrupted by user`) or an assistant message
  that ended its turn means idle; a tool call with no result yet (a long
  test run) stays working. A window that is gone is stopped (reconcile, as
  today); at boot, `recoverAtBoot` as today.
- Chat agents (`claude -p`) have no idle: a turn ends finished or waiting.

### Transitions

```
none ──Start──> queued ──runs──> working <──prompt/tool── idle
                  │                │  │                    ^
                Stop               │  └──stop hook──────────┘ (no question)
                  v                │  └──stop hook / ask / permission──> waiting
               stopped <──end──────┤                                     │
                  │   (any session end, from any live state)   answer ───┘─> working
                  └──s (resume)──> working
working/idle/waiting ──aug-tools done──> agentdone (stays while it winds down)
agentdone ──new work lands──> none        any live ──task closed──> stopped
```

## 3. Rail grouping

### Lanes

A row's lane comes from both axes, first match wins. The order is the
rule: what needs you now, then what is moving, then where the work is,
then the agent at rest, then whose it is.

| # | lane | mark | tone | word | when |
| --- | --- | --- | --- | --- | --- |
| 1 | agentdone (done) | ✓ | success | agent finished | done, closed by its agent, unread |
| 2 | later | ◷ | muted | for later | status later |
| 3 | waiting | ◆ | warning | agent waiting on you | agent waiting |
| 4 | approve | ↑ | success | ready to send | a draft waits for Send |
| 5 | working | spinner ◐ | info | agent working | agent working |
| 6 | queued | ◌ | muted | waiting to start | agent queued |
| 7 | merged | » | success | merged, clean up | phase merged |
| 8 | review | ◎ | secondary | PR in review | phase review |
| 9 | blocked | ⊘ | muted | blocked by a task | phase blocked |
| 10 | idle | ◇ | secondary | agent idle | agent idle |
| 11 | stopped | ■ | muted | agent stopped | agent stopped |
| 12 | agentdone | ✓ | success | agent finished | agent finished, task open |
| 13 | watching | ○ | muted | watching | watching |
| 14 | theirs | → | muted | waiting on them | `waiting_on` set |
| 15 | yours / asked | • / ? | text / primary | on you / asked you | the rest |

`saved` and the old `blocked` lane go. The legend reads `LANE_META`, so it
follows. A blocked row's sub line names its blockers (`blocked by
AUG-0012`); a stopped row's says why it ended.

### Sections

Home, **Wins**, System, Tasks, Code Reviews, Watching, For later,
Advisor, FYI. Wins is walked first (`WALKED`).

### Filters

Nine pills, digits 1-9, `f` cycles, `0` clears. Lanes the owner reads as
one thing share a pill:

| key | pill | lanes |
| --- | --- | --- |
| 1 | asks ◆ | waiting |
| 2 | send ↑ | approve |
| 3 | working ◐ | working |
| 4 | idle ◇ | idle |
| 5 | stopped ■ | stopped, queued (not running: needs Start or Continue) |
| 6 | review ◎ | review |
| 7 | finished ✓ | agentdone, merged (ready for you to close) |
| 8 | open • | yours, asked |
| 9 | waiting → | blocked, theirs, watching, later |

Omitted on purpose: done (never on the rail, except as an unread
agentdone, which shares finished). To fit nine pills in the rail's 46
columns, a pill is `mark+count` with one space between pills.

A filter applies inside every section, Wins included. Project rows stay
when a task under them stays.

## 4. Task tagging

Marks that change neither lifecycle nor agent state:

- **priority** (urgent, important): the lower bar's color; urgent reddens
  the title. Unchanged.
- **watching**: moves the row to Watching. Unchanged.
- **slipped** (derived): a theirs row quiet 3 days; red bar. Never for
  blocked.
- **project, goal**: the project chip, nesting under the project row.
- **PR chip**: what is in the way on its PR. Shown in any lane.
- **Win** (AUG-0050), new:
  - Table `wins(day, task_id, pinned_at)`, primary key `(day, task_id)`;
    `day` is the owner's local date. At most 5 per day, enforced in
    `desk.win`.
  - Key `W` on a task row toggles it; move `win` (`--off yes` to unpin) for
    the Assistant. Not an agent move: Wins are the owner's focus.
  - A Win sits in the Wins section only (one row per key; it leaves Tasks,
    Code Reviews or Watching for the day), not nested under its project,
    with its project chip. It keeps its lane mark. A Win done today stays
    there with ✓ so the day's box shows progress; the heading says `Wins
    (2/5)`, done of pinned.
  - Tomorrow the box is empty and yesterday's open Wins are back in their
    sections. No carry-over.

## Implementation order

Each step lands with tests (`freshHome()`, `fakeBrain()`) and keeps the
filter bar's contract (every lane has a pill or is listed as omitted).

1. **Agent states** (AUG-0100, AUG-0101): migrate blocked -> waiting and
   saved -> stopped, `sessions.end_reason`, idle from the stop hook,
   question check, idle notification ignored, stale-working check. Board:
   idle gets a column.
2. **Lanes and filters**: new lane order, nine pills, legend, sub lines.
3. **Pending PR** (AUG-0056): phase review from `pr_status`.
4. **Merged** (AUG-0099): `merged_at`, `workMerged` / `mergeUndone`, PR and
   local detection through the Mux.
5. **Blocked on task** (AUG-0018): `task_blockers`, `block_on` / `unblock`,
   `blockerResolved`.
6. **Wins** (AUG-0050): `wins`, `W`, `win` move, the Wins section.
