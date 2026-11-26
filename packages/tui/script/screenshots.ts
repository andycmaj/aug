// bun run docs:screenshots: drives `bun run demo` in a private tmux server,
// captures each screen with its colours (capture-pane -e), lays it out as an
// HTML grid and has headless Chrome photograph it into docs/screenshots/.
// Needs tmux and Chrome (CHROME=/path/to/chrome to pick another). Demo mode
// only: the fixture day is fictional, so nothing private can show.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const ROOT = join(import.meta.dir, "../../..");
const OUT = join(ROOT, "docs/screenshots");
const SERVER = "riker-shots";
const SESSION = "shots";
const COLS = 150;
const ROWS = 42;
const CELL_W = 8.4;
const CELL_H = 18;
const PAD = 14;
const SCALE = 1.5;
const BG = "#0a0a0a";
const FG = "#eeeeee";
const CHROME =
  process.env.CHROME ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

type Step = { keys: string[]; wait?: number };
type Shot = { name: string; steps: Step[] };

// Each shot starts from where the one before it left the demo.
const SHOTS: Shot[] = [
  { name: "home", steps: [] },
  {
    name: "task",
    steps: [
      { keys: ["/"] },
      { keys: ["-l", "CSV import"] },
      { keys: ["Enter"], wait: 1500 },
    ],
  },
  {
    name: "review",
    steps: [
      { keys: ["/"] },
      { keys: ["-l", "dark mode toggle"] },
      { keys: ["Enter"], wait: 1500 },
    ],
  },
  {
    name: "project",
    steps: [
      { keys: ["/"] },
      { keys: ["-l", "ledger fixes"] },
      { keys: ["Enter"], wait: 1500 },
    ],
  },
  {
    name: "send",
    steps: [
      { keys: ["/"] },
      { keys: ["-l", "CSV import"] },
      { keys: ["Enter"], wait: 1200 },
      { keys: ["y"], wait: 1000 },
    ],
  },
  {
    name: "board-columns",
    steps: [
      { keys: ["Escape"], wait: 800 },
      { keys: ["v"] },
      { keys: ["2"], wait: 1200 },
    ],
  },
  { name: "board-inbox", steps: [{ keys: ["4"], wait: 1200 }] },
];

const only = process.argv.slice(2);

function tmux(...args: string[]): string {
  const r = Bun.spawnSync(["tmux", "-L", SERVER, ...args], { cwd: ROOT });
  if (r.exitCode !== 0) {
    throw new Error(`tmux ${args.join(" ")}: ${r.stderr.toString()}`);
  }
  return r.stdout.toString();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Style = {
  fg: string;
  bg: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  under: boolean;
  reverse: boolean;
};
const plain = (): Style => ({
  fg: FG,
  bg: BG,
  bold: false,
  dim: false,
  italic: false,
  under: false,
  reverse: false,
});

function rgb(r: number, g: number, b: number): string {
  return `rgb(${r},${g},${b})`;
}

// The 16 base colours, for the odd SGR 30-37/90-97 that is not truecolour.
const BASE = [
  "#000000",
  "#cd3131",
  "#0dbc79",
  "#e5e510",
  "#2472c8",
  "#bc3fbc",
  "#11a8cd",
  "#e5e5e5",
  "#666666",
  "#f14c4c",
  "#23d18b",
  "#f5f543",
  "#3b8eea",
  "#d670d6",
  "#29b8db",
  "#ffffff",
];

function apply(style: Style, params: number[]): void {
  for (let i = 0; i < params.length; i++) {
    const p = params[i] ?? 0;
    if (p === 0) {
      Object.assign(style, plain());
    } else if (p === 1) {
      style.bold = true;
    } else if (p === 2) {
      style.dim = true;
    } else if (p === 3) {
      style.italic = true;
    } else if (p === 4) {
      style.under = true;
    } else if (p === 7) {
      style.reverse = true;
    } else if (p === 22) {
      style.bold = style.dim = false;
    } else if (p === 23) {
      style.italic = false;
    } else if (p === 24) {
      style.under = false;
    } else if (p === 27) {
      style.reverse = false;
    } else if (p === 39) {
      style.fg = FG;
    } else if (p === 49) {
      style.bg = BG;
    } else if (p >= 30 && p <= 37) {
      style.fg = BASE[p - 30] ?? FG;
    } else if (p >= 90 && p <= 97) {
      style.fg = BASE[p - 82] ?? FG;
    } else if (p >= 40 && p <= 47) {
      style.bg = BASE[p - 40] ?? BG;
    } else if (p >= 100 && p <= 107) {
      style.bg = BASE[p - 92] ?? BG;
    } else if (p === 38 || p === 48) {
      const key = p === 38 ? "fg" : "bg";
      if (params[i + 1] === 2) {
        style[key] = rgb(
          params[i + 2] ?? 0,
          params[i + 3] ?? 0,
          params[i + 4] ?? 0,
        );
        i += 4;
      } else if (params[i + 1] === 5) {
        const n = params[i + 2] ?? 0;
        style[key] = n < 16 ? (BASE[n] ?? FG) : xterm256(n);
        i += 2;
      }
    }
  }
}

function xterm256(n: number): string {
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return rgb(v, v, v);
  }
  const c = n - 16;
  const level = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return rgb(
    level(Math.floor(c / 36)),
    level(Math.floor(c / 6) % 6),
    level(c % 6),
  );
}

function css(s: Style): string {
  const fg = s.reverse ? s.bg : s.fg;
  const bg = s.reverse ? s.fg : s.bg;
  const parts = [`color:${fg}`, `background:${bg}`];
  if (s.bold) {
    parts.push("font-weight:bold");
  }
  if (s.dim) {
    parts.push("opacity:.6");
  }
  if (s.italic) {
    parts.push("font-style:italic");
  }
  if (s.under) {
    parts.push("text-decoration:underline");
  }
  return parts.join(";");
}

// A block glyph is drawn as the cell's own colour: the font's glyph is
// shorter than the cell, which would leave gaps in a scrollbar.
const BLOCKS: Record<string, string> = {
  "█": "100%",
  "▀": "top",
  "▄": "bottom",
};

function cell(c: string, style: Style): string {
  const block = BLOCKS[c];
  if (block === undefined) {
    return `<i style="${css(style)}">${escape(c)}</i>`;
  }
  const fg = style.reverse ? style.bg : style.fg;
  const bg = style.reverse ? style.fg : style.bg;
  const fill =
    block === "100%"
      ? fg
      : `linear-gradient(to ${block === "top" ? "bottom" : "top"},${fg} 50%,${bg} 50%)`;
  return `<i style="background:${fill}"></i>`;
}

const escape = (c: string) =>
  c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c;

// One fixed-width cell per character, so a glyph the font draws wide or
// narrow never pushes the grid off the terminal's columns.
function toHtml(ansi: string): string {
  const lines = ansi.replace(/\n$/, "").split("\n").slice(0, ROWS);
  const style = plain();
  const rows = lines.map((line) => {
    let html = "";
    let col = 0;
    const re = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|([\s\S])/gu;
    for (const m of line.matchAll(re)) {
      if (m[1] !== undefined) {
        apply(style, m[1] === "" ? [0] : m[1].split(";").map(Number));
      } else if (m[2] !== undefined && col < COLS) {
        html += cell(m[2], style);
        col++;
      }
    }
    if (col < COLS) {
      html += `<i style="background:${style.bg};width:${(COLS - col) * CELL_W}px"></i>`;
    }
    return `<div>${html}</div>`;
  });
  return `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:${BG}}
body{padding:${PAD}px}
div{height:${CELL_H}px;white-space:pre;display:flex}
i{font:normal 14px/${CELL_H}px Menlo,"SF Mono","CaskaydiaCove Nerd Font","Symbols Nerd Font",monospace;width:${CELL_W}px;height:${CELL_H}px;display:inline-block;text-align:center;overflow:visible}
</style>${rows.join("")}`;
}

async function capture(name: string, scratch: string): Promise<void> {
  const html = join(scratch, `${name}.html`);
  writeFileSync(html, toHtml(tmux("capture-pane", "-p", "-e", "-t", SESSION)));
  const w = Math.ceil(COLS * CELL_W + PAD * 2);
  const h = Math.ceil(ROWS * CELL_H + PAD * 2);
  const png = join(OUT, `${name}.png`);
  const r = Bun.spawnSync([
    CHROME,
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--force-device-scale-factor=${SCALE}`,
    `--window-size=${w},${h}`,
    `--screenshot=${png}`,
    `file://${html}`,
  ]);
  if (r.exitCode !== 0) {
    throw new Error(`chrome: ${r.stderr.toString()}`);
  }
  console.log(`wrote docs/screenshots/${name}.png`);
}

const scratch = join(tmpdir(), `riker-shots-${process.pid}`);
mkdirSync(scratch, { recursive: true });
mkdirSync(OUT, { recursive: true });
Bun.spawnSync(["tmux", "-L", SERVER, "kill-server"]);
tmux(
  "new-session",
  "-d",
  "-s",
  SESSION,
  "-x",
  String(COLS),
  "-y",
  String(ROWS),
  "bun run demo",
);
tmux("set-option", "-t", SESSION, "status", "off");
try {
  await sleep(6000);
  for (const shot of SHOTS) {
    for (const step of shot.steps) {
      tmux("send-keys", "-t", SESSION, ...step.keys);
      await sleep(step.wait ?? 400);
    }
    if (only.length === 0 || only.includes(shot.name)) {
      await capture(shot.name, scratch);
    }
  }
} finally {
  Bun.spawnSync(["tmux", "-L", SERVER, "kill-server"]);
  rmSync(scratch, { recursive: true, force: true });
}
