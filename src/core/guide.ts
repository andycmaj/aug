// The guide action's second half (docs/task-actions-design.md, guide): the
// skill answers with Plannotator guide JSON (chapters, plus review findings
// as line notes); aug makes the patch itself, so the guide describes exactly
// what is in the checkout, fits the guide to it, and saves it into
// Plannotator, where `plannotator review` lists it under Guides.
//
// Plannotator keeps a saved guide's notes but draws them nowhere. A live
// `plannotator review` session takes comments over HTTP
// (/api/external-annotations) and pins them to their lines, in the diff and
// in the guide alike, so the findings are posted there once it is up.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { errorMessage, logger } from "./log";

const log = logger("guide");

export interface GuideNote {
  lineStart: number;
  lineEnd: number;
  side?: "old" | "new";
  text: string;
}

export interface GuideDiff {
  file: string;
  summary: string;
  notes?: GuideNote[];
}

export interface GuideSection {
  title: string;
  overview: string;
  diffs: GuideDiff[];
}

export interface Guide {
  title: string;
  intent: string;
  sections: GuideSection[];
  unplacedFiles: string[];
}

const NOTE_TEXT_MAX = 1000;
const NOTES_PER_FILE_MAX = 20;

// The JSON object in the skill's answer: a ```json fence, or the whole text.
export function parseGuide(text: string): Guide | { error: string } {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  const raw = (fenced?.[1] ?? text).trim();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return { error: `the guide is not JSON: ${errorMessage(err)}` };
  }
  if (!isRecord(value)) return { error: "the guide is not a JSON object" };
  const sections = Array.isArray(value.sections) ? value.sections : [];
  const guide: Guide = {
    title: str(value.title) || "Guided review",
    intent: str(value.intent),
    sections: sections.filter(isRecord).map((s) => ({
      title: str(s.title) || "Changes",
      overview: str(s.overview),
      diffs: (Array.isArray(s.diffs) ? s.diffs : []).filter(isRecord).map((d) => ({
        file: str(d.file),
        summary: str(d.summary),
        notes: (Array.isArray(d.notes) ? d.notes : []).filter(isRecord).flatMap((n) => {
          const lineStart = Number(n.lineStart);
          const lineEnd = Number(n.lineEnd ?? n.lineStart);
          const text = str(n.text).slice(0, NOTE_TEXT_MAX);
          if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd) || !text) return [];
          return [{ lineStart, lineEnd, ...(n.side === "old" ? { side: "old" as const } : {}), text }];
        }),
      })),
    })),
    unplacedFiles: (Array.isArray(value.unplacedFiles) ? value.unplacedFiles : []).map(str),
  };
  if (guide.sections.length === 0) return { error: "the guide has no chapters" };
  return guide;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

// ── the patch ─────────────────────────────────────────────────────────────

export interface Patch {
  text: string;
  // The merge base the diff is taken from, and the branch it came from.
  mergeBase: string;
  base: string;
}

// `git diff <merge-base>`: the branch's change plus edits not yet
// committed, as Plannotator's own guides take it.
export function patchFor(cwd: string, base: string): Patch | { error: string } {
  for (const b of base === "main" ? ["main", "master"] : [base]) {
    const mb = git(cwd, ["merge-base", b, "HEAD"]);
    if (!mb.ok) continue;
    const diff = git(cwd, ["diff", "--no-color", "--no-ext-diff", mb.out.trim()]);
    if (!diff.ok) return { error: `git diff failed: ${diff.out}` };
    const text = diff.out + untracked(cwd);
    if (!text.trim()) return { error: `no change against ${b}` };
    return { text, mergeBase: mb.out.trim(), base: b };
  }
  return { error: `no merge base with ${base} in ${cwd}` };
}

// New files the agent has not added are in the change too. Each is diffed
// against /dev/null rather than `git add -N`, which would touch the
// agent's index.
const UNTRACKED_MAX = 50;

function untracked(cwd: string): string {
  const list = git(cwd, ["ls-files", "--others", "--exclude-standard"]);
  if (!list.ok) return "";
  return list.out
    .split("\n")
    .filter(Boolean)
    .slice(0, UNTRACKED_MAX)
    .map((file) => {
      // Exit 1 means "they differ", which is the point.
      const r = Bun.spawnSync(
        ["git", "-C", cwd, "diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", file],
        { stdout: "pipe", stderr: "pipe" },
      );
      return r.stdout.toString();
    })
    .join("");
}

function git(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = r.exitCode === 0 ? r.stdout.toString() : r.stderr.toString().trim();
  return { ok: r.exitCode === 0, out };
}

interface FileHunks {
  // [start, end] line ranges, inclusive, per side.
  new: [number, number][];
  old: [number, number][];
}

// The files a patch touches, each with its hunks' line ranges.
export function patchHunks(patch: string): Map<string, FileHunks> {
  const files = new Map<string, FileHunks>();
  let current: FileHunks | null = null;
  for (const line of patch.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      current = { new: [], old: [] };
      files.set(header[2]!, current);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const span = (start: string, len?: string): [number, number] => {
        const s = Number(start);
        const n = len === undefined ? 1 : Number(len);
        return [s, s + Math.max(n, 1) - 1];
      };
      current.old.push(span(hunk[1]!, hunk[2]));
      current.new.push(span(hunk[3]!, hunk[4]));
    }
  }
  return files;
}

// The guide made to fit the patch: chapters name only files in it, each
// once; the rest go to unplacedFiles; a note outside its file's hunks is
// left off the file. Every note becomes a review comment: on its lines when
// they are in one hunk, else on its file.
export function fitGuide(
  guide: Guide,
  patch: string,
): { guide: Guide; findings: number; lines: string[]; comments: ReviewComment[] } {
  const hunks = patchHunks(patch);
  const placed = new Set<string>();
  let findings = 0;
  const lines: string[] = [];
  const comments: ReviewComment[] = [];
  const sections: GuideSection[] = [];
  for (const section of guide.sections) {
    const diffs: GuideDiff[] = [];
    for (const diff of section.diffs) {
      const file = hunks.get(diff.file);
      if (!file || placed.has(diff.file)) continue;
      placed.add(diff.file);
      const notes = (diff.notes ?? []).slice(0, NOTES_PER_FILE_MAX);
      findings += notes.length;
      const pinned: GuideNote[] = [];
      for (const n of notes) {
        lines.push(`- \`${diff.file}\` ${lineWord(n)}: ${n.text}`);
        if (insideOneHunk(n, file)) {
          pinned.push(n);
          comments.push(lineComment(diff.file, n));
        } else comments.push(fileComment(diff.file, n));
      }
      diffs.push({ file: diff.file, summary: diff.summary, ...(pinned.length ? { notes: pinned } : {}) });
    }
    if (diffs.length > 0) sections.push({ ...section, diffs });
  }
  const unplaced = [...hunks.keys()].filter((f) => !placed.has(f));
  return {
    guide: { ...guide, sections, unplacedFiles: unplaced },
    findings,
    lines,
    comments,
  };
}

function lineWord(n: GuideNote): string {
  const span = n.lineEnd > n.lineStart ? `L${n.lineStart}-L${n.lineEnd}` : `L${n.lineStart}`;
  return n.side === "old" ? `${span} (removed)` : span;
}

function insideOneHunk(n: GuideNote, file: FileHunks): boolean {
  const ranges = n.side === "old" ? file.old : file.new;
  return n.lineEnd >= n.lineStart && ranges.some(([s, e]) => n.lineStart >= s && n.lineEnd <= e);
}

// ── review comments ───────────────────────────────────────────────────────

// One comment as /api/external-annotations takes it.
export interface ReviewComment {
  source: string;
  author: string;
  scope: "line" | "file";
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  side?: "old" | "new";
  type: "comment" | "concern";
  text: string;
}

// Who the comments are from, so the owner can tell them from their own, and
// a re-run can clear them by source.
export const COMMENT_SOURCE = "aug-guide";
const COMMENT_AUTHOR = "aug guide";

// Bug and Risk are concerns; Test and Nit are comments.
function commentType(text: string): ReviewComment["type"] {
  return /^(bug|risk)\b/i.test(text) ? "concern" : "comment";
}

function lineComment(filePath: string, n: GuideNote): ReviewComment {
  return {
    source: COMMENT_SOURCE,
    author: COMMENT_AUTHOR,
    scope: "line",
    filePath,
    lineStart: n.lineStart,
    lineEnd: n.lineEnd,
    side: n.side ?? "new",
    type: commentType(n.text),
    text: n.text,
  };
}

// A note on lines no hunk shows: on its file, saying which lines.
function fileComment(filePath: string, n: GuideNote): ReviewComment {
  return {
    source: COMMENT_SOURCE,
    author: COMMENT_AUTHOR,
    scope: "file",
    filePath,
    type: commentType(n.text),
    text: `${lineWord(n)}: ${n.text}`,
  };
}

// A port nothing listens on, for the review aug opens (PLANNOTATOR_PORT),
// so aug knows where to post.
export function freePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = server.port;
  void server.stop(true);
  if (port === undefined) throw new Error("no free port");
  return port;
}

// The comments posted into the review on `port`, as one batch, once it
// answers: `plannotator review` takes a few seconds to come up.
export async function postComments(
  port: number,
  comments: ReviewComment[],
  opts: { waitMs?: number; everyMs?: number } = {},
): Promise<{ ok: true } | { error: string }> {
  if (comments.length === 0) return { ok: true };
  const deadline = Date.now() + (opts.waitMs ?? 60_000);
  const url = `http://127.0.0.1:${port}/api/external-annotations`;
  let last = "Plannotator did not answer";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ annotations: comments }),
      });
      if (res.ok) return { ok: true };
      // It is up and refused them: trying again will not help.
      last = `Plannotator refused the comments (${res.status}): ${(await res.text()).slice(0, 200)}`;
      log.warn("comments refused", { port, error: last });
      return { error: last };
    } catch (err) {
      last = errorMessage(err);
    }
    await Bun.sleep(opts.everyMs ?? 500);
  }
  log.warn("comments not posted", { port, error: last });
  return { error: last };
}

// A Plannotator guide snapshot, format v4 (the one that carries notes).
export function snapshot(guide: Guide, patch: Patch): Record<string, unknown> {
  return {
    kind: "plannotator-guided-review",
    version: 4,
    exportedAt: new Date().toISOString(),
    guide: { ...guide, reviewed: guide.sections.map(() => false) },
    review: { rawPatch: patch.text, gitRef: `${patch.base}...HEAD` },
    source: { kind: "local" },
  };
}

// ── saving it into Plannotator ────────────────────────────────────────────

export interface GuideTool {
  // `plannotator guide import --snapshot`: the saved guide's id.
  save(file: string, cwd: string, pr?: string): Promise<{ id: string } | { error: string }>;
}

const plannotator: GuideTool = {
  async save(file, cwd, pr) {
    const bin = Bun.which("plannotator");
    if (!bin) return { error: "plannotator is not on PATH" };
    const proc = Bun.spawn(
      [bin, "guide", "import", "--snapshot", file, ...(pr ? ["--pr", pr] : [])],
      { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, PLANNOTATOR_UPDATE_CHECK: "0" } },
    );
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) return { error: (err || out).trim().split("\n").pop() || `plannotator exited ${code}` };
    const id = out.trim().split("\n")[0]?.trim();
    return id ? { id } : { error: "plannotator printed no guide id" };
  },
};

let tool: GuideTool = plannotator;

export function setGuideTool(next: GuideTool | null): void {
  tool = next ?? plannotator;
}

export interface SavedGuide {
  id: string;
  file: string;
  guide: Guide;
  findings: number;
  // One Markdown line per finding.
  lines: string[];
  comments: ReviewComment[];
  patch: Patch;
}

// The skill's answer, fitted to the checkout's patch, written to `dir` and
// saved into Plannotator.
export async function saveGuide(opts: {
  answer: string;
  cwd: string;
  base: string;
  dir: string;
  pr?: string;
}): Promise<SavedGuide | { error: string }> {
  const parsed = parseGuide(opts.answer);
  if ("error" in parsed) return parsed;
  const patch = patchFor(opts.cwd, opts.base);
  if ("error" in patch) return patch;
  const { guide, findings, lines, comments } = fitGuide(parsed, patch.text);
  if (guide.sections.length === 0) return { error: "no chapter of the guide names a file in the change" };
  mkdirSync(opts.dir, { recursive: true });
  const file = join(opts.dir, "guide.json");
  writeFileSync(file, `${JSON.stringify(snapshot(guide, patch), null, 2)}\n`);
  const saved = await tool.save(file, opts.cwd, opts.pr);
  if ("error" in saved) {
    log.warn("guide import failed", { file, error: saved.error });
    return { error: `plannotator did not take the guide: ${saved.error}` };
  }
  return { id: saved.id, file, guide, findings, lines, comments, patch };
}

// What the action's turn says: the chapters, then the findings by file.
export function guideMarkdown(saved: SavedGuide): string {
  const notes = saved.guide.sections.flatMap((s) =>
    s.diffs.flatMap((d) => (d.notes ?? []).map((n) => ({ file: d.file, n }))),
  );
  const unpinned = saved.findings - notes.length;
  return [
    `**${saved.guide.title}**`,
    saved.guide.intent,
    "",
    `${saved.guide.sections.length} chapter${saved.guide.sections.length === 1 ? "" : "s"}: ${saved.guide.sections.map((s) => s.title).join("; ")}.`,
    saved.findings
      ? `${saved.findings} review note${saved.findings === 1 ? "" : "s"}${unpinned > 0 ? ` (${unpinned} not on a changed line)` : ""}:`
      : "No review notes: nothing stood out.",
    ...saved.lines,
    "",
    `Saved in Plannotator (\`${saved.id}\`). The review aug opens has these notes as comments; its Agents tab lists the guide.`,
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}
