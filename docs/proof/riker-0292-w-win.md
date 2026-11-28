# RIKER-0292: watching removed, w pins a Win

## Tests

- `packages/core/test/no-watching.test.ts`: an old database with a
  `tasks.watching` column and a watched task migrates to no column, the
  task open and listed in Tasks; no `watch` verdict, no `watch`/`unwatch`
  move. With the `DROP COLUMN` line taken out it fails (1 pass, 1 fail);
  with it, 2 pass.
- `packages/tui/test/rail-twins-render.test.tsx`, "w pins the row as
  today's Win, w again unpins it, and a full day says so": on the real
  TUI, `w` pins the row (listed under Wins, toast "is a Win today"), `w`
  again unpins it, and with 5 Wins `w` on another row pins nothing and
  toasts "Today has 5 Wins".
- `packages/triage/test/triage.test.ts`: a `watch` answer from the model
  is filed as FYI with no task.
- Full run: 1361 pass, 0 fail (1370 tests, 135 files). `bun run lint`
  and `bun run typecheck` clean. `bun run docs:keys` regenerated
  `docs/keyboard.html`.

## Live demo (tmux, `RIKER_MOTION=0 bun run demo`, scratch home)

`n` to "Bump pydantic to 2.9", `w`:

```
 ┃    ◆ 1  ...   RIKER-0011  Bum RIKER-0011 is a Win today (3/5)
 ┃  Wins (0/3)
 ┃ ▹   Bump pydantic to 2.9
 ┃ ▸   ★ Bump pydantic to 2.9
 ┃  f filter · e brief · s start · T jump · u nudge · d done · r later · w win · ? help
```

`w` again: toast "RIKER-0011 is no longer a Win today", Wins (0/2), the
row only in Tasks. `z` on the row: nothing (Wins stays 0/2).

`docs/architecture.html` through headless Chrome `--dump-dom`: renders,
no console errors, no watch/unwatch move rows.
