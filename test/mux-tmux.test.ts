import { afterEach, describe, expect, test } from "bun:test";
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
    tmux(s, "switch-client", "-c", other, "-t", "aug-view-test");

    await until(() => clients(s).filter((c) => c.session === "proj").length === 2);
    expect(clients(s).find((c) => c.name === augClient)?.session).toBe("aug-view-test");
    expect(tmux(s, "show-options", "-v", "-t", "proj:", "prefix")).toBe("");
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
