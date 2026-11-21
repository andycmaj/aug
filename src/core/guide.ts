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
//
// Plannotator cannot hold them for a review opened later (its drafts are
// the page's own), so aug keeps them beside guide.json
// (guide-findings.json) and posts them into whichever review it opens for
// that guide: right after the run, or later from the task's actions, refit
// to the patch as it is then.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
// left off the file. Every note becomes a review comment (reviewComments).
export function fitGuide(
  guide: Guide,
  patch: string,
): { guide: Guide; findings: Finding[]; lines: string[]; comments: ReviewComment[] } {
  const hunks = patchHunks(patch);
  const placed = new Set<string>();
  const findings: Finding[] = [];
  const lines: string[] = [];
  const sections: GuideSection[] = [];
  for (const section of guide.sections) {
    const diffs: GuideDiff[] = [];
    for (const diff of section.diffs) {
      const file = hunks.get(diff.file);
      if (!file || placed.has(diff.file)) continue;
      placed.add(diff.file);
      const notes = (diff.notes ?? []).slice(0, NOTES_PER_FILE_MAX);
      const pinned: GuideNote[] = [];
      for (const n of notes) {
        findings.push({ file: diff.file, note: n });
        lines.push(`- \`${diff.file}\` ${lineWord(n)}: ${n.text}`);
        if (insideOneHunk(n, file)) pinned.push(n);
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
    comments: reviewComments(findings, patch).comments,
  };
}

// One review note and the file it is on, as the skill wrote it: kept so a
// review opened later fits it to the patch as it is then.
export interface Finding {
  file: string;
  note: GuideNote;
}

// The findings as review comments on `patch`: on their lines when one hunk
// shows them, else on their file naming the lines. A file the patch no
// longer touches has nowhere to show one, so its findings are left out.
export function reviewComments(
  findings: Finding[],
  patch: string,
): { comments: ReviewComment[]; dropped: number } {
  const hunks = patchHunks(patch);
  const comments: ReviewComment[] = [];
  let dropped = 0;
  for (const { file, note } of findings) {
    const fileHunks = hunks.get(file);
    if (!fileHunks) dropped++;
    else if (insideOneHunk(note, fileHunks)) comments.push(lineComment(file, note));
    else comments.push(fileComment(file, note));
  }
  return { comments, dropped };
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
  const base = `http://127.0.0.1:${port}`;
  let last = "Plannotator did not answer";
  while (Date.now() < deadline) {
    try {
      // The port was free when aug picked it; make sure Plannotator is the
      // one that took it before handing it the findings.
      const diff = await fetch(`${base}/api/diff`);
      const body: unknown = diff.ok ? await diff.json().catch(() => null) : null;
      if (!isRecord(body) || typeof body.rawPatch !== "string") {
        last = `port ${port} is not a Plannotator review`;
        log.warn("comments not posted", { port, error: last });
        return { error: last };
      }
      // aug's comments from before (a review reused, a draft brought back)
      // go first, so the findings are there once.
      const cleared = await fetch(`${base}/api/external-annotations?source=${COMMENT_SOURCE}`, {
        method: "DELETE",
      });
      if (!cleared.ok) log.warn("old comments not cleared", { port, status: cleared.status });
      const res = await fetch(`${base}/api/external-annotations`, {
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
  findings: Finding[];
  // One Markdown line per finding.
  lines: string[];
  comments: ReviewComment[];
  patch: Patch;
}

// What a review opened later needs, beside guide.json.
export const FINDINGS_FILE = "guide-findings.json";

export interface SavedFindings {
  id: string;
  title: string;
  base: string;
  findings: Finding[];
}

export function readFindings(dir: string): SavedFindings | null {
  const file = join(dir, FINDINGS_FILE);
  if (!existsSync(file)) return null;
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!isRecord(value) || !Array.isArray(value.findings)) return null;
    return {
      id: str(value.id),
      title: str(value.title),
      base: str(value.base) || "main",
      findings: value.findings.filter(isRecord).flatMap((f) => {
        const n = isRecord(f.note) ? f.note : null;
        if (!n || typeof f.file !== "string") return [];
        const lineStart = Number(n.lineStart);
        const lineEnd = Number(n.lineEnd);
        const text = str(n.text);
        if (!Number.isInteger(lineStart) || !Number.isInteger(lineEnd) || !text) return [];
        return [{ file: f.file, note: { lineStart, lineEnd, ...(n.side === "old" ? { side: "old" as const } : {}), text } }];
      }),
    };
  } catch (err) {
    log.warn("saved findings unreadable", { file, err });
    return null;
  }
}

// The skill's answer, fitted to the checkout's patch, written to `dir` and
// saved into Plannotator.
export async function saveGuide(opts: {
  answer: string;
  cwd: string;
  base: string;
  dir: string;
  pr?: string;
  // The patch the skill was handed; taken now when none was.
  patch?: Patch;
}): Promise<SavedGuide | { error: string }> {
  const parsed = parseGuide(opts.answer);
  if ("error" in parsed) return parsed;
  const patch = opts.patch ?? patchFor(opts.cwd, opts.base);
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
  const kept: SavedFindings = { id: saved.id, title: guide.title, base: patch.base, findings };
  writeFileSync(join(opts.dir, FINDINGS_FILE), `${JSON.stringify(kept, null, 2)}\n`);
  return { id: saved.id, file, guide, findings, lines, comments, patch };
}

// The diff handed to the skill, so it reviews exactly the patch its notes
// are placed on, and needs no shell to read it (a fork of a coding session
// chains commands out of habit, and a chained command is denied).
export const PATCH_FILE = "guide-patch.diff";

export function writePatch(dir: string, patch: Patch): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, PATCH_FILE);
  writeFileSync(file, numberedPatch(patch.text));
  return file;
}

// The diff with each hunk line's old and new line number in front: read
// through the Read tool, a bare diff's only numbers are the file's own,
// and a note pinned to those lands on the wrong lines.
const NUMBERED_HEAD = [
  "# The change as a diff. In each hunk the first column is the line's number",
  "# in the old file, the second its number in the new file (blank where the",
  "# line is not on that side), then the diff line. Review notes take these",
  "# numbers: the new column, or the old one for a removed line (side old).",
  "",
].join("\n");

export function numberedPatch(text: string): string {
  const out: string[] = [];
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  const col = (n: number | null) => (n === null ? "" : String(n)).padStart(5);
  for (const line of text.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLine = Number(hunk[3]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      out.push(line);
      continue;
    }
    if (oldLeft <= 0 && newLeft <= 0) {
      out.push(line);
      continue;
    }
    if (line.startsWith("+")) {
      out.push(`${col(null)} ${col(newLine++)} ${line}`);
      newLeft--;
    } else if (line.startsWith("-")) {
      out.push(`${col(oldLine++)} ${col(null)} ${line}`);
      oldLeft--;
    } else if (line.startsWith(" ") || line === "") {
      out.push(`${col(oldLine++)} ${col(newLine++)} ${line}`);
      oldLeft--;
      newLeft--;
    } else out.push(line); // "\ No newline at end of file"
  }
  return NUMBERED_HEAD + out.join("\n");
}

// What the owner sent from the review, or null when there is nothing to
// pass on: an approval, or a review closed without feedback.
export function reviewNotes(text: string): string | null {
  const notes = text.trim();
  if (!notes) return null;
  if (/^(The user approved|Review session closed without feedback)\.?$/i.test(notes)) return null;
  return notes;
}

// What the action's turn says: the chapters, then the findings by file.
// `opened`: aug opens the review now; else (a trigger ran it) the owner
// opens it from the task's actions. `denied`: calls the run was refused,
// so no notes may mean it did not look, not that nothing stood out.
export function guideMarkdown(
  saved: SavedGuide,
  opts: { opened?: boolean; denied?: string[] } = {},
): string {
  const opened = opts.opened ?? true;
  const denied = opts.denied ?? [];
  const notes = saved.guide.sections.flatMap((s) =>
    s.diffs.flatMap((d) => (d.notes ?? []).map((n) => ({ file: d.file, n }))),
  );
  const count = saved.findings.length;
  const unpinned = count - notes.length;
  return [
    `**${saved.guide.title}**`,
    saved.guide.intent,
    "",
    `${saved.guide.sections.length} chapter${saved.guide.sections.length === 1 ? "" : "s"}: ${saved.guide.sections.map((s) => s.title).join("; ")}.`,
    ...(denied.length
      ? [
          `A read was denied (${denied.map((d) => `\`${d.slice(0, 120)}\``).join(", ")}): the review may have missed things.`,
          "",
        ]
      : []),
    count
      ? `${count} review note${count === 1 ? "" : "s"}${unpinned > 0 ? ` (${unpinned} not on a changed line)` : ""}:`
      : denied.length
        ? "No review notes."
        : "No review notes: nothing stood out.",
    ...saved.lines,
    "",
    opened
      ? `Saved in Plannotator (\`${saved.id}\`). The review aug opens has these notes as comments; its Agents tab lists the guide.`
      : `Saved in Plannotator (\`${saved.id}\`). To see these notes as comments in its review, pick "${OPEN_REVIEW_TITLE}" from this task's actions (\`.\` or the palette).`,
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}

// How the task's actions name opening the saved guide's review.
export const OPEN_REVIEW_TITLE = "Open the guide's review";
