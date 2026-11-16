// What is slow in real use, measured where it happens. Each op (a read, a
// tmux call, a poll) keeps a per-minute histogram in memory; a timing at or
// past log.slowMs also keeps an example (the slowest few per op per minute).
// Once a minute, and at exit, they go to perf.db under AUG_HOME, and
// `aug-tools perf` reads them back as p50/p95/max per op.
//
// Rides on the log: off unless it is on (core/log.ts), and then off again
// with log.perf: false. Off, every call is one boolean check. Names and
// numbers only: an op is a fixed name, and an example's fields are numbers,
// booleans and short names (a table, a verb), never a task's or a message's
// text.
//
// perf.db is its own file so a flush never moves aug.db's data_version,
// which would wake the TUI's refresh and the engine's moves drain.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logGeneration, logOn, logSection, setTimingSink } from "./log";
import { paths } from "./paths";

export type PerfFields = Record<string, string | number | boolean>;

// What a row's values are: ms for timings (these keep slow examples), a
// plain count, or a sample in its own unit (%, MB, cells).
export type PerfUnit = string;

const DEFAULT_SLOW_MS = 50;
const EXAMPLES_PER_OP = 5;
const FLUSH_MS = 60_000;
const KEEP_DAYS = 14;
const MAX_NAME = 64;

// Upper bounds of the histogram's buckets; the last bucket is past them all.
export const BOUNDS = [
  0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10_000, 30_000,
] as const;

interface Agg {
  unit: PerfUnit;
  count: number;
  total: number;
  max: number;
  buckets: number[];
}

interface Example {
  at: string;
  op: string;
  ms: number;
  fields: PerfFields;
}

let enabled: boolean | undefined;
let readAt = -1;
let slowMs = DEFAULT_SLOW_MS;
let proc = "aug";
let windowStart = minuteOf(new Date());
const aggs = new Map<string, Agg>();
const examples = new Map<string, Example[]>();
let db: Database | null = null;
let flushTimer: ReturnType<typeof setInterval> | null = null;

function minuteOf(at: Date): string {
  return at.toISOString().slice(0, 16);
}

function readSettings(): void {
  readAt = logGeneration();
  try {
    const section = logSection();
    enabled = logOn() && section.perf !== false;
    slowMs = section.slowMs ?? DEFAULT_SLOW_MS;
  } catch {
    enabled = false;
  }
}

export function perfOn(): boolean {
  if (enabled === undefined || readAt !== logGeneration()) readSettings();
  return enabled === true;
}

function bucketOf(value: number): number {
  for (let i = 0; i < BOUNDS.length; i++) if (value <= BOUNDS[i]!) return i;
  return BOUNDS.length;
}

function add(op: string, value: number, unit: PerfUnit): void {
  let agg = aggs.get(op);
  if (!agg) {
    agg = {
      unit,
      count: 0,
      total: 0,
      max: 0,
      buckets: new Array<number>(BOUNDS.length + 1).fill(0),
    };
    aggs.set(op, agg);
    ensureFlushing();
  }
  agg.count++;
  agg.total += value;
  if (value > agg.max) agg.max = value;
  agg.buckets[bucketOf(value)]!++;
}

function clean(fields: PerfFields | undefined): PerfFields {
  const out: PerfFields = {};
  if (!fields) return out;
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "number") out[k] = Math.round(v * 10) / 10;
    else if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "string") out[k] = v.slice(0, MAX_NAME);
  }
  return out;
}

function keepExample(
  op: string,
  ms: number,
  fields: PerfFields | undefined,
): void {
  const list = examples.get(op) ?? [];
  if (list.length >= EXAMPLES_PER_OP && ms <= list[list.length - 1]!.ms) return;
  list.push({ at: new Date().toISOString(), op, ms, fields: clean(fields) });
  list.sort((a, b) => b.ms - a.ms);
  if (list.length > EXAMPLES_PER_OP) list.length = EXAMPLES_PER_OP;
  examples.set(op, list);
}

// A duration in ms.
export function timing(op: string, ms: number, fields?: PerfFields): void {
  if (!perfOn()) return;
  add(op, ms, "ms");
  if (ms >= slowMs) keepExample(op, ms, fields);
}

const NOOP = (): void => {};

// Starts a timing; call the result when the work ends.
export function perfStart(
  op: string,
  fields?: PerfFields,
): (end?: PerfFields) => void {
  if (!perfOn()) return NOOP;
  const started = performance.now();
  return (end) =>
    timing(
      op,
      performance.now() - started,
      end ? { ...fields, ...end } : fields,
    );
}

export function measure<T>(op: string, fn: () => T, fields?: PerfFields): T {
  if (!perfOn()) return fn();
  const started = performance.now();
  try {
    return fn();
  } finally {
    timing(op, performance.now() - started, fields);
  }
}

export async function measureAsync<T>(
  op: string,
  fn: () => Promise<T>,
  fields?: PerfFields,
): Promise<T> {
  if (!perfOn()) return fn();
  const started = performance.now();
  try {
    return await fn();
  } finally {
    timing(op, performance.now() - started, fields);
  }
}

// How often something happened (a table bump, a tmux event).
export function count(op: string, n = 1): void {
  if (!perfOn()) return;
  for (let i = 0; i < n; i++) add(op, 0, "count");
}

// A value in its own unit (CPU %, MB, cells per frame, reads per refresh).
export function sample(op: string, value: number, unit: PerfUnit): void {
  if (!perfOn()) return;
  add(op, value, unit);
}

// ── storage ────────────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS perf_minutes (
  minute TEXT NOT NULL,
  proc TEXT NOT NULL,
  pid INTEGER NOT NULL,
  op TEXT NOT NULL,
  unit TEXT NOT NULL,
  count INTEGER NOT NULL,
  total REAL NOT NULL,
  max REAL NOT NULL,
  buckets TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS perf_minutes_minute ON perf_minutes(minute);
CREATE TABLE IF NOT EXISTS perf_examples (
  at TEXT NOT NULL,
  proc TEXT NOT NULL,
  pid INTEGER NOT NULL,
  op TEXT NOT NULL,
  ms REAL NOT NULL,
  fields TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS perf_examples_at ON perf_examples(at);
`;

export function openPerfDb(file = paths.perfDb()): Database {
  mkdirSync(dirname(file), { recursive: true });
  const out = new Database(file, { create: true });
  out.exec("PRAGMA journal_mode = WAL");
  out.exec("PRAGMA busy_timeout = 1000");
  out.exec(SCHEMA);
  return out;
}

function perfDb(): Database {
  db ??= openPerfDb();
  return db;
}

let flushesAtExit = false;

function ensureFlushing(): void {
  if (flushTimer) return;
  flushTimer = setInterval(flushPerf, FLUSH_MS);
  flushTimer.unref?.();
  if (!flushesAtExit) {
    flushesAtExit = true;
    process.on("exit", flushPerf);
  }
}

// Writes what this process has gathered since the last flush. Never throws:
// perf must not take aug down.
export function flushPerf(): void {
  if (!aggs.size && !examples.size) return;
  const minute = windowStart;
  windowStart = minuteOf(new Date());
  const rows = [...aggs.entries()];
  const kept = [...examples.values()].flat();
  aggs.clear();
  examples.clear();
  // A config change (log turned off) applies from the next window.
  enabled = undefined;
  try {
    const d = perfDb();
    const addMinute = d.prepare(
      "INSERT INTO perf_minutes (minute, proc, pid, op, unit, count, total, max, buckets) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const addExample = d.prepare(
      "INSERT INTO perf_examples (at, proc, pid, op, ms, fields) VALUES (?, ?, ?, ?, ?, ?)",
    );
    d.transaction(() => {
      for (const [op, a] of rows)
        addMinute.run(
          minute,
          proc,
          process.pid,
          op,
          a.unit,
          a.count,
          a.total,
          a.max,
          JSON.stringify(a.buckets),
        );
      for (const e of kept)
        addExample.run(
          e.at,
          proc,
          process.pid,
          e.op,
          e.ms,
          JSON.stringify(e.fields),
        );
    })();
  } catch {
    // Dropped: a busy or full disk costs one minute of counters.
  }
}

export function prunePerf(now = new Date()): void {
  try {
    const cutoff = new Date(
      now.getTime() - KEEP_DAYS * 86400_000,
    ).toISOString();
    const d = perfDb();
    d.run("DELETE FROM perf_minutes WHERE minute < ?", [cutoff.slice(0, 16)]);
    d.run("DELETE FROM perf_examples WHERE at < ?", [cutoff]);
  } catch {
    // Pruned next start.
  }
}

// ── process ────────────────────────────────────────────────────────────────

let processTimers: ReturnType<typeof setInterval>[] = [];

// The long-running process's own cost: CPU and memory each minute, and how
// late a 1s timer fires (event-loop lag, what a stalled keypress feels like).
function sampleProcess(): void {
  let cpu = process.cpuUsage();
  let cpuAt = performance.now();
  const minute = setInterval(() => {
    const used = process.cpuUsage(cpu);
    const elapsed = performance.now() - cpuAt;
    cpu = process.cpuUsage();
    cpuAt = performance.now();
    if (elapsed > 0)
      sample(
        "process.cpu",
        ((used.user + used.system) / 1000 / elapsed) * 100,
        "%",
      );
    sample("process.rss", process.memoryUsage.rss() / 1024 / 1024, "MB");
  }, 60_000);
  let expected = performance.now() + 1000;
  const lag = setInterval(() => {
    const now = performance.now();
    timing("process.loop_lag", Math.max(0, now - expected));
    expected = now + 1000;
  }, 1000);
  for (const t of [minute, lag]) t.unref?.();
  processTimers = [minute, lag];
}

export interface PerfStart {
  // What the rows say made them: "aug" (the TUI) or "aug-tools".
  proc: string;
  // The TUI samples its own CPU, memory and loop lag; a hook does not.
  sampleProcess?: boolean;
}

// An entry point's one call: names the process, routes log.time() here and
// flushes at exit. Off with the log, it costs nothing past the check.
export function startPerf(opts: PerfStart): void {
  proc = opts.proc;
  setTimingSink(timing);
  if (!perfOn()) return;
  if (opts.sampleProcess) {
    prunePerf();
    sampleProcess();
  }
}

// Tests: forget everything gathered and read the settings again.
export function resetPerf(): void {
  for (const t of processTimers) clearInterval(t);
  processTimers = [];
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = null;
  aggs.clear();
  examples.clear();
  enabled = undefined;
  windowStart = minuteOf(new Date());
  try {
    db?.close();
  } catch {
    // Already closed.
  }
  db = null;
}

// ── report ─────────────────────────────────────────────────────────────────

export interface PerfRow {
  op: string;
  unit: PerfUnit;
  count: number;
  total: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

export interface PerfExample {
  at: string;
  proc: string;
  op: string;
  ms: number;
  fields: PerfFields;
}

export interface PerfReport {
  since: string;
  until: string;
  procs: number;
  rows: PerfRow[];
  slowest: PerfExample[];
}

// The value at quantile q of a bucketed histogram: linear within the bucket
// it falls in, and never past the largest value seen.
export function quantile(
  buckets: readonly number[],
  q: number,
  max: number,
): number {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (!total) return 0;
  const rank = q * total;
  let seen = 0;
  for (let i = 0; i < buckets.length; i++) {
    const n = buckets[i]!;
    if (!n) continue;
    if (seen + n >= rank) {
      const lo = i === 0 ? 0 : BOUNDS[i - 1]!;
      const hi = Math.min(i < BOUNDS.length ? BOUNDS[i]! : max, max);
      const at = lo + ((hi - lo) * (rank - seen)) / n;
      return Math.min(Math.max(at, Math.min(lo, max)), max);
    }
    seen += n;
  }
  return max;
}

interface MinuteRow {
  op: string;
  unit: string;
  count: number;
  total: number;
  max: number;
  buckets: string;
  pid: number;
}

interface ExampleRow {
  at: string;
  proc: string;
  op: string;
  ms: number;
  fields: string;
}

export interface ReportOptions {
  since: Date;
  until?: Date;
  // Only ops starting with this.
  op?: string;
  slowest?: number;
}

export function perfReport(
  opts: ReportOptions,
  from: Database = perfDb(),
): PerfReport {
  const until = opts.until ?? new Date();
  const since = minuteOf(opts.since);
  const to = minuteOf(until);
  const prefix = `${opts.op ?? ""}%`;
  const minutes = from
    .query<
      MinuteRow,
      [string, string, string]
    >("SELECT op, unit, count, total, max, buckets, pid FROM perf_minutes WHERE minute >= ? AND minute <= ? AND op LIKE ?")
    .all(since, to, prefix);
  const merged = new Map<string, Agg>();
  const pids = new Set<number>();
  for (const m of minutes) {
    pids.add(m.pid);
    let agg = merged.get(m.op);
    if (!agg) {
      agg = {
        unit: m.unit,
        count: 0,
        total: 0,
        max: 0,
        buckets: new Array<number>(BOUNDS.length + 1).fill(0),
      };
      merged.set(m.op, agg);
    }
    agg.count += m.count;
    agg.total += m.total;
    agg.max = Math.max(agg.max, m.max);
    const b = JSON.parse(m.buckets) as number[];
    for (let i = 0; i < agg.buckets.length; i++) agg.buckets[i]! += b[i] ?? 0;
  }
  const rows: PerfRow[] = [...merged.entries()].map(([op, a]) => ({
    op,
    unit: a.unit,
    count: a.count,
    total: a.total,
    mean: a.count ? a.total / a.count : 0,
    p50: quantile(a.buckets, 0.5, a.max),
    p95: quantile(a.buckets, 0.95, a.max),
    max: a.max,
  }));
  rows.sort(
    (a, b) =>
      (a.unit === "ms" ? 0 : 1) - (b.unit === "ms" ? 0 : 1) ||
      b.total - a.total ||
      b.count - a.count,
  );
  const slowest = from
    .query<ExampleRow, [string, string, string, number]>(
      "SELECT at, proc, op, ms, fields FROM perf_examples WHERE at >= ? AND at <= ? AND op LIKE ? ORDER BY ms DESC LIMIT ?",
    )
    .all(
      opts.since.toISOString(),
      until.toISOString(),
      prefix,
      opts.slowest ?? 15,
    )
    .map((e) => ({ ...e, fields: JSON.parse(e.fields) as PerfFields }));
  return {
    since: opts.since.toISOString(),
    until: until.toISOString(),
    procs: pids.size,
    rows,
    slowest,
  };
}

function num(value: number, unit: PerfUnit): string {
  if (unit === "ms") {
    if (value >= 1000)
      return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}s`;
    return `${value >= 10 ? Math.round(value) : value.toFixed(1)}ms`;
  }
  const n = value >= 10 ? String(Math.round(value)) : value.toFixed(1);
  return unit === "%" ? `${n}%` : `${n}${unit === "count" ? "" : ` ${unit}`}`;
}

function table(header: string[], body: string[][]): string {
  const widths = header.map((h, i) =>
    Math.max(h.length, ...body.map((r) => r[i]!.length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === 0 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!)))
      .join("  ")
      .trimEnd();
  return [line(header), ...body.map(line)].join("\n");
}

export function perfText(report: PerfReport): string {
  const hours =
    (Date.parse(report.until) - Date.parse(report.since)) / 3600_000;
  const out = [
    `perf ${report.since.slice(0, 16)} → ${report.until.slice(0, 16)} UTC (${hours.toFixed(hours < 10 ? 1 : 0)}h, ${report.procs} processes)`,
  ];
  if (!report.rows.length) {
    out.push(
      "",
      "nothing recorded: perf rides on the log (AUG_LOG, log.enabled or AUG_DEV)",
    );
    return out.join("\n");
  }
  const timings = report.rows.filter((r) => r.unit === "ms");
  const counts = report.rows.filter((r) => r.unit === "count");
  const samples = report.rows.filter(
    (r) => r.unit !== "ms" && r.unit !== "count",
  );
  if (timings.length)
    out.push(
      "",
      table(
        ["timing", "count", "p50", "p95", "max", "total"],
        timings.map((r) => [
          r.op,
          String(r.count),
          num(r.p50, "ms"),
          num(r.p95, "ms"),
          num(r.max, "ms"),
          num(r.total, "ms"),
        ]),
      ),
    );
  if (samples.length)
    out.push(
      "",
      table(
        ["sample", "count", "p50", "p95", "max", "mean"],
        samples.map((r) => [
          r.op,
          String(r.count),
          num(r.p50, r.unit),
          num(r.p95, r.unit),
          num(r.max, r.unit),
          num(r.mean, r.unit),
        ]),
      ),
    );
  if (counts.length) {
    const perHour = (n: number) =>
      hours > 0 ? (n / hours).toFixed(n / hours >= 10 ? 0 : 1) : "-";
    out.push(
      "",
      table(
        ["count", "total", "per hour"],
        counts.map((r) => [r.op, String(r.count), perHour(r.count)]),
      ),
    );
  }
  if (report.slowest.length)
    out.push(
      "",
      "slowest",
      ...report.slowest.map((e) => {
        const fields = Object.keys(e.fields).length
          ? ` ${JSON.stringify(e.fields)}`
          : "";
        return `  ${e.at.slice(0, 19).replace("T", " ")}  ${num(e.ms, "ms").padStart(7)}  ${e.op}  ${e.proc}${fields}`;
      }),
    );
  return out.join("\n");
}
