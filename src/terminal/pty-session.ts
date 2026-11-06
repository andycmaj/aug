// A child process on a pseudo-terminal, for interactive kubectl commands
// (exec, edit) rendered inside a pane. Live sessions are killed when the app
// exits for any reason, including the terminal closing (SIGHUP), so no
// orphaned `kubectl exec` is left behind.

import type { Subprocess } from "bun";

const live = new Set<PtySession>();
let hooksInstalled = false;

function installExitHooks(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  const killAll = () => {
    for (const session of live) session.kill();
  };
  process.on("exit", killAll);
  process.on("SIGHUP", () => {
    killAll();
    process.exit(129);
  });
}

export interface PtySessionOptions {
  cols: number;
  rows: number;
  cwd?: string;
  env?: Record<string, string>;
  onData: (data: Uint8Array) => void;
  onExit: (code: number | null) => void;
}

export class PtySession {
  private proc: Subprocess;
  exitCode: number | null = null;
  running = true;
  // Bun still delivers buffered output after kill, when the owner has
  // already torn down what it feeds.
  private killed = false;

  constructor(command: string[], options: PtySessionOptions) {
    installExitHooks();
    this.proc = Bun.spawn(command, {
      cwd: options.cwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        ...options.env,
      },
      terminal: {
        cols: options.cols,
        rows: options.rows,
        data: (_terminal, data) => {
          if (!this.killed) options.onData(data);
        },
      },
    });
    live.add(this);
    void this.proc.exited.then((code) => {
      this.running = false;
      this.exitCode = code;
      live.delete(this);
      options.onExit(code);
    });
  }

  write(data: string): void {
    if (this.running) this.proc.terminal?.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.running) this.proc.terminal?.resize(cols, rows);
  }

  kill(): void {
    this.killed = true;
    if (this.running) this.proc.kill();
  }
}
