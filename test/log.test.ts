import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG, mergeConfig } from "../src/core/config";
import { think } from "../src/core/brain";
import {
  formatLine,
  logEnabled,
  logger,
  resetLog,
  resolveLogSettings,
} from "../src/core/log";
import { paths } from "../src/core/paths";
import { fakeBrain, freshHome } from "./helpers";

const read = () =>
  existsSync(paths.log()) ? readFileSync(paths.log(), "utf8") : "";

afterEach(() => {
  delete process.env.AUG_LOG;
  delete process.env.AUG_DEV;
  resetLog();
});

describe("log settings", () => {
  test("off by default", () => {
    freshHome();
    expect(resolveLogSettings({})).toBeNull();
    logger("x").error("nobody hears this");
    expect(existsSync(paths.log())).toBe(false);
  });

  test("dev mode logs debug and up", () => {
    freshHome();
    expect(resolveLogSettings({ AUG_DEV: "1" })?.level).toBe("debug");
    expect(resolveLogSettings({ AUG_DEV: "0" })).toBeNull();
  });

  test("config turns it on at its level", () => {
    freshHome({ log: { enabled: true, level: "warn" } });
    const s = resolveLogSettings({});
    expect(s?.level).toBe("warn");
    expect(s?.file).toBe(paths.log());
  });

  test("AUG_LOG wins over config and dev mode", () => {
    freshHome({ log: { enabled: true, level: "warn" } });
    expect(resolveLogSettings({ AUG_LOG: "trace" })?.level).toBe("trace");
    expect(resolveLogSettings({ AUG_LOG: "on" })?.level).toBe("debug");
    expect(resolveLogSettings({ AUG_LOG: "off", AUG_DEV: "1" })).toBeNull();
  });

  test("a partial log section in config keeps the defaults", () => {
    expect(mergeConfig({ log: { enabled: true } }).log).toEqual({
      ...DEFAULT_CONFIG.log,
      enabled: true,
    });
  });
});

describe("writing", () => {
  test("lines below the level are dropped", () => {
    freshHome({ log: { enabled: true, level: "info" } });
    const log = logger("slack");
    log.debug("noise");
    log.info("connected", { transport: "token" });
    log.error("poll failed", { err: new Error("rate limited") });
    const lines = read().trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("INFO ");
    expect(lines[0]).toContain('slack: connected {"transport":"token"}');
    expect(lines[1]).toContain("ERROR");
    expect(lines[1]).toContain('"message":"rate limited"');
    expect(logEnabled("debug")).toBe(false);
    expect(logEnabled("warn")).toBe(true);
  });

  test("time() logs a duration, at warn when it failed", () => {
    freshHome({ log: { enabled: true, level: "debug" } });
    const log = logger("github");
    log.time("poll")({ fresh: 2 });
    log.time("poll")({ ok: false });
    const [ok, failed] = read().trim().split("\n");
    expect(ok).toMatch(/DEBUG .* github: poll \{"fresh":2,"ms":\d+\}/);
    expect(failed).toContain("WARN");
  });

  test("rolls over past maxBytes, keeping one old file", () => {
    freshHome({ log: { enabled: true, level: "info", maxBytes: 200 } });
    const log = logger("x");
    for (let i = 0; i < 10; i++) log.info(`line ${i}`, { pad: "x".repeat(40) });
    expect(existsSync(`${paths.log()}.1`)).toBe(true);
    expect(readFileSync(paths.log(), "utf8").length).toBeLessThanOrEqual(200);
    expect(read()).toContain("line 9");
  });

  test("a file it cannot write never throws", () => {
    freshHome({ log: { enabled: true, level: "info" } });
    const blocker = join(paths.home(), "blocker");
    writeFileSync(blocker, "");
    freshHome({
      log: { enabled: true, level: "info", file: join(blocker, "aug.log") },
    });
    expect(() => logger("x").error("lost")).not.toThrow();
  });

  test("unserializable fields still log the line", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    const line = formatLine(new Date(0), "warn", "x", "odd", { loop });
    expect(line).toContain("x: odd");
    expect(line).toContain("unserializable");
  });
});

describe("brain tracing", () => {
  test("every call is traced with its timing", async () => {
    freshHome({ log: { enabled: true, level: "trace" } });
    fakeBrain(() => ({ ok: true }));
    await think({ prompt: "hello there", model: "haiku" });
    const text = read();
    expect(text).toContain("brain: call ");
    expect(text).toContain('"prompt":"hello there"');
    expect(text).toMatch(/brain: call done .*"model":"haiku".*"ms":\d+/);
  });
});
