// One aug per home. Two on one home both drain the moves bus and both embed
// the same task windows, and two viewers of different sizes on one window
// is what hangs tmux 3.7's server (see mux.viewerMayHang).

import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { ensureHome, paths } from "./paths";

export type Claim = { ok: true } | { ok: false; pid: number };

type ClaimOptions = { pid?: number; alive?: (pid: number) => boolean };

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function holder(): number | null {
  try {
    const pid = Number(readFileSync(paths.lock(), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function claimHome(opts: ClaimOptions = {}): Claim {
  const pid = opts.pid ?? process.pid;
  const alive = opts.alive ?? pidAlive;
  ensureHome();
  // Exclusive create, so two starting at once cannot both win; a stale lock
  // (its aug crashed) is removed and the create tried once more.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(paths.lock(), "wx");
      writeSync(fd, `${pid}\n`);
      closeSync(fd);
      return { ok: true };
    } catch {
      const held = holder();
      if (held === pid) return { ok: true };
      if (held !== null && alive(held)) return { ok: false, pid: held };
      rmSync(paths.lock(), { force: true });
    }
  }
  const held = holder();
  return held === pid || held === null ? { ok: true } : { ok: false, pid: held };
}

export function releaseHome(pid = process.pid): void {
  if (holder() === pid) rmSync(paths.lock(), { force: true });
}
