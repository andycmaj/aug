import { describe, expect, test } from "bun:test";
import { DEMO_AGENT_SUBCOMMAND, scriptArgv } from "@riker/core/self";
import { VERSION } from "@riker/core/version";
import root from "../../../package.json" with { type: "json" };
import { installNotes } from "../script/install-notes";
import { bumpVersion, nextVersion } from "../script/version";

describe("the release's version", () => {
  test("a bump moves one part and zeroes the ones after it", () => {
    expect(bumpVersion("0.3.7", "patch")).toBe("0.3.8");
    expect(bumpVersion("0.3.7", "minor")).toBe("0.4.0");
    expect(bumpVersion("v0.3.7", "major")).toBe("1.0.0");
    expect(bumpVersion("1.2.3-beta.1", "patch")).toBe("1.2.4");
  });

  test("an override wins over the bump, without its v", () => {
    expect(nextVersion("0.0.1", "major", "v0.1.0")).toBe("0.1.0");
    expect(nextVersion("0.0.1", undefined, "  ")).toBe("0.0.2");
    expect(nextVersion("0.0.1", "", undefined)).toBe("0.0.2");
  });

  test("a bad bump or override is refused before anything is tagged", () => {
    expect(() => nextVersion("0.0.1", "huge", undefined)).toThrow("expected major | minor | patch");
    expect(() => nextVersion("0.0.1", "patch", "next")).toThrow("not a version");
    expect(() => bumpVersion("one.two.three", "patch")).toThrow("cannot read a semver");
  });

  test("riker --version says the root package.json's, which the release bumps", () => {
    expect(VERSION).toBe(root.version);
  });
});

test("the release notes say how to install with mise", () => {
  const notes = installNotes("andycmaj/riker");
  expect(notes).toContain("mise use -g github:andycmaj/riker\n");
  expect(notes).toContain("riker --demo");
});

test("from source the demo's agent is bun on its script", () => {
  expect(scriptArgv("/src/fake-claude.ts", DEMO_AGENT_SUBCOMMAND)).toEqual([
    process.execPath,
    "/src/fake-claude.ts",
  ]);
});
