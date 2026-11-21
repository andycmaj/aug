import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { logger, resetLog } from "../src/log";
import { paths } from "../src/paths";
import {
  count,
  flushPerf,
  measure,
  openPerfDb,
  perfOn,
  perfReport,
  perfText,
  quantile,
  resetPerf,
  sample,
  startPerf,
  timing,
  BOUNDS,
} from "../src/perf";
import { readModel } from "../src/read-model";
import { freshHome } from "./support/helpers";

const on = { log: { enabled: true, level: "error" as const } };
const hourAgo = () => new Date(Date.now() - 3600_000);

afterEach(() => {
  resetPerf();
  resetLog();
});

describe("perf", () => {
  test("off with the log: nothing recorded, no file", () => {
    freshHome();
    resetPerf();
    expect(perfOn()).toBe(false);
    timing("x", 500);
    flushPerf();
    expect(existsSync(paths.perfDb())).toBe(false);
  });

  test("log.perf: false turns it off while the log is on", () => {
    freshHome({ log: { enabled: true, level: "info", perf: false } });
    resetPerf();
    expect(perfOn()).toBe(false);
  });

  test("count, p50, p95, max and total per op across flushes", () => {
    freshHome(on);
    resetPerf();
    for (let i = 1; i <= 100; i++) timing("mux.state", i);
    flushPerf();
    timing("mux.state", 400);
    timing("read.rail", 3);
    flushPerf();
    const report = perfReport({ since: hourAgo() });
    const state = report.rows.find((r) => r.op === "mux.state")!;
    expect(state.count).toBe(101);
    expect(state.max).toBe(400);
    expect(state.total).toBe(5050 + 400);
    // Bucketed: within the bucket the true value (51, 96) falls in.
    expect(state.p50).toBeGreaterThan(50);
    expect(state.p50).toBeLessThanOrEqual(100);
    expect(state.p95).toBeGreaterThan(50);
    expect(state.p95).toBeLessThanOrEqual(100);
    expect(report.procs).toBe(1);
    // Timings first, by time spent.
    expect(report.rows.map((r) => r.op)).toEqual(["mux.state", "read.rail"]);
  });

  test("slow examples: only past slowMs, the slowest few per op, slowest first", () => {
    freshHome({ log: { enabled: true, level: "error", slowMs: 100 } });
    resetPerf();
    timing("engine.reconcile", 99, { by: "tick" });
    for (const ms of [150, 900, 120, 300, 700, 200, 101])
      timing("engine.reconcile", ms, { by: "tmux" });
    flushPerf();
    const { slowest } = perfReport({ since: hourAgo() });
    expect(slowest.map((e) => e.ms)).toEqual([900, 700, 300, 200, 150]);
    expect(slowest[0]!.fields).toEqual({ by: "tmux" });
    expect(slowest[0]!.proc).toBe("riker");
  });

  test("an example keeps names and numbers, cut short", () => {
    freshHome(on);
    resetPerf();
    timing("x", 80, { tables: "t".repeat(200), reads: 3.14159, ok: true });
    flushPerf();
    const [e] = perfReport({ since: hourAgo() }).slowest;
    expect(e!.fields).toEqual({ tables: "t".repeat(64), reads: 3.1, ok: true });
  });

  test("the window leaves out older minutes and other ops", () => {
    freshHome(on);
    resetPerf();
    const db = openPerfDb();
    const buckets = JSON.stringify(
      new Array(BOUNDS.length + 1).fill(0).map((_, i) => (i === 3 ? 2 : 0)),
    );
    const old = new Date(Date.now() - 48 * 3600_000).toISOString().slice(0, 16);
    db.run(
      "INSERT INTO perf_minutes (minute, proc, pid, op, unit, count, total, max, buckets) VALUES (?, 'riker', 1, 'mux.state', 'ms', 2, 8, 5, ?)",
      [old, buckets],
    );
    timing("mux.state", 10);
    timing("read.rail", 10);
    flushPerf();
    const report = perfReport({ since: hourAgo(), op: "mux." }, db);
    expect(report.rows.map((r) => [r.op, r.count])).toEqual([["mux.state", 1]]);
    const wide = perfReport(
      { since: new Date(Date.now() - 72 * 3600_000), op: "mux." },
      db,
    );
    expect(wide.rows[0]!.count).toBe(3);
    expect(wide.procs).toBe(2);
  });

  test("counts and samples keep their units and leave no examples", () => {
    freshHome(on);
    resetPerf();
    count("bump.tasks", 3);
    sample("process.cpu", 2.5, "%");
    sample("process.cpu", 900, "%");
    flushPerf();
    const report = perfReport({ since: hourAgo() });
    expect(report.slowest).toEqual([]);
    const bump = report.rows.find((r) => r.op === "bump.tasks")!;
    expect([bump.unit, bump.count]).toEqual(["count", 3]);
    const cpu = report.rows.find((r) => r.op === "process.cpu")!;
    expect([cpu.unit, cpu.max, cpu.mean]).toEqual(["%", 900, 451.25]);
    const text = perfText(report);
    expect(text).toContain("process.cpu");
    expect(text).toContain("bump.tasks");
  });

  test("log.time feeds perf, numbers only", () => {
    freshHome(on);
    resetPerf();
    startPerf({ proc: "riker-tools" });
    const done = logger("engine").time("github poll", { text: "secret body" });
    done({ fresh: 2 });
    flushPerf();
    const report = perfReport({ since: hourAgo() });
    expect(report.rows.map((r) => r.op)).toEqual(["engine.github_poll"]);
  });

  test("read model reads are timed by name", () => {
    freshHome(on);
    resetPerf();
    const reads = readModel(() => {}, { isLive: () => false });
    measure("outer", () => reads.projects());
    flushPerf();
    const ops = perfReport({ since: hourAgo() }).rows.map((r) => r.op);
    expect(ops).toContain("read.projects");
    expect(ops).toContain("outer");
  });

  test("empty report says how to turn it on", () => {
    freshHome(on);
    resetPerf();
    expect(perfText(perfReport({ since: hourAgo() }))).toContain(
      "nothing recorded",
    );
  });
});

describe("quantile", () => {
  test("never past max, zero when empty", () => {
    const b = new Array(BOUNDS.length + 1).fill(0);
    expect(quantile(b, 0.5, 0)).toBe(0);
    b[BOUNDS.length] = 1; // past 30s
    expect(quantile(b, 0.95, 45_000)).toBeLessThanOrEqual(45_000);
    expect(quantile(b, 0.95, 45_000)).toBeGreaterThanOrEqual(30_000);
    const one = new Array(BOUNDS.length + 1).fill(0);
    one[6] = 1; // (20, 50]
    expect(quantile(one, 0.5, 30)).toBeLessThanOrEqual(30);
  });
});
