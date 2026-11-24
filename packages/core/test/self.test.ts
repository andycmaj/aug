import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guardScript, installHooks } from "../src/adopt";
import { codingLaunch } from "../src/agents";
import { envName } from "../src/brand";
import { DEFAULT_CONFIG } from "../src/config";
import { installState, InstallState, refreshInstalls } from "../src/install";
import { setMux } from "../src/mux";
import { startTask } from "../src/projects";
import {
  lastingEntry,
  setToolsEntry,
  toolsArgv,
  toolsCommand,
  toolsEntry,
  toolsMissing,
} from "../src/self";
import * as store from "../src/store";
import { Kind } from "../src/types";
import { FakeMux } from "./support/fake-mux";
import { config, freshHome } from "./support/helpers";

const TOOLS = join("packages", "cli", "src", "riker-tools.ts");
const PIN = envName("TOOLS_ENTRY");

let dir: string;
let main: string;
let wt: string;
const before = { entry: toolsEntry(), pin: process.env[PIN], claude: process.env.CLAUDE_CONFIG_DIR };

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function file(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "// riker-tools\n");
}

// A real repo with a linked worktree, laid out as `wt` makes them: riker-tools
// in both.
beforeEach(() => {
  freshHome();
  delete process.env[PIN];
  dir = realpathSync(mkdtempSync(join(tmpdir(), "riker-self-")));
  main = join(dir, "riker");
  wt = join(dir, "riker.some-task");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  file(join(main, TOOLS));
  git(main, "add", ".");
  git(main, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  git(main, "worktree", "add", "-q", "-b", "some-task", wt);
});

afterEach(() => {
  setToolsEntry(before.entry);
  if (before.pin === undefined) delete process.env[PIN];
  else process.env[PIN] = before.pin;
  if (before.claude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = before.claude;
  rmSync(dir, { recursive: true, force: true });
});

describe("lastingEntry", () => {
  test("riker-tools in a linked worktree is named by its main checkout's path", () => {
    expect(lastingEntry(join(wt, TOOLS))).toBe(join(main, TOOLS));
  });

  test("the worktree's own path when the main checkout has no such file", () => {
    const only = join(wt, "packages", "cli", "src", "new-tools.ts");
    file(only);
    expect(lastingEntry(only)).toBe(only);
  });

  test("the main checkout, and a file in no repo, keep their path", () => {
    expect(lastingEntry(join(main, TOOLS))).toBe(join(main, TOOLS));
    const loose = join(dir, "loose", "riker-tools.ts");
    file(loose);
    expect(lastingEntry(loose)).toBe(loose);
  });

  test("RIKER_TOOLS_ENTRY names one outright", () => {
    process.env[PIN] = join(wt, TOOLS);
    expect(lastingEntry(join(main, TOOLS))).toBe(join(wt, TOOLS));
  });
});

describe("what briefs and hooks name", () => {
  test("Riker run from a worktree hands out the main checkout's riker-tools", () => {
    setToolsEntry(lastingEntry(join(wt, TOOLS)));
    expect(toolsArgv()).toEqual([process.execPath, join(main, TOOLS)]);
    expect(toolsCommand("done")).not.toContain(wt);
    expect(guardScript()).toContain(join(main, TOOLS));
    expect(guardScript()).not.toContain(wt);

    const task = store.createTask({ title: "Fix it", kind: Kind.coding, channel: "github" });
    const launch = codingLaunch(config(), task, {});
    const brief = launch.argv[launch.argv.indexOf("--append-system-prompt-file") + 1]!;
    const text = `${launch.argv.join(" ")} ${readFileSync(brief, "utf8")}`;
    expect(text).toContain(join(main, TOOLS));
    expect(text).not.toContain(wt);
  });

  test("the worktree going away leaves them working", () => {
    setToolsEntry(lastingEntry(join(wt, TOOLS)));
    git(main, "worktree", "remove", "--force", wt);
    expect(toolsMissing()).toBeNull();
  });
});

describe("a riker-tools that is gone", () => {
  beforeEach(() => {
    setToolsEntry(join(wt, TOOLS));
    git(main, "worktree", "remove", "--force", wt);
  });

  test("toolsMissing names it", () => {
    expect(toolsMissing()).toBe(join(wt, TOOLS));
  });

  test("a coding start refuses with words, not an agent whose every call fails", async () => {
    freshHome({ repos: { "acme/api": "/src/api" } });
    const fake = new FakeMux();
    setMux(fake);
    const task = store.createTask({
      title: "Fix it",
      kind: Kind.coding,
      channel: "github",
      repo: "acme/api",
    });
    const r = await startTask(config(), task.id);
    expect(r).toEqual({
      type: "failed",
      error: `riker-tools is gone (${join(wt, TOOLS)}): restart Riker from a checkout that has it`,
    });
    expect(fake.windows).toHaveLength(0);
  });

  test("the refresh at start leaves installs alone rather than point them at it", () => {
    process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
    setToolsEntry(join(main, TOOLS));
    installHooks();
    setToolsEntry(join(wt, TOOLS));
    expect(installState("hooks")).toBe(InstallState.stale);
    expect(refreshInstalls()).toEqual([]);
    expect(guardScript()).toContain(join(wt, TOOLS));
  });
});
