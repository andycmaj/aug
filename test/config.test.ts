import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { utimesSync, writeFileSync } from "node:fs";
import {
  DEFAULT_CONFIG,
  loadConfig,
  mergeConfig,
  unpinConfigForTest,
} from "../src/core/config";
import { paths } from "../src/core/paths";
import { freshHome } from "./helpers";

describe("config", () => {
  beforeEach(() => {
    freshHome();
    unpinConfigForTest();
  });
  afterEach(() => freshHome());

  test("triage noise defaults to today's gates, and a file's list replaces them", () => {
    expect(mergeConfig({}).triage.noise).toEqual(DEFAULT_CONFIG.triage.noise);
    const own = [{ reason: "digest", title: "digest" }];
    expect(mergeConfig({ triage: { noise: own } }).triage.noise).toEqual(own);
  });

  test("an edit to config.json is read on the next load", () => {
    const file = paths.config();
    writeFileSync(file, JSON.stringify({ autostart: false }));
    utimesSync(file, 1_000, 1_000);
    expect(loadConfig().autostart).toBe(false);
    expect(loadConfig()).toBe(loadConfig());

    writeFileSync(
      file,
      JSON.stringify({ triage: { noise: [{ reason: "digest", body: "x" }] } }),
    );
    utimesSync(file, 2_000, 2_000);
    const next = loadConfig();
    expect(next.autostart).toBe(true);
    expect(next.triage.noise).toEqual([{ reason: "digest", body: "x" }]);
  });
});
