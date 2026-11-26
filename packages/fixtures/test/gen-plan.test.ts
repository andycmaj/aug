import { describe, expect, test } from "bun:test";
import {
  answer,
  Ask,
  DEFAULT_LIMITS,
  openDue,
  plan,
  PrState,
  Verdict,
  type GenPr,
} from "../src/gen/plan";

// Local times, so the hours window reads as written.
const at = (h: number, day = 10) => new Date(2026, 10, day, h).toISOString();

function pr(over: Partial<GenPr> = {}): GenPr {
  return {
    number: 1,
    url: "https://github.com/lab/repo/pull/1",
    state: PrState.open,
    updatedAt: at(10),
    pushedAt: at(10),
    mine: null,
    repliedAt: null,
    ...over,
  };
}

describe("the generator answers the owner's review as an author would", () => {
  test("approved: it merges", () => {
    expect(
      answer(
        pr({ mine: { verdict: Verdict.approved, at: at(11) } }),
        new Date(at(12)),
      ),
    ).toEqual({
      type: "merge",
      pr: 1,
    });
  });

  test("changes asked: a follow-up, once per review", () => {
    const asked = pr({ mine: { verdict: Verdict.changes, at: at(11) } });
    expect(answer(asked, new Date(at(12)))).toEqual({
      type: "follow-up",
      pr: 1,
    });
    // Its follow-up pushed after the review: answered, it waits.
    expect(answer({ ...asked, pushedAt: at(12) }, new Date(at(13)))).toBeNull();
  });

  test("a comment review: one reply, no push", () => {
    const commented = pr({ mine: { verdict: Verdict.commented, at: at(11) } });
    expect(answer(commented, new Date(at(12)))).toEqual({
      type: "reply",
      pr: 1,
    });
    expect(
      answer({ ...commented, repliedAt: at(12) }, new Date(at(13))),
    ).toBeNull();
  });

  test("not reviewed yet: it waits, and closes after a week untouched", () => {
    expect(answer(pr(), new Date(at(12)))).toBeNull();
    expect(answer(pr(), new Date(at(11, 18)))).toEqual({
      type: "close",
      pr: 1,
    });
  });

  test("merged or closed: nothing", () => {
    expect(
      answer(
        pr({
          state: PrState.merged,
          mine: { verdict: Verdict.approved, at: at(11) },
        }),
        new Date(at(12)),
      ),
    ).toBeNull();
  });
});

describe("when it opens a new PR", () => {
  const clock = (h: number, lastOpened: string | null = null) => ({
    now: new Date(at(h)),
    lastOpened,
    nextAsk: Ask.team,
    hasTeam: true,
  });

  test("only inside its hours", () => {
    expect(openDue([], clock(8))).toBe(false);
    expect(openDue([], clock(9))).toBe(true);
    expect(openDue([], clock(18))).toBe(false);
  });

  test("at most every 30 minutes", () => {
    expect(
      openDue([], {
        ...clock(12),
        now: new Date(Date.parse(at(12)) + 29 * 60_000),
        lastOpened: at(12),
      }),
    ).toBe(false);
    expect(
      openDue([], {
        ...clock(12),
        now: new Date(Date.parse(at(12)) + 30 * 60_000),
        lastOpened: at(12),
      }),
    ).toBe(true);
  });

  test("never past five open", () => {
    const five = [1, 2, 3, 4, 5].map((n) => pr({ number: n }));
    expect(openDue(five, clock(12))).toBe(false);
    // One merging this tick frees a place.
    five[0] = pr({
      number: 1,
      mine: { verdict: Verdict.approved, at: at(11) },
    });
    expect(plan(five, clock(12)).map((m) => m.type)).toEqual(["merge", "open"]);
  });

  test("asks the team in turn, the owner when there is no team", () => {
    expect(plan([], clock(12))).toEqual([{ type: "open", ask: Ask.team }]);
    expect(plan([], { ...clock(12), hasTeam: false })).toEqual([
      { type: "open", ask: Ask.me },
    ]);
  });

  test("the defaults are the one-pager's", () => {
    expect(DEFAULT_LIMITS).toEqual({
      maxOpen: 5,
      everyMs: 1_800_000,
      hours: [9, 18],
      staleMs: 604_800_000,
    });
  });
});
