import { describe, expect, test } from "bun:test";
import { LANE_META } from "../src/lanes";
import {
  foldConnector,
  LINK_FRAMES,
  LINK_MARKS,
  LINK_STILL,
  type Link,
  LinkPhase,
  LinkTracker,
  linkMark,
  motionOn,
  shortReason,
} from "../src/link-state";
import type { ConnectorStatus } from "../src/plugins";

// A clock and a timer queue the test moves by hand.
function fakeTime() {
  let now = 1_000;
  const pending: { at: number; fn: () => void; live: boolean }[] = [];
  return {
    now: () => now,
    schedule: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn, live: true };
      pending.push(t);
      return () => {
        t.live = false;
      };
    },
    advance(ms: number) {
      now += ms;
      for (const t of pending.filter((p) => p.live && p.at <= now)) {
        t.live = false;
        t.fn();
      }
    },
    armed: () => pending.filter((p) => p.live).length,
  };
}

function tracker(timeoutMs: number | null) {
  const time = fakeTime();
  const seen: Link[] = [];
  const t = new LinkTracker({
    timeoutMs,
    now: time.now,
    schedule: time.schedule,
    onChange: (l) => seen.push(l),
  });
  return { t, time, seen, phases: () => seen.map((l) => l.phase) };
}

describe("LinkTracker", () => {
  test("connecting, then connected, clears its timeout", () => {
    const { t, time, phases } = tracker(10_000);
    t.connecting();
    expect(t.link.phase).toBe(LinkPhase.connecting);
    expect(time.armed()).toBe(1);
    time.advance(3_000);
    t.connected();
    expect(time.armed()).toBe(0);
    time.advance(20_000);
    expect(phases()).toEqual(["connecting", "connected"]);
  });

  test("a connection that fails carries its short reason", () => {
    const { t, time, seen } = tracker(10_000);
    t.connecting();
    t.failed("exited 1\nstack trace that never fits");
    expect(t.link).toMatchObject({ phase: "failed", reason: "exited 1" });
    expect(time.armed()).toBe(0);
    expect(seen.map((l) => l.phase)).toEqual(["connecting", "failed"]);
  });

  test("a connection that never completes fails at its timeout", () => {
    const { t, time, phases } = tracker(15_000);
    t.connecting();
    time.advance(14_999);
    expect(t.link.phase).toBe(LinkPhase.connecting);
    time.advance(1);
    expect(t.link).toMatchObject({
      phase: "failed",
      reason: "no answer after 15s",
    });
    expect(phases()).toEqual(["connecting", "failed"]);
  });

  test("an answer after the timeout still connects", () => {
    const { t, time, phases } = tracker(5_000);
    t.connecting();
    time.advance(6_000);
    t.connected();
    expect(phases()).toEqual(["connecting", "failed", "connected"]);
  });

  test("connecting again keeps the first start and one timer", () => {
    const { t, time, seen } = tracker(5_000);
    t.connecting();
    time.advance(2_000);
    t.connecting();
    expect(seen).toHaveLength(1);
    expect(time.armed()).toBe(1);
    time.advance(3_000);
    expect(t.link.phase).toBe(LinkPhase.failed);
  });

  test("no timeout waits forever", () => {
    const { t, time } = tracker(null);
    t.connecting();
    expect(time.armed()).toBe(0);
    time.advance(10 * 60_000);
    expect(t.link.phase).toBe(LinkPhase.connecting);
  });

  test("dispose drops a pending timeout", () => {
    const { t, time, phases } = tracker(5_000);
    t.connecting();
    t.dispose();
    time.advance(10_000);
    expect(phases()).toEqual(["connecting"]);
  });
});

const status = (
  state: ConnectorStatus["state"],
  detail = "",
): ConnectorStatus => ({
  state,
  detail,
  at: null,
});

describe("a connector's status as a link", () => {
  function run(states: ConnectorStatus[]): LinkPhase[] {
    const { t, phases } = tracker(30_000);
    for (const s of states) {
      t.apply(s);
    }
    return phases();
  }

  test("first poll connects, a refresh poll stays connected", () => {
    expect(
      run([
        status("off", "not started"),
        status("polling"),
        status("ok", "3 new"),
        status("polling"),
        status("ok"),
      ]),
    ).toEqual(["off", "connecting", "connected"]);
  });

  test("a failed poll fails, a retry is connecting again", () => {
    expect(
      run([
        status("polling"),
        status("error", "gh: rate limited until 10:42"),
        status("polling"),
      ]),
    ).toEqual(["connecting", "failed", "connecting"]);
  });

  test("a poll that hangs fails at the timeout and recovers when it answers", () => {
    const { t, time, seen } = tracker(30_000);
    t.apply(status("polling"));
    time.advance(30_000);
    expect(t.link).toMatchObject({
      phase: "failed",
      reason: "no answer after 30s",
    });
    t.apply(status("ok"));
    expect(seen.map((l) => l.phase)).toEqual([
      "connecting",
      "failed",
      "connected",
    ]);
  });

  test("off says why", () => {
    expect(
      foldConnector(null, status("off", "disabled in config"), 0),
    ).toMatchObject({
      phase: "off",
      reason: "disabled in config",
    });
  });

  test("an unchanged status keeps the same link", () => {
    const first = foldConnector(null, status("ok"), 0);
    expect(foldConnector(first, status("ok"), 99)).toBe(first);
  });
});

describe("marks", () => {
  test("connecting animates through its frames, still without motion", () => {
    const link = { phase: LinkPhase.connecting };
    expect(LINK_FRAMES.map((_, i) => linkMark(link, i, true).mark)).toEqual([
      ...LINK_FRAMES,
    ]);
    expect(linkMark(link, 3, false).mark).toBe(LINK_STILL);
    expect(linkMark(link, 0, true).tone).toBe("info");
  });

  test("settled phases have one mark and tone each", () => {
    expect(linkMark({ phase: "connected" }, 2, true)).toEqual({
      mark: "●",
      tone: "success",
      word: "connected",
    });
    expect(linkMark({ phase: "failed" }, 2, true)).toEqual({
      mark: "✕",
      tone: "error",
      word: "failed",
    });
    expect(linkMark({ phase: "off" }, 2, true)).toEqual({
      mark: "○",
      tone: "muted",
      word: "off",
    });
  });

  test("no connecting mark is a rail mark or the working spinner", () => {
    const rail = new Set(
      Object.values(LANE_META).flatMap((m) => [m.mark, m.nerdMark ?? ""]),
    );
    const braille = (c: string) =>
      c.codePointAt(0)! >= 0x2800 && c.codePointAt(0)! <= 0x28ff;
    for (const mark of [
      ...LINK_FRAMES,
      LINK_STILL,
      LINK_MARKS.connected,
      LINK_MARKS.failed,
    ]) {
      expect(rail.has(mark)).toBe(false);
      expect(braille(mark)).toBe(false);
    }
  });

  test("a reason is one short line", () => {
    expect(shortReason("a".repeat(60))).toBe(`${"a".repeat(39)}…`);
    expect(shortReason("  \n")).toBeNull();
  });
});

describe("motion", () => {
  test("off in config, by RIKER_MOTION, and under bun test", () => {
    expect(motionOn({}, {})).toBe(true);
    expect(motionOn({ motion: false }, {})).toBe(false);
    expect(motionOn({}, { RIKER_MOTION: "0" })).toBe(false);
    expect(motionOn({}, { RIKER_MOTION: "off" })).toBe(false);
    expect(motionOn({}, { NODE_ENV: "test" })).toBe(false);
    expect(motionOn({ motion: true }, { RIKER_MOTION: "1" })).toBe(true);
  });
});
