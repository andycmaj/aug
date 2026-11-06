// The emulator renders output but never answers a program's terminal queries,
// so programs like nvim wait and then warn ("Terminal did not respond to DSR
// request"). Answer the common ones the way an xterm would.

export interface ReplyContext {
  // 0-based cursor position after the chunk was fed.
  cursor: [number, number];
  foreground: string;
  background: string;
}

// "#1a1b26" -> "rgb:1a1a/1b1b/2626", the 16-bit form xterm reports.
function oscColor(hex: string): string {
  const h = hex.replace("#", "").padEnd(6, "0").slice(0, 6);
  const c = (i: number) => h.slice(i, i + 2).repeat(2);
  return `rgb:${c(0)}/${c(2)}/${c(4)}`;
}

const QUERY =
  /\x1b\[(\??)([56])n|\x1b\[(>?)0?c|\x1b\](1[01]);\?(?:\x07|\x1b\\)/g;

export function terminalReplies(output: string, ctx: ReplyContext): string {
  let replies = "";
  for (const m of output.matchAll(QUERY)) {
    if (m[2] === "6")
      replies += `\x1b[${m[1]}${ctx.cursor[1] + 1};${ctx.cursor[0] + 1}R`;
    else if (m[2] === "5") replies += "\x1b[0n";
    else if (m[3] !== undefined && m[4] === undefined && m[0].endsWith("c")) {
      replies += m[3] === ">" ? "\x1b[>0;10;0c" : "\x1b[?62;22c";
    } else if (m[4]) {
      const color = m[4] === "10" ? ctx.foreground : ctx.background;
      replies += `\x1b]${m[4]};${oscColor(color)}\x1b\\`;
    }
  }
  return replies;
}
