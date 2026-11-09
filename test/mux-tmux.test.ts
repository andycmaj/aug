import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { TmuxMux } from "../src/core/mux";

// Real tmux on private servers. Clients need a terminal, so a second server
// ("host") gives each one a pane to run in.
const hasTmux = Bun.spawnSync(["tmux", "-V"]).exitCode === 0;
const servers: string[] = [];

function tmux(socket: string, ...args: string[]): string {
  const run = Bun.spawnSync(["tmux", "-L", socket, "-f", "/dev/null", ...args], {
    env: { ...process.env, TMUX: "" },
  });
  return run.stdout.toString().trim();
}

function server(tag: string): string {
  const name = `aug-test-${tag}-${process.pid}`;
  servers.push(name);
  return name;
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (check()) return;
    await Bun.sleep(50);
  }
  throw new Error("timed out");
}

function clients(socket: string): { name: string; session: string }[] {
  return tmux(socket, "list-clients", "-F", "#{client_name} #{session_name}")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name = "", session = ""] = line.split(" ");
      return { name, session };
    });
}

afterEach(() => {
  for (const s of servers.splice(0)) tmux(s, "kill-server");
});

function windows(socket: string): string[] {
  return tmux(socket, "list-windows", "-a", "-F", "#{session_name} #{window_id}")
    .split("\n")
    .filter(Boolean);
}

// A project session with two windows, and aug's viewer on the first.
async function withViewer() {
  const s = server("s");
  const host = server("host");
  tmux(s, "new-session", "-d", "-s", "proj");
  tmux(s, "new-window", "-t", "proj:");
  tmux(s, "new-session", "-d", "-s", "outer");
  const projId = tmux(s, "display", "-p", "-t", "proj:", "#{session_id}");
  const outerId = tmux(s, "display", "-p", "-t", "outer:", "#{session_id}");
  const windowId = tmux(s, "display", "-p", "-t", "proj:0", "#{window_id}");

  const argv = new TmuxMux(s).viewerArgv("aug-view-test", projId, windowId);
  // The host runs a shell-command string through sh, so quote each arg.
  const shell = argv.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(" ");
  tmux(host, "new-session", "-d", "-x", "100", "-y", "30", "-s", "aug", shell);
  await until(() => windows(s).includes(`aug-view-test ${windowId}`));
  return { s, host, projId, outerId, windowId };
}

describe.skipIf(!hasTmux)("viewer session", () => {
  test("holds the task's window and nothing else, outside any group", async () => {
    const { s, windowId } = await withViewer();
    expect(windows(s).filter((w) => w.startsWith("aug-view-test "))).toEqual([
      `aug-view-test ${windowId}`,
    ]);
    // tmux 3.7's choose-tree draws an empty tree while any group exists.
    expect(tmux(s, "list-sessions", "-F", "#{session_grouped}").split("\n")).not.toContain("1");
  });

  test("only aug's own client stays in it; anyone else lands in the project", async () => {
    const { s, host } = await withViewer();
    const augClient = clients(s)[0]?.name;

    const attach = `env -u TMUX tmux -L ${s} attach -t`;
    tmux(host, "new-window", "-t", "aug:", `${attach} aug-view-test`);
    tmux(host, "new-window", "-t", "aug:", `${attach} outer`);
    await until(() => clients(s).length === 3);
    const other = clients(s).find((c) => c.session === "outer")?.name ?? "";
    // aug's client is the viewer's most recent one; a hook's own client is
    // not the one that came in.
    tmux(host, "send-keys", "-t", "aug:0", "x");
    await Bun.sleep(50);
    tmux(s, "switch-client", "-c", other, "-t", "aug-view-test");

    await until(() => clients(s).filter((c) => c.session === "proj").length === 2);
    expect(clients(s).find((c) => c.name === augClient)?.session).toBe("aug-view-test");
    expect(tmux(s, "show-options", "-v", "-t", "proj:", "prefix")).toBe("");
  });

  test("jumping to a viewed window lands in the project, not the viewer", async () => {
    const { s, host, projId, windowId } = await withViewer();
    tmux(host, "new-window", "-t", "aug:", `env -u TMUX tmux -L ${s} attach -t outer`);
    await until(() => clients(s).length === 2);
    const other = clients(s).find((c) => c.session === "outer")?.name ?? "";

    // Unscoped, tmux picks the newest session holding the window: the
    // viewer, with no prefix and no status bar.
    await new TmuxMux(s).switchClient(projId, windowId);

    await until(() => clients(s).find((c) => c.name === other)?.session !== "outer");
    expect(clients(s).find((c) => c.name === other)?.session).toBe("proj");
    expect(tmux(s, "display", "-p", "-c", other, "#{window_id}")).toBe(windowId);
  });

  test("moving a viewed window takes it out of the project, not the viewer", async () => {
    const { s, projId, outerId, windowId } = await withViewer();
    await new TmuxMux(s).moveWindow(windowId, projId, outerId);
    const holders = windows(s)
      .filter((w) => w.endsWith(` ${windowId}`))
      .map((w) => w.split(" ")[0]);
    expect(holders.sort()).toEqual(["aug-view-test", "outer"]);
  });
});

describe.skipIf(!hasTmux)("split pane", () => {
  test("a diff viewer splits the viewed window, so the viewer shows it", async () => {
    const { s, windowId } = await withViewer();
    const claude = tmux(s, "display", "-p", "-t", windowId, "#{pane_id}");
    const mux = new TmuxMux(s);

    const paneId = await mux.splitPane({ paneId: claude, cwd: "/tmp", argv: ["cat"], zoom: true });
    expect(tmux(s, "display", "-p", "-t", "aug-view-test:", "#{pane_id} #{window_zoomed_flag}")).toBe(
      `${paneId} 1`,
    );
    expect(windows(s).filter((w) => w.endsWith(` ${windowId}`))).toHaveLength(2);
    expect(await mux.paneAlive(paneId)).toBe(true);

    // aug's lines still reach claude, not the viewer that has focus.
    await mux.sendLine(windowId, "hello");
    await until(() => tmux(s, "capture-pane", "-p", "-t", claude).includes("hello"));
    expect(tmux(s, "capture-pane", "-p", "-t", paneId)).not.toContain("hello");

    tmux(s, "kill-pane", "-t", paneId);
    expect(await mux.paneAlive(paneId)).toBe(false);
    expect(tmux(s, "display", "-p", "-t", windowId, "#{window_panes} #{window_zoomed_flag}")).toBe("1 0");
  });

  test("the exit code reaches the file a waiting caller reads", async () => {
    const s = server("s");
    tmux(s, "new-session", "-d", "-s", "proj");
    const claude = tmux(s, "display", "-p", "-t", "proj:", "#{pane_id}");
    const exitFile = `${tmpdir()}/aug-pane-exit-${process.pid}`;
    const mux = new TmuxMux(s);

    const paneId = await mux.splitPane({ paneId: claude, cwd: "/tmp", argv: ["sh", "-c", "exit 10"], zoom: false, exitFile });
    await until(() => !tmux(s, "list-panes", "-a", "-F", "#{pane_id}").split("\n").includes(paneId));
    expect(readFileSync(exitFile, "utf8").trim()).toBe("10");
    rmSync(exitFile, { force: true });
  });

  test("a tagged window says how to reach aug-tools", async () => {
    const s = server("s");
    tmux(s, "new-session", "-d", "-s", "proj");
    const windowId = tmux(s, "display", "-p", "-t", "proj:", "#{window_id}");
    await new TmuxMux(s).tagWindow(windowId, 7);
    expect(tmux(s, "display", "-p", "-t", windowId, "#{@aug_task}")).toBe("7");
    expect(tmux(s, "display", "-p", "-t", windowId, "#{@aug_tools}")).toContain("aug-tools.ts");
  });
});

describe.skipIf(!hasTmux)("host window", () => {
  function inPane(s: string, pane: string): Record<string, string> {
    const pid = tmux(s, "display", "-p", "-t", pane, "#{pid}");
    return { TMUX: `/tmp/whatever,${pid},0`, TMUX_PANE: pane };
  }

  async function hostWith(env: Record<string, string>, s: string): Promise<string | null> {
    const saved = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
    Object.assign(process.env, env);
    try {
      return await new TmuxMux(s).hostWindow();
    } finally {
      for (const [k, v] of Object.entries(saved))
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
  }

  test("names the window aug's own pane is in", async () => {
    const s = server("s");
    tmux(s, "new-session", "-d", "-s", "proj");
    const pane = tmux(s, "display", "-p", "-t", "proj:", "#{pane_id}");
    const windowId = tmux(s, "display", "-p", "-t", "proj:", "#{window_id}");
    expect(await hostWith(inPane(s, pane), s)).toBe(windowId);
  });

  test("is nothing when aug runs on another server, even with a pane id that exists here", async () => {
    const s = server("s");
    tmux(s, "new-session", "-d", "-s", "proj");
    const pane = tmux(s, "display", "-p", "-t", "proj:", "#{pane_id}");
    expect(await hostWith({ TMUX: "/tmp/other,1,0", TMUX_PANE: pane }, s)).toBeNull();
    expect(await hostWith({ TMUX: "", TMUX_PANE: "" }, s)).toBeNull();
  });
});
