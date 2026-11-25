import { describe, expect, test } from "bun:test";
import { mapLimit } from "../src/concurrent";

describe("mapLimit", () => {
  test("keeps the input's order, with at most limit calls out at once", async () => {
    let inFlight = 0;
    let most = 0;
    const got = await mapLimit([5, 1, 4, 2, 3, 0], 3, async (n) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await Bun.sleep(n);
      inFlight--;
      return n * 10;
    });
    expect(got).toEqual([50, 10, 40, 20, 30, 0]);
    expect(most).toBe(3);
  });

  test("the first error rejects the run, and nothing new starts after it", async () => {
    const started: number[] = [];
    const run = mapLimit([0, 1, 2, 3, 4, 5], 2, async (n) => {
      started.push(n);
      await Bun.sleep(1);
      if (n === 1) throw new Error("rate limited");
      return n;
    });
    expect(run).rejects.toThrow("rate limited");
    await run.catch(() => {});
    expect(started.length).toBeLessThan(6);
  });

  test("nothing to do is nothing", async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});
