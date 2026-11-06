// What an agent made: the files a turn left in its task's scratch folder,
// read back for the chat (a CSV as a small table) and opened with the
// owner's viewer.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { loadConfig } from "./config";

export interface MadeFile {
  path: string;
  name: string;
  bytes: number;
}

export type DirSnapshot = Map<string, { mtimeMs: number; size: number }>;

const MAX_DEPTH = 3;
const MAX_FILES = 500;

export function snapshotDir(dir: string): DirSnapshot {
  const out: DirSnapshot = new Map();
  const walk = (at: string, depth: number) => {
    if (depth > MAX_DEPTH || out.size >= MAX_FILES || !existsSync(at)) return;
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(at, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) {
        const st = statSync(full);
        out.set(full, { mtimeMs: st.mtimeMs, size: st.size });
      }
    }
  };
  walk(dir, 0);
  return out;
}

// New or rewritten since `before`, named relative to the folder.
export function changedFiles(
  dir: string,
  before: DirSnapshot,
  after: DirSnapshot,
): MadeFile[] {
  const made: MadeFile[] = [];
  for (const [path, st] of after) {
    const was = before.get(path);
    if (was && was.mtimeMs === st.mtimeMs && was.size === st.size) continue;
    made.push({
      path,
      name: relative(dir, path) || basename(path),
      bytes: st.size,
    });
  }
  return made.sort((a, b) => a.name.localeCompare(b.name));
}

export function parseFiles(json: string | null | undefined): MadeFile[] {
  try {
    const value = JSON.parse(json || "[]") as unknown;
    return Array.isArray(value) ? (value as MadeFile[]) : [];
  } catch {
    return [];
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export type Preview = "markdown" | "table" | "none";

export function previewOf(name: string): Preview {
  if (/\.(md|markdown|txt)$/i.test(name)) return "markdown";
  if (/\.(csv|tsv)$/i.test(name)) return "table";
  return "none";
}

// RFC 4180-ish: quoted fields, doubled quotes, delimiters and newlines inside quotes.
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// A table squeezed into `width` columns: each column gets its widest cell,
// shrunk evenly when they do not fit.
export function tableLines(
  rows: string[][],
  width: number,
  maxRows = 20,
): string[] {
  const shown = rows.slice(0, maxRows);
  const cols = Math.max(0, ...shown.map((r) => r.length));
  if (cols === 0) return [];
  const widths = Array.from({ length: cols }, (_, c) =>
    Math.max(1, ...shown.map((r) => (r[c] ?? "").length)),
  );
  const gap = 2;
  let total = widths.reduce((a, b) => a + b, 0) + gap * (cols - 1);
  while (total > width && Math.max(...widths) > 4) {
    const widest = widths.indexOf(Math.max(...widths));
    widths[widest]--;
    total--;
  }
  const cell = (s: string, w: number) =>
    s.length > w ? `${s.slice(0, Math.max(1, w - 1))}…` : s.padEnd(w);
  const lines = shown.map((r) =>
    widths
      .map((w, c) => cell(r[c] ?? "", w))
      .join(" ".repeat(gap))
      .trimEnd(),
  );
  if (rows.length > maxRows) lines.push(`… ${rows.length - maxRows} more rows`);
  return lines;
}

export function readPreview(file: MadeFile, maxChars = 20_000): string | null {
  try {
    if (!existsSync(file.path)) return null;
    return readFileSync(file.path, "utf8").slice(0, maxChars);
  } catch {
    return null;
  }
}

// ── opening a link or a file ─────────────────────────────────────────────

export function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

export function openerArgv(
  target: string,
  opener: string | string[] | undefined = loadConfig().opener,
  platform: NodeJS.Platform = process.platform,
  wsl: boolean = isWsl(),
): string[] {
  if (Array.isArray(opener) && opener.length) return [...opener, target];
  if (typeof opener === "string" && opener.trim())
    return [...opener.trim().split(/\s+/), target];
  if (wsl) return ["wslview", target];
  if (platform === "darwin") return ["open", target];
  if (platform === "win32") return ["cmd", "/c", "start", "", target];
  return ["xdg-open", target];
}

export function openTarget(target: string): void {
  Bun.spawn(openerArgv(target), {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).unref();
}
