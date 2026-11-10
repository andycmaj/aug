import { describe, expect, test } from "bun:test";
import { coalesce } from "../src/core/coalesce";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("coalesce", () => {
  test("a burst of schedules runs once", async () => {
    let runs = 0;
    const c = coalesce(() => runs++, 5);
    for (let i = 0; i < 50; i++) c.schedule();
    expect(runs).toBe(0);
    await tick(20);
    expect(runs).toBe(1);
  });

  test("a schedule after the run runs again", async () => {
    let runs = 0;
    const c = coalesce(() => runs++, 5);
    c.schedule();
    await tick(20);
    c.schedule();
    await tick(20);
    expect(runs).toBe(2);
  });

  test("flush runs a pending call now, and only once", async () => {
    let runs = 0;
    const c = coalesce(() => runs++, 5);
    c.schedule();
    c.flush();
    expect(runs).toBe(1);
    await tick(20);
    expect(runs).toBe(1);
  });

  test("flush with nothing pending does nothing", () => {
    let runs = 0;
    const c = coalesce(() => runs++, 5);
    c.flush();
    expect(runs).toBe(0);
  });

  test("cancel drops a pending call", async () => {
    let runs = 0;
    const c = coalesce(() => runs++, 5);
    c.schedule();
    c.cancel();
    await tick(20);
    expect(runs).toBe(0);
  });
});
