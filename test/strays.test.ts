import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adoptHook, type GitInfo } from "../src/core/adopt";
import { DEFAULT_CONFIG } from "../src/core/config";
import { Engine } from "../src/core/engine";
import { setMux } from "../src/core/mux";
import { createProject } from "../src/core/projects";
import * as store from "../src/core/store";
import {
  findStrays,
  matchStray,
  parseClaudeProcess,
  readClaudeProcesses,
  setStraySource,
  type ClaudeProcess,
  type StraySource,
} from "../src/core/strays";
import { AgentState, Kind, SessionKind, TaskStatus } from "../src/core/types";
import { FakeMux } from "./fake-mux";
import { fakeBrain, freshHome } from "./helpers";

let fake: FakeMux;
let engine: Engine;
let claudes: ClaudeProcess[];
const dead = new Set<number>();
const git: GitInfo = {
  branch: "fix-bom",
  toplevel: "/src/ledger.fix-bom",
  repo: "acme/ledger",
  worktree: true,
};
// In the fake a pane is its window; each claude runs under its pane's pid.
const source: StraySource = {
  claudes: () => claudes,
  alive: (pid) => !dead.has(pid),
  under: (pid, ancestor) => pid === ancestor + 1,
  git: () => git,
};

beforeEach(() => {
  freshHome({ github: { ...DEFAULT_CONFIG.github, repos: {} } });
  fakeBrain(() => null);
  fake = new FakeMux();
  setMux(fake);
  setStraySource(source);
  engine = new Engine();
  claudes = [];
  dead.clear();
});

afterEach(() => setStraySource(null));

// One of your own tmux sessions, a claude running in its window.
async function ownSession(name: string, pid: number, status = "busy"): Promise<ClaudeProcess> {
  const session = await fake.newSession(name);
  const w = await fake.newWindow({ sessionId: session.id, name: "claude", cwd: "/", env: {}, argv: [] });
  fake.panePids.set(w.id, pid - 1);
  const claude = {
    pid,
    sessionId: `${name}-0000-session`,
    cwd: `/src/${name}`,
    pane: w.id,
    name: null,
    status,
  };
  claudes.push(claude);
  return claude;
}

describe("Claude's session files", () => {
  test("reads the id, cwd and pane of an interactive claude", () => {
    const text = JSON.stringify({
      pid: 7381,
      sessionId: "1d643864-e936",
      cwd: "/src/aug",
      kind: "interactive",
      tmux: "aug-misc:@200.%228",
      name: "AUG-0022",
      status: "idle",
    });
    expect(parseClaudeProcess(text)).toEqual({
      pid: 7381,
      sessionId: "1d643864-e936",
      cwd: "/src/aug",
      pane: "%228",
      name: "AUG-0022",
      status: "idle",
    });
  });

  test("a claude outside tmux has no pane; print runs, aug's own and junk are skipped", () => {
    const base = { pid: 1, sessionId: "s", cwd: "/x" };
    expect(parseClaudeProcess(JSON.stringify(base))?.pane).toBeNull();
    expect(parseClaudeProcess(JSON.stringify({ ...base, kind: "print" }))).toBeNull();
    expect(parseClaudeProcess(JSON.stringify({ ...base, entrypoint: "aug" }))).toBeNull();
    expect(parseClaudeProcess(JSON.stringify({ pid: 1 }))).toBeNull();
    expect(parseClaudeProcess("{nope")).toBeNull();
  });

  test("reads every json in the folder, and nothing from a folder that is not there", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-sessions-"));
    writeFileSync(join(dir, "1.json"), JSON.stringify({ pid: 1, sessionId: "a", cwd: "/a" }));
    writeFileSync(join(dir, "1.abc.key"), "secret");
    writeFileSync(join(dir, "2.json"), "{");
    expect(readClaudeProcesses(dir).map((c) => c.sessionId)).toEqual(["a"]);
    expect(readClaudeProcesses(join(dir, "missing"))).toEqual([]);
  });

  test("only a name you gave the claude is kept", () => {
    const base = { pid: 1, sessionId: "s", cwd: "/x", name: "beanstream-00" };
    expect(parseClaudeProcess(JSON.stringify({ ...base, nameSource: "derived" }))?.name).toBeNull();
    expect(parseClaudeProcess(JSON.stringify({ ...base, nameSource: "user" }))?.name).toBe("beanstream-00");
  });
});

describe("finding strays", () => {
  test("live claudes no task holds, minus aug's own and the one aug runs beside", async () => {
    const mine = await ownSession("beanstream", 101);
    const gone = await ownSession("old", 201);
    dead.add(gone.pid);
    const known = await ownSession("known", 301);
    const project = await createProject({ name: "Aug" });
    const task = store.createTask({ title: "x", kind: Kind.coding, channel: "owner", projectId: project.id });
    store.createSession({ id: known.sessionId, taskId: task.id, kind: SessionKind.tmux, cwd: "/", startedBy: "aug" });
    const host = await ownSession("host", 401);
    fake.host = host.pane;
    const tagged = await ownSession("tagged", 501);
    await fake.tagWindow(tagged.pane!, task.id);

    expect((await findStrays()).map((s) => s.claude.sessionId)).toEqual([mine.sessionId]);
  });

  test("a pane id from another tmux server is not this one's pane", async () => {
    const claude = await ownSession("elsewhere", 101);
    fake.panePids.set(claude.pane!, 5000);
    const [stray] = await findStrays();
    expect(stray.pane).toBeNull();
  });

  test("named by id, pane, tmux session or pid; an unknown name lists them", async () => {
    const a = await ownSession("beanstream", 101);
    await ownSession("revdiff", 201);
    const strays = await findStrays();
    expect(matchStray(strays, "beanstream").claude).toBe(a);
    expect(matchStray(strays, a.pane!).claude).toBe(a);
    expect(matchStray(strays, "bean").claude).toBe(a);
    expect(matchStray(strays, "101").claude).toBe(a);
    expect(() => matchStray(strays, "nope")).toThrow(/Strays: bean.*revdiff/);
  });
});

describe("adopting a stray", () => {
  test("a claude in tmux becomes a task whose window moves into the project", async () => {
    const claude = await ownSession("beanstream", 101, "idle");
    const project = await createProject({ name: "Ledger" });
    const [stray] = await findStrays();
    const task = await engine.desk.adoptStray(stray, project.id);

    expect(task.title).toBe("fix-bom");
    expect(task.project_id).toBe(project.id);
    expect(task.repo).toBe("acme/ledger");
    expect(task.branch).toBe("fix-bom");
    expect(task.worktree).toBe("/src/beanstream");
    const window = fake.windows.find((w) => w.id === claude.pane)!;
    expect(window.taskId).toBe(task.id);
    expect(window.sessionId).toBe(fake.sessions.find((s) => s.projectId === project.id)!.id);
    const session = store.getSession(claude.sessionId)!;
    expect(session.tmux_window).toBe(claude.pane);
    expect(session.ended_at).toBeNull();
    // It was idle at its prompt when adopted.
    expect(store.getTask(task.id)!.agent_state).toBe(AgentState.blocked);
    expect(await findStrays()).toEqual([]);
  });

  test("its hooks then reach the task through the project session", async () => {
    const claude = await ownSession("beanstream", 101);
    const project = await createProject({ name: "Ledger" });
    const task = await engine.desk.adoptStray((await findStrays())[0], project.id);
    const env = await adoptHook("stop", { session_id: claude.sessionId }, claude.pane!);
    expect(env).toEqual({ taskId: task.id, sessionId: claude.sessionId });
    expect(store.listTasks().filter((t) => t.kind === Kind.coding)).toHaveLength(1);
  });

  test("the main checkout's branch is not the task's", async () => {
    const shared = { ...git, branch: "main", worktree: false };
    setStraySource({ ...source, git: () => shared });
    await ownSession("beanstream", 101);
    const project = await createProject({ name: "Ledger" });
    const task = await engine.desk.adoptStray((await findStrays())[0], project.id);
    expect(task.title).toBe("beanstream");
    expect(task.branch).toBeNull();
  });

  test("a claude outside tmux is saved, so Start resumes it in the project", async () => {
    setStraySource({ ...source, git: () => ({ ...git, branch: "main", worktree: false }) });
    claudes.push({ pid: 9, sessionId: "term-session", cwd: "/src/ledger", pane: null, name: "ledger export", status: "busy" });
    const project = await createProject({ name: "Ledger" });
    const task = await engine.desk.adoptStray((await findStrays())[0], project.id);
    expect(task.title).toBe("ledger export");
    expect(task.agent_state).toBe(AgentState.saved);

    claudes = [];
    const result = await engine.desk.startAgent(task.id);
    expect(result.type).toBe("started");
    const window = fake.windows.find((w) => w.taskId === task.id)!;
    expect(window.cwd).toBe("/src/ledger");
    expect(window.argv).toContain("--resume");
    expect(window.argv[window.argv.indexOf("--resume") + 1]).toBe("term-session");
  });

  test("a window that cannot be taken leaves no task behind", async () => {
    await ownSession("beanstream", 101);
    const project = await createProject({ name: "Ledger" });
    const [stray] = await findStrays();
    fake.windows = [];
    await expect(engine.desk.adoptStray(stray, project.id)).rejects.toThrow();
    expect(store.listTasks().filter((t) => t.status === TaskStatus.open && t.kind === Kind.coding)).toEqual([]);
  });
});

describe("the adopt move", () => {
  test("lists strays without --claude, adopts one with it", async () => {
    await ownSession("beanstream", 101);
    await createProject({ name: "Ledger" });
    const list = store.enqueueMove("adopt", { project: "Ledger" }, "you");
    await engine.drainMoves();
    expect(store.getMove(list.id)!.result).toStartWith("strays: beanstre (beanstream:claude");

    const move = store.enqueueMove("adopt", { project: "Ledger", claude: "beanstream" }, "you");
    await engine.drainMoves();
    const row = store.getMove(move.id)!;
    expect(row.result).toMatch(/^adopted beanstream:claude .* as AUG-\d+ in Ledger/);
  });

  test("an agent cannot adopt, and an unknown claude says which there are", async () => {
    await ownSession("beanstream", 101);
    await createProject({ name: "Ledger" });
    const byAgent = store.enqueueMove("adopt", { project: "Ledger", claude: "beanstream" }, "agent AUG-0001");
    const unknown = store.enqueueMove("adopt", { project: "Ledger", claude: "nope" }, "you");
    await engine.drainMoves();
    expect(store.getMove(byAgent.id)!.result).toStartWith("adopt is the owner's move");
    expect(store.getMove(unknown.id)!.result).toStartWith("no stray claude nope. Strays: beanstre");
  });
});
