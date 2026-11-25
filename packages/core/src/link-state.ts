// A connection as the owner sees it: connecting (still in progress, drawn
// animated so a slow one never reads as a hang), connected, or failed with a
// short reason; off when it is not meant to run. Every place Riker connects
// to something (the pollers' status lines, an embedded agent's terminal)
// keeps one of these and draws it through the TUI's one LinkMark, so they
// all look the same. A connection that never answers turns failed on its
// own after its timeout, and back to connected if the answer comes late.

import type { RikerConfig } from "./config";
import { envVar } from "./brand";
import type { Tone } from "./lanes";
import type { ConnectorStatus } from "./plugins";

export const LinkPhase = {
  off: "off",
  connecting: "connecting",
  connected: "connected",
  failed: "failed",
} as const;
export type LinkPhase = (typeof LinkPhase)[keyof typeof LinkPhase];

export interface Link {
  phase: LinkPhase;
  // Why it failed or is off, short enough for a status line.
  reason: string | null;
  // When this phase began (ms), so a connecting one knows how long it has
  // waited.
  since: number;
}

// The animation's frames and the marks of the settled phases. None of them
// is a rail mark (LANE_META) or the working spinner's braille, so a
// connection never reads as a task's state; tested in link-state.test.ts.
export const LINK_FRAMES = ["◜", "◝", "◞", "◟"] as const;
// Connecting with motion off (reduced motion, tests, a tmux capture).
export const LINK_STILL = "⋯";
export const LINK_MARKS: Record<Exclude<LinkPhase, "connecting">, string> = {
  off: "○",
  connected: "●",
  failed: "✕",
};
// Low on purpose: a quarter turn every 200ms reads as moving and costs five
// redraws a second, only while something is connecting and on screen.
export const LINK_FRAME_MS = 200;

const TONES: Record<LinkPhase, Tone> = {
  off: "muted",
  connecting: "info",
  connected: "success",
  failed: "error",
};

export function linkMark(
  link: Pick<Link, "phase">,
  frame: number,
  motion: boolean,
): { mark: string; tone: Tone; word: LinkPhase } {
  const mark =
    link.phase === LinkPhase.connecting
      ? motion
        ? LINK_FRAMES[frame % LINK_FRAMES.length]
        : LINK_STILL
      : LINK_MARKS[link.phase];
  return { mark, tone: TONES[link.phase], word: link.phase };
}

const REASON_MAX = 40;

// The first line of a detail, cut to fit a status line.
export function shortReason(detail: string | null | undefined, max = REASON_MAX): string | null {
  const line = (detail ?? "").split("\n")[0].trim();
  if (!line) return null;
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

// Motion is on unless config's `motion` is false, RIKER_MOTION is 0/off, or
// this is a test run: those get the still mark, so a snapshot or a tmux
// capture reads the same every time.
export function motionOn(
  config: Pick<RikerConfig, "motion">,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (config.motion === false) return false;
  const flag = envVar("MOTION", env)?.toLowerCase();
  if (flag === "0" || flag === "off" || flag === "false") return false;
  return env.NODE_ENV !== "test";
}

// A connector's status (core/plugins.ts) as a link. A poll on a line that is
// already connected is a refresh, not a reconnect, so it stays connected; a
// poll after a failure or before any answer is connecting.
export function foldConnector(prev: Link | null, status: ConnectorStatus, now: number): Link {
  const at = (phase: LinkPhase, reason: string | null): Link =>
    prev && prev.phase === phase && prev.reason === reason ? prev : { phase, reason, since: now };
  switch (status.state) {
    case "off":
      return at(LinkPhase.off, shortReason(status.detail));
    case "ok":
      return at(LinkPhase.connected, null);
    case "error":
      return at(LinkPhase.failed, shortReason(status.detail) ?? "failed");
    case "polling":
      if (prev?.phase === LinkPhase.connected) return prev;
      return prev?.phase === LinkPhase.connecting ? prev : { phase: LinkPhase.connecting, reason: null, since: now };
  }
}

type Cancel = () => void;

export interface LinkTrackerOptions {
  // Connecting longer than this reads failed; null waits forever.
  timeoutMs: number | null;
  onChange: (link: Link) => void;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => Cancel;
}

const realSchedule = (fn: () => void, ms: number): Cancel => {
  const t = setTimeout(fn, ms);
  return () => clearTimeout(t);
};

export function seconds(ms: number): string {
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${(ms / 1000).toFixed(1)}s`;
}

// One connection's link over time. Its only timer is the timeout, armed
// while connecting and cleared on any change, so a settled link costs
// nothing.
export class LinkTracker {
  private current: Link;
  private cancel: Cancel | null = null;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void, ms: number) => Cancel;

  constructor(private readonly options: LinkTrackerOptions) {
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? realSchedule;
    this.current = { phase: LinkPhase.off, reason: null, since: this.now() };
  }

  get link(): Link {
    return this.current;
  }

  connecting(): void {
    if (this.current.phase === LinkPhase.connecting) return;
    this.set({ phase: LinkPhase.connecting, reason: null, since: this.now() });
  }

  connected(): void {
    this.set({ phase: LinkPhase.connected, reason: null, since: this.now() });
  }

  failed(reason: string): void {
    this.set({ phase: LinkPhase.failed, reason: shortReason(reason) ?? "failed", since: this.now() });
  }

  off(reason: string | null = null): void {
    this.set({ phase: LinkPhase.off, reason: shortReason(reason), since: this.now() });
  }

  // A connector's status, folded as foldConnector does.
  apply(status: ConnectorStatus): void {
    this.set(foldConnector(this.current, status, this.now()));
  }

  dispose(): void {
    this.disarm();
  }

  private set(next: Link): void {
    if (next === this.current) return;
    const same = next.phase === this.current.phase && next.reason === this.current.reason;
    if (next.phase !== LinkPhase.connecting || this.current.phase !== LinkPhase.connecting) this.disarm();
    this.current = next;
    if (next.phase === LinkPhase.connecting && !this.cancel) this.arm();
    if (!same) this.options.onChange(next);
  }

  private arm(): void {
    const timeout = this.options.timeoutMs;
    if (timeout === null) return;
    this.cancel = this.schedule(() => {
      this.cancel = null;
      if (this.current.phase === LinkPhase.connecting) this.failed(`no answer after ${seconds(timeout)}`);
    }, timeout);
  }

  private disarm(): void {
    this.cancel?.();
    this.cancel = null;
  }
}
