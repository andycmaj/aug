// The system clipboard, for a program in a pane that asks for it through
// OSC 52. Empty when there is no tool to read it with: an empty answer still
// lets the program go on, where no answer leaves it waiting.

function readers(): string[][] {
  if (process.platform === "darwin") return [["pbpaste"]];
  const out: string[][] = [];
  if (process.env.WAYLAND_DISPLAY) out.push(["wl-paste", "--no-newline"]);
  if (process.env.DISPLAY) out.push(["xclip", "-selection", "clipboard", "-o"], ["xsel", "-bo"]);
  return out;
}

export function readClipboard(): string {
  for (const argv of readers()) {
    try {
      const run = Bun.spawnSync(argv, { stdin: "ignore", stderr: "ignore", timeout: 1000 });
      if (run.exitCode === 0) return run.stdout.toString();
    } catch {
      // Not installed: try the next one.
    }
  }
  return "";
}
