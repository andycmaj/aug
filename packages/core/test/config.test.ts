import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import {
  configSection,
  CORE_KEYS,
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
    expect(
      JSON.parse(readFileSync(paths.config(), "utf8")).maxActiveAgents,
    ).toBe(9);
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

describe("a plugin's section", () => {
  beforeEach(() => freshHome());

  const chat = configSection(
    "chatter",
    { enabled: true, every: 30 },
    (written, config) => ({
      enabled: written.enabled ?? true,
      every: written.every ?? (config.autostart ? 30 : 90),
    }),
  );

  test("is kept as written, and read whole through the section", () => {
    const config = mergeConfig({ chatter: { every: 5 } });
    expect(config.chatter).toEqual({ every: 5 });
    expect(chat.of(config)).toEqual({ enabled: true, every: 5 });
    expect(chat.of(mergeConfig({}))).toEqual({ enabled: true, every: 30 });
  });

  test("a default may follow another key", () => {
    expect(chat.of(mergeConfig({ autostart: false })).every).toBe(90);
  });

  test("an update writes back only what the owner wrote, not the defaults", () => {
    const source = fileConfig();
    source.update((c) => ({ ...c, chatter: { enabled: false } }));
    const file = JSON.parse(readFileSync(paths.config(), "utf8")) as Record<
      string,
      unknown
    >;
    expect(file.chatter).toEqual({ enabled: false });
    expect(chat.of(source.get())).toEqual({ enabled: false, every: 30 });
  });

  test("a plugin may not take a key core or another plugin holds", () => {
    expect(CORE_KEYS.has("repos")).toBe(true);
    expect(CORE_KEYS.has("chatter")).toBe(false);
  });
});

describe("keys that moved", () => {
  test("github.repos and github.reviewTeams are read into repos and triage, and leave GitHub's section", () => {
    const config = mergeConfig({
      github: {
        pollSeconds: 30,
        repos: { "a/b": "/w/b" },
        reviewTeams: ["acme/web"],
      },
    } as never);
    expect(config.repos).toEqual({ "a/b": "/w/b" });
    expect(config.triage.reviewTeams).toEqual(["acme/web"]);
    expect(config.github).toEqual({ pollSeconds: 30 });
  });

  test("the new keys win over the old ones", () => {
    const config = mergeConfig({
      repos: { "a/b": "/new" },
      triage: { reviewTeams: ["new"] },
      github: { repos: { "a/b": "/old", "c/d": "/w/d" }, reviewTeams: ["old"] },
    } as never);
    expect(config.repos).toEqual({ "a/b": "/new", "c/d": "/w/d" });
    expect(config.triage.reviewTeams).toEqual(["new"]);
  });
});
