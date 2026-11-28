// jk or kj typed fast goes back to the rail; the first letter is
// held until the chord fires (dropped), breaks (replayed first) or times out
// (replayed).

import { expect, test } from "bun:test";
import {
  chordLetter,
  isRelease,
  RailChord,
  railChordKeys,
  RAIL_CHORD_DEFAULTS,
} from "../src/rail-chord";

function rig(ms = 40) {
  let now = 0;
  const out: string[] = [];
  const chord = new RailChord<string>(
    () => ({ chords: ["jk", "kj"], ms }),
    (b) => out.push(b),
    () => now,
  );
  const tick = (n: number) => {
    now += n;
  };
  // What the agent would get: replays, then the key itself when it passed.
  const press = (k: string) => {
    const fed = chord.feed(k, k);
    if (fed.step === "pass") {
      out.push(k);
    }
    return fed;
  };
  return { chord, out, tick, press };
}

test("j then k in time fires and the j never goes out", () => {
  const r = rig();
  expect(r.press("j").step).toBe("held");
  r.tick(10);
  expect(r.press("k")).toEqual({ step: "fire", held: "j" });
  expect(r.out).toEqual([]);
});

test("k then j fires too", () => {
  const r = rig();
  r.press("k");
  r.tick(10);
  expect(r.press("j").step).toBe("fire");
  expect(r.out).toEqual([]);
});

test("too slow: the held letter goes out before the next one", () => {
  const r = rig();
  r.press("j");
  r.tick(41);
  // k starts a chord of its own, so it is held in turn.
  expect(r.press("k").step).toBe("held");
  expect(r.out).toEqual(["j"]);
  r.chord.flush();
  expect(r.out).toEqual(["j", "k"]);
});

test("a letter that is not the second half replays the first, in order", () => {
  const r = rig();
  r.press("j");
  expect(r.press("x").step).toBe("pass");
  expect(r.out).toEqual(["j", "x"]);
});

test("jj: the first goes out, the second waits for its own chord", () => {
  const r = rig();
  r.press("j");
  expect(r.press("j").step).toBe("held");
  expect(r.out).toEqual(["j"]);
  expect(r.press("k").step).toBe("fire");
  expect(r.out).toEqual(["j"]);
});

test("a special or modified key breaks the chord and replays", () => {
  const r = rig();
  r.chord.feed("j", "j");
  expect(r.chord.feed(null, "\r").step).toBe("pass");
  expect(r.out).toEqual(["j"]);
});

test("the timer lets a lone letter go", async () => {
  const out: string[] = [];
  const chord = new RailChord<string>(
    () => ({ chords: ["jk"], ms: 20 }),
    (b) => out.push(b),
  );
  chord.feed("j", "j");
  expect(out).toEqual([]);
  await Bun.sleep(60);
  expect(out).toEqual(["j"]);
});

test("drop forgets the held letter", () => {
  const r = rig();
  r.press("j");
  r.chord.drop();
  r.chord.flush();
  expect(r.out).toEqual([]);
});

test("no chords: every key passes at once", () => {
  const out: string[] = [];
  const chord = new RailChord<string>(
    () => ({ chords: [], ms: 100 }),
    (b) => out.push(b),
  );
  expect(chord.feed("j", "j").step).toBe("pass");
  expect(chord.feed("k", "k").step).toBe("pass");
  expect(out).toEqual([]);
});

test("config: defaults, off, and only two-letter chords", () => {
  expect(railChordKeys(undefined)).toEqual(RAIL_CHORD_DEFAULTS);
  expect(railChordKeys({ railChord: [] }).chords).toEqual([]);
  expect(
    railChordKeys({ railChord: ["jk", "x", "abc"], railChordMs: 250 }),
  ).toEqual({ chords: ["jk"], ms: 250 });
  expect(railChordKeys({ railChordMs: -1 }).ms).toBe(RAIL_CHORD_DEFAULTS.ms);
});

test("chordLetter: plain letters only; a release is apart", () => {
  const key = (name: string, mods: Record<string, boolean> = {}) => ({
    name,
    ctrl: false,
    meta: false,
    shift: false,
    ...mods,
  });
  expect(chordLetter(key("j"))).toBe("j");
  expect(chordLetter(key("j", { ctrl: true }))).toBeNull();
  expect(chordLetter(key("j", { shift: true }))).toBeNull();
  expect(chordLetter(key("return"))).toBeNull();
  expect(isRelease({ ...key("j"), eventType: "release" })).toBe(true);
  expect(isRelease(key("j"))).toBe(false);
});
