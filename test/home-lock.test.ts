import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { claimHome, releaseHome } from "../src/core/home-lock";
import { paths } from "../src/core/paths";
import { freshHome } from "./helpers";

beforeEach(() => freshHome());

describe("home lock", () => {
  test("a second aug on the same home is refused, naming the first", () => {
    expect(claimHome({ pid: 100, alive: () => true })).toEqual({ ok: true });
    expect(claimHome({ pid: 200, alive: () => true })).toEqual({ ok: false, pid: 100 });
  });

  test("a lock left by an aug that is gone is taken over", () => {
    writeFileSync(paths.lock(), "100\n");
    expect(claimHome({ pid: 200, alive: (pid) => pid !== 100 })).toEqual({ ok: true });
    expect(readFileSync(paths.lock(), "utf8").trim()).toBe("200");
  });

  test("the same process claiming again keeps it", () => {
    claimHome({ pid: 100, alive: () => true });
    expect(claimHome({ pid: 100, alive: () => true })).toEqual({ ok: true });
  });

  test("release frees it, but only for its holder", () => {
    claimHome({ pid: 100, alive: () => true });
    releaseHome(200);
    expect(existsSync(paths.lock())).toBe(true);
    releaseHome(100);
    expect(existsSync(paths.lock())).toBe(false);
    expect(claimHome({ pid: 200, alive: () => true })).toEqual({ ok: true });
  });
});
