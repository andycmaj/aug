// Two letters typed fast (jk or kj, like vim's jk-to-escape) take you back to
// the rail from the chat box or an attached agent. The first letter of a
// chord is held: an agent gets it only once the chord has timed out or the
// next key is not its second half, so a chord never reaches the agent; the
// chat box types it at once and takes it back out when the chord fires.

import type { KeysConfig } from "@riker/core/config";

export interface RailChordKeys {
  chords: string[];
  ms: number;
}

export const RAIL_CHORD_DEFAULTS: RailChordKeys = {
  chords: ["jk", "kj"],
  ms: 180,
};

// Only two-letter chords count; [] turns it off.
export function railChordKeys(keys: KeysConfig | undefined): RailChordKeys {
  const chords = (keys?.railChord ?? RAIL_CHORD_DEFAULTS.chords).filter(
    (c) => c.length === 2,
  );
  const ms = keys?.railChordMs;
  return {
    chords,
    ms: typeof ms === "number" && ms > 0 ? ms : RAIL_CHORD_DEFAULTS.ms,
  };
}

interface KeyLike {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  option?: boolean;
  super?: boolean;
  eventType?: string;
}

// A key's release (kitty protocol) neither starts nor breaks a chord.
export const isRelease = (k: KeyLike) => k.eventType === "release";

// The plain letter a key types, or null for anything modified or special.
export function chordLetter(k: KeyLike): string | null {
  if (k.ctrl || k.meta || k.shift || k.option || k.super) {
    return null;
  }
  return k.name.length === 1 ? k.name : null;
}

// fire: the chord is done, and `held` is what its first letter carried.
export type ChordStep<T> =
  | { step: "fire"; held: T }
  | { step: "held" }
  | { step: "pass" };

// `T` is what was held with the first letter (an agent's bytes); `replay`
// gets it back, in order, when it turns out not to be a chord: before
// `feed` returns, or on the timer.
export class RailChord<T> {
  private held: { letter: string; payload: T; at: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly keys: () => RailChordKeys,
    private readonly replay: (payload: T) => void,
    private readonly now: () => number = Date.now,
  ) {}

  feed(letter: string | null, payload: T): ChordStep<T> {
    const { chords, ms } = this.keys();
    const held = this.held;
    this.clear();
    const at = this.now();
    if (held && letter && at - held.at <= ms) {
      if (chords.includes(held.letter + letter)) {
        return { step: "fire", held: held.payload };
      }
    }
    if (held) {
      this.replay(held.payload);
    }
    if (letter && chords.some((c) => c[0] === letter)) {
      this.held = { letter, payload, at };
      this.timer = setTimeout(() => this.flush(), ms);
      return { step: "held" };
    }
    return { step: "pass" };
  }

  // Lets a held letter go now (focus moved on, the host unmounted).
  flush(): void {
    const held = this.held;
    this.clear();
    if (held) {
      this.replay(held.payload);
    }
  }

  // Forgets a held letter without replaying it.
  drop(): void {
    this.clear();
  }

  private clear(): void {
    this.held = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
