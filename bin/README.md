# bin

`aug` is the launcher for running aug from source. `bun dev` runs it, and
`package.json` names it as the package's `bin`, so `bun link` puts it on your
PATH.

It does two things a bare `bun run src/index.tsx` doesn't:

- **Runs from anywhere.** The TUI needs the Solid JSX preload
  (`--preload @opentui/solid/preload`) and the `browser` export condition, and
  the preload only resolves from the repo's `node_modules`. The script finds the
  repo from its own path and runs bun with `--cwd` set to it, so `aug` works
  from any directory.
- **Restarts aug after a fatal UI error.** Some failures leave the UI unable to
  draw, such as running out of opentui's native text buffers. When that happens
  `CrashGuard` asks for a fresh process and aug exits with code 75
  (`RESTART_CODE` in `src/core/restart.ts`). The script starts aug again. If aug
  asks more than three times within a minute, the script gives up and exits with
  that code. Any other exit code ends the script.

The compiled binary (`bun run compile`, written to `dist/aug`) doesn't use this
script. Its JSX is already transformed at build time, so it needs no preload,
but it doesn't restart itself on code 75.

aug-tools, which agents and hooks call, isn't here. It is
`src/bin/aug-tools.ts` and runs under plain `bun`, with no preload
(`src/core/self.ts`).
