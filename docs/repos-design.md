# Repos and checkouts (AUG-0094)

## Today

- `config.github.repos` maps `owner/repo` to one path. Hand-edited, or set
  once by the "Where is X checked out?" prompt (`mapRepo`) or `move start
  --repo --path`.
- `projects.repos` (SQLite) lists a project's repos by name. Set when a
  project is made with one, and when a task's worktree is made.
- Checks before a start: `driver.ts` only asks "is there a mapping";
  `projects.startTask` also runs `git rev-parse --git-dir` (`isCheckout`) and
  asks for a path again if it fails. Nothing checks the remote, so a path
  that is a git repo but the wrong one (or a linked worktree) goes straight
  to `wt`, and its stderr is the error the owner sees.
- On this machine: `andycmaj/codediff` maps to `codediff.nvim`, whose origin
  is `andycmaj/codediff.nvim`; `andycmaj/beanstream` is a project repo with
  no mapping, and its checkout has no `origin`. Sibling worktrees
  (`riker.<branch>`) sit next to their checkouts.

## Design (as built)

Owner's calls: a checkout of another repo asks (rename, use anyway, another
path); nothing is ever mapped without the owner picking it; all five parts
in one go.

### One module, config the only store

`core/repos.ts` is the door. Config keeps the owner's choice, one path per
repo in the same `github.repos` shape, so hand edits keep working. What is
on disk is scanned on demand (kept a minute in memory), not cached in
SQLite: a scan of ~/workspace is plain `readdir`s and `.git/config` reads
(`core/checkouts.ts`, behind the Mux like every other git touch, so tests
fake it). "Use anyway" for a mismatched checkout is a `kv` entry.

### Discovery

- `config.repoRoots`, default `~/workspace ~/src ~/code ~/projects ~/dev
  ~/git` (those that exist), 3 folders deep. The first is where Clone goes.
- A checkout is a dir whose `.git` is a directory. `.git` as a file (a
  linked worktree) is skipped; `node_modules`, dot dirs and a few build dirs
  are not entered; a checkout is not descended into.
- Remotes from `.git/config`: origin, then upstream, then the rest; https,
  ssh, `git@` and ssh host aliases (`github-work:`). A checkout with no
  GitHub remote is offered for a repo only by folder name, marked as such.

### Validation (`checkPath`, before every worktree)

missing, not-git, worktree (names its main), inside (names its top),
mismatch (names the remotes), or fine. No GitHub remote is fine. A fork
matches by any remote. `mapRepo` refuses all but mismatch, so a bad path is
never saved; mismatch is saved and the next Start asks.

`needs: path` carries the problem, the candidates on disk and where Clone
would put it. The TUI shows one choice list: rename / use anyway (mismatch),
the worktree's main, found checkouts, Clone, Type a path, Scratch. The
`start` move answers the same in words and takes `--path`, `--clone yes`,
`--rename owner/repo`, `--anyway yes`.

### Moved or deleted

A task whose worktree folder is gone gets it cleared and a line on its
thread; Start makes it again on the same branch. A mapped checkout that is
gone is a `missing` problem with the found checkouts offered first.

### Managing it

- `riker-tools repos [--scan]`: every repo (mapped or in a project), its path
  and state, its projects, other checkouts; then GitHub checkouts on disk
  with no path, the owner's own first.
- `move repo <owner/repo> [--path] [--clone yes] [--rename] [--anyway yes]
  [--remove yes]`; `project_repo --remove yes`. Not agent moves.
- TUI: `R` on the Board ("repos"): the list above; pick a repo for its
  choices, a `+` checkout to add it, or look on disk again. The project file
  (`e` on a project) has `## Repos`: `- owner/repo  ~/path` lines in order,
  a bad path's problem as a comment; saving sets the project's list and any
  changed path (validated).
