import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptHook,
  adoptedTitle,
  guardScript,
  hooksInstalled,
  installHooks,
  paneEnv,
  repoFromRemote,
  uninstallHooks,
  type GitInfo,
} from "../src/core/adopt";
import { setMux } from "../src/core/mux";
import { realSpawn } from "../src/core/slack/claude-mcp";
import { createProject } from "../src/core/projects";
import * as store from "../src/core/store";
import { AgentState, SessionKind } from "../src/core/types";
import { FakeMux } from "./fake-mux";
import { freshHome } from "./helpers";

let fake: FakeMux;
const git: GitInfo = {
  branch: "fix-bom",
  toplevel: "/src/ledger.fix-bom",
  repo: "acme/ledger",
  worktree: true,
};
const probe = () => git;

beforeEach(() => {
  freshHome();
  fake = new FakeMux();
  setMux(fake);
});

async function projectWindow(): Promise<{ projectId: number; windowId: string }> {
  const p = await createProject({ name: "Ledger" });
  const session = fake.sessions.find((s) => s.projectId === p.id)!;
  const w = await fake.newWindow({ sessionId: session.id, name: "zsh", cwd: "/", env: {}, argv: [] });
  return { projectId: p.id, windowId: w.id };
}

describe("titles and remotes", () => {
  test("worktree branch first, then the first prompt line, then the window", () => {
    expect(adoptedTitle(git, "anything", "zsh")).toBe("fix-bom");
    const main = { ...git, branch: "main" };
    expect(adoptedTitle(main, "Make the export\nkeep transfers", "zsh")).toBe("Make the export");
    expect(adoptedTitle(main, undefined, "api")).toBe("api");
    expect(adoptedTitle(main, "x".repeat(100), "zsh")).toHaveLength(80);
  });

  test("a branch checked out in the main checkout is not the task's name", () => {
    const shared = { ...git, branch: "projects", worktree: false };
    expect(adoptedTitle(shared, "Retitle adopted tasks", "zsh")).toBe("Retitle adopted tasks");
    expect(adoptedTitle(shared, undefined, "api")).toBe("api");
  });

  test("owner/repo from ssh and https remotes", () => {
    expect(repoFromRemote("git@github.com:acme/ledger.git")).toBe("acme/ledger");
    expect(repoFromRemote("https://github.com/acme/ledger")).toBe("acme/ledger");
    expect(repoFromRemote("https://gitlab.com/acme/ledger.git")).toBeNull();
    expect(repoFromRemote(null)).toBeNull();
  });
});

describe("adoptHook", () => {
  test("the first prompt in an untagged project window makes a task", async () => {
    const { projectId, windowId } = await projectWindow();
    const env = await adoptHook(
      "prompt",
      { session_id: "s1", prompt: "fix it", cwd: "/src/ledger.fix-bom" },
      windowId,
      probe,
    );
    expect(env).not.toBeNull();
    const task = store.getTask(env!.taskId)!;
    expect(task).toMatchObject({
      title: "fix-bom",
      kind: "coding",
      project_id: projectId,
      repo: "acme/ledger",
      branch: "fix-bom",
      worktree: "/src/ledger.fix-bom",
      agent_state: AgentState.working,
    });
    expect(fake.windows.find((w) => w.id === windowId)!.taskId).toBe(task.id);
    expect(store.getSession("s1")).toMatchObject({
      kind: SessionKind.tmux,
      started_by: "owner",
      tmux_window: windowId,
    });
    expect(store.projectRepos(store.getProject(projectId)!)).toEqual(["acme/ledger"]);
  });

  test("later hooks reuse the window's task; a new claude there joins it", async () => {
    const { windowId } = await projectWindow();
    const first = await adoptHook("prompt", { session_id: "s1" }, windowId, probe);
    await adoptHook("tool", { session_id: "s1", tool_name: "Read", tool_input: { file_path: "a.ts" } }, windowId, probe);
    await adoptHook("end", { session_id: "s1" }, windowId, probe);
    expect(store.getSession("s1")!.ended_at).not.toBeNull();
    const again = await adoptHook("prompt", { session_id: "s2" }, windowId, probe);
    expect(again!.taskId).toBe(first!.taskId);
    expect(store.listTasks()).toHaveLength(1);
    expect(store.getSession("s2")!.task_id).toBe(first!.taskId);
  });

  test("a claude that ends without working makes nothing", async () => {
    const { windowId } = await projectWindow();
    expect(await adoptHook("end", { session_id: "s1" }, windowId, probe)).toBeNull();
    expect(store.listTasks()).toHaveLength(0);
  });

  test("panes outside projects, and archived projects, are left alone", async () => {
    const plain = await fake.newSession("home");
    const w = await fake.newWindow({ sessionId: plain.id, name: "zsh", cwd: "/", env: {}, argv: [] });
    expect(await adoptHook("prompt", { session_id: "s1" }, w.id, probe)).toBeNull();
    const { projectId, windowId } = await projectWindow();
    store.archiveProject(projectId);
    expect(await adoptHook("prompt", { session_id: "s2" }, windowId, probe)).toBeNull();
    expect(store.listTasks()).toHaveLength(0);
  });

  test("aug-tools by hand in an adopted window finds its task and session", async () => {
    const { windowId } = await projectWindow();
    const env = await adoptHook("prompt", { session_id: "s1" }, windowId, probe);
    expect(await paneEnv(windowId)).toEqual(env);
  });
});

describe("user settings", () => {
  test("install adds ours once, keeps yours, backs up; uninstall restores", () => {
    const dir = mkdtempSync(join(tmpdir(), "aug-claude-"));
    const file = join(dir, "settings.json");
    const mine = { model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "say hi" }] }] } };
    writeFileSync(file, JSON.stringify(mine));
    expect(hooksInstalled(file)).toBe(false);
    installHooks(file);
    installHooks(file);
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.model).toBe("opus");
    expect(after.hooks.Stop).toHaveLength(2);
    expect(after.hooks.PreToolUse).toEqual([
      { matcher: "*", hooks: [{ type: "command", command: expect.stringContaining("adopt-hook.sh tool") }] },
    ]);
    expect(hooksInstalled(file)).toBe(true);
    expect(existsSync(`${file}.before-aug`)).toBe(true);
    expect(uninstallHooks(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(mine);
    expect(uninstallHooks(file)).toBe(false);
  });

  test("the guard skips aug's own claudes and non-project panes before bun", () => {
    const script = guardScript();
    const lines = script.split("\n");
    const exec = lines.findIndex((l) => l.includes("exec"));
    expect(lines.findIndex((l) => l.includes("AUG_TASK_ID"))).toBeLessThan(exec);
    expect(lines.findIndex((l) => l.includes("@aug_project"))).toBeLessThan(exec);
    expect(script).toContain('adopt-hook "$1"');
  });
});

describe("aug's own claudes", () => {
  // aug run in a pane of a task's window once had its Slack claude (which
  // loads user settings, so the guard) adopted as that task's newest
  // session; s then resumed an id claude had no conversation for.
  test("carry no pane, so the guard never adopts them", async () => {
    const before = process.env.TMUX_PANE;
    process.env.TMUX_PANE = "%5";
    try {
      const proc = realSpawn(["sh", "-c", 'echo "pane=${TMUX_PANE:-none}"']);
      const seen: string[] = [];
      for await (const line of proc.lines) seen.push(line);
      expect(seen).toEqual(["pane=none"]);
    } finally {
      if (before === undefined) delete process.env.TMUX_PANE;
      else process.env.TMUX_PANE = before;
    }
  });
});
