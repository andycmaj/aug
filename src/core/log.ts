// aug's file log: what happened while you were not looking. Connections
// coming and going, errors that only ever reached a status line, a trace of
// every model call, and how long things took. The TUI owns the terminal, so
// nothing prints; it all goes to one file under AUG_HOME (paths.log()), which
// `tail -f` reads while aug runs.
//
// Off unless something turns it on, first match wins:
//   AUG_LOG=<level>|on|off   (env; "on" means debug)
//   log.enabled in config    (level from log.level, default info)
//   AUG_DEV=1                (`bun run dev` sets it; level debug)
//
// Writes are synchronous appends so a line survives the crash that follows
// it, and the TUI and every aug-tools hook can share one file. Logging never
// throws: a full disk must not take the app down with it.

import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config";
import { paths } from "./paths";

export const LogLevel = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
} as const;
export type LogLevelName = keyof typeof LogLevel;

export type LogFields = Record<string, unknown>;

export interface LogSettings {
  level: LogLevelName;
  file: string;
  // The file rolls over to <file>.1 past this size; one old file is kept.
  maxBytes: number;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

const isLevel = (value: string): value is LogLevelName => value in LogLevel;
const truthy = (value: string | undefined) =>
  !!value && !/^(0|false|off|no)$/i.test(value);

export function resolveLogSettings(
  env: Record<string, string | undefined> = process.env,
): LogSettings | null {
  const config = loadConfig().log;
  const file = config.file ?? paths.log();
  const maxBytes = config.maxBytes ?? DEFAULT_MAX_BYTES;
  const fromEnv = env.AUG_LOG?.trim().toLowerCase();
  if (fromEnv) {
    if (!truthy(fromEnv)) return null;
    return { level: isLevel(fromEnv) ? fromEnv : "debug", file, maxBytes };
  }
  if (config.enabled) return { level: config.level, file, maxBytes };
  if (truthy(env.AUG_DEV)) return { level: "debug", file, maxBytes };
  return null;
}

// Settings are read once; resetLog() makes the next line read them again
// (tests, and after the config changes).
let settings: LogSettings | null | undefined;
let size: number | undefined;

export function resetLog(): void {
  settings = undefined;
  size = undefined;
}

function current(): LogSettings | null {
  if (settings === undefined) {
    try {
      settings = resolveLogSettings();
    } catch {
      settings = null;
    }
  }
  return settings;
}

export function logEnabled(level: LogLevelName = "trace"): boolean {
  const s = current();
  return !!s && LogLevel[level] >= LogLevel[s.level];
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error)
    return { name: value.name, message: value.message, stack: value.stack };
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function formatLine(
  at: Date,
  level: LogLevelName,
  scope: string,
  msg: string,
  fields?: LogFields,
): string {
  let tail = "";
  if (fields && Object.keys(fields).length) {
    try {
      tail = " " + JSON.stringify(fields, replacer);
    } catch {
      tail = ' {"fields":"unserializable"}';
    }
  }
  return `${at.toISOString()} ${level.toUpperCase().padEnd(5)} ${process.pid} ${scope}: ${msg}${tail}\n`;
}

function write(
  level: LogLevelName,
  scope: string,
  msg: string,
  fields?: LogFields,
): void {
  const s = current();
  if (!s || LogLevel[level] < LogLevel[s.level]) return;
  try {
    const line = formatLine(new Date(), level, scope, msg, fields);
    if (size === undefined) {
      mkdirSync(dirname(s.file), { recursive: true });
      try {
        size = statSync(s.file).size;
      } catch {
        size = 0;
      }
    }
    const bytes = Buffer.byteLength(line);
    if (size > 0 && size + bytes > s.maxBytes) {
      renameSync(s.file, `${s.file}.1`);
      size = 0;
    }
    appendFileSync(s.file, line);
    size += bytes;
  } catch {
    // Nowhere left to report it.
  }
}

export interface Logger {
  trace(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  // Telemetry: call the result when the work ends; it logs the duration
  // (ms) with whatever fields both ends give, at debug, or at warn when the
  // end says { ok: false }.
  time(msg: string, fields?: LogFields): (end?: LogFields) => void;
}

export function logger(scope: string): Logger {
  return {
    trace: (msg, fields) => write("trace", scope, msg, fields),
    debug: (msg, fields) => write("debug", scope, msg, fields),
    info: (msg, fields) => write("info", scope, msg, fields),
    warn: (msg, fields) => write("warn", scope, msg, fields),
    error: (msg, fields) => write("error", scope, msg, fields),
    time(msg, fields) {
      const started = performance.now();
      return (end) => {
        const ms = Math.round(performance.now() - started);
        const level = end?.ok === false ? "warn" : "debug";
        write(level, scope, msg, { ...fields, ...end, ms });
      };
    },
  };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Records a crash before the app shell's own handlers exit the process.
// These only observe: the shell still decides what a crash does, and with no
// other rejection handler the rejection is rethrown, as if nobody listened.
export function logCrashes(): void {
  const log = logger("process");
  process.on("uncaughtExceptionMonitor", (err) =>
    log.error("uncaught exception", { err }),
  );
  process.on("unhandledRejection", (reason) => {
    log.error("unhandled rejection", { err: reason });
    if (process.listenerCount("unhandledRejection") === 1) throw reason;
  });
  process.on("exit", (code) => log.info("exit", { code }));
}
