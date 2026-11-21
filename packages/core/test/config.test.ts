import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import {
  DEFAULT_CONFIG,
  fileConfig,
  fixedConfig,
  loadConfig,
  mergeConfig,
} from "../src/config";
import { paths } from "../src/paths";
import { freshHome } from "./support/helpers";

describe("config", () => {
  beforeEach(() => {
    freshHome();
  });

  test("triage noise defaults to today's gates, and a file's list replaces them", () => {
    expect(mergeConfig({}).triage.noise).toEqual(DEFAULT_CONFIG.triage.noise);
    const own = [{ reason: "digest", title: "digest" }];
    expect(mergeConfig({ triage: { noise: own } }).triage.noise).toEqual(own);
  });

  test("an edit to config.json is read on the next get", () => {
    const file = paths.config();
    const config = fileConfig();
    writeFileSync(file, JSON.stringify({ autostart: false }));
    utimesSync(file, 1_000, 1_000);
    expect(config.get().autostart).toBe(false);
    expect(config.get()).toBe(config.get());

    writeFileSync(
      file,
      JSON.stringify({ triage: { noise: [{ reason: "digest", body: "x" }] } }),
    );
    utimesSync(file, 2_000, 2_000);
    const next = config.get();
    expect(next.autostart).toBe(true);
    expect(next.triage.noise).toEqual([{ reason: "digest", body: "x" }]);
  });

  test("an update is written to the file and read back without a reload", () => {
    const config = fileConfig();
    const next = config.update((c) => ({ ...c, maxActiveAgents: 9 }));
    expect(config.get()).toBe(next);
    expect(JSON.parse(readFileSync(paths.config(), "utf8")).maxActiveAgents).toBe(9);
    expect(loadConfig().maxActiveAgents).toBe(9);
  });

  test("a missing file is the defaults", () => {
    expect(fileConfig().get()).toEqual(mergeConfig({}));
  });

  test("a fixed config never touches the file", () => {
    const config = fixedConfig();
    config.update((c) => ({ ...c, autostart: false }));
    expect(config.get().autostart).toBe(false);
    expect(loadConfig().autostart).toBe(true);
  });
});
