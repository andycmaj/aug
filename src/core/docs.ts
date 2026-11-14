// The operator documents: plain Markdown under ~/.aug/docs that the models are
// actually told. Each is a file the owner may edit. Owner docs (PERSONA, JOB,
// STYLE) start as templates the onboarding interview fills in; shipped docs
// (TRIAGE, ASSISTANT, CODING) come with aug and are kept up to date until the
// owner edits them (core/doc-sync.ts); LEARNED.md writes itself.
//
// Nothing here keeps a history. An aug write over an existing doc copies the
// old file to .trash first, and that is the only way back.

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { loadConfig } from "./config";
import { paths, ensureHome } from "./paths";
import assistant from "../../docs/defaults/ASSISTANT.md" with { type: "text" };
import coding from "../../docs/defaults/CODING.md" with { type: "text" };
import job from "../../docs/defaults/JOB.md" with { type: "text" };
import learned from "../../docs/defaults/LEARNED.md" with { type: "text" };
import persona from "../../docs/defaults/PERSONA.md" with { type: "text" };
import style from "../../docs/defaults/STYLE.md" with { type: "text" };
import triage from "../../docs/defaults/TRIAGE.md" with { type: "text" };

export const DocName = {
  persona: "PERSONA.md",
  job: "JOB.md",
  style: "STYLE.md",
  triage: "TRIAGE.md",
  assistant: "ASSISTANT.md",
  coding: "CODING.md",
  learned: "LEARNED.md",
} as const;
export type DocName = (typeof DocName)[keyof typeof DocName];

export const DocClass = {
  // Yours: aug ships a template and drafts it with you, never updates it.
  owner: "owner",
  // aug's: updated with aug until you edit it.
  shipped: "shipped",
  // aug writes it from corrections; you may edit it.
  learned: "learned",
} as const;
export type DocClass = (typeof DocClass)[keyof typeof DocClass];

export const DOC_CLASS: Record<DocName, DocClass> = {
  "PERSONA.md": DocClass.owner,
  "JOB.md": DocClass.owner,
  "STYLE.md": DocClass.owner,
  "TRIAGE.md": DocClass.shipped,
  "ASSISTANT.md": DocClass.shipped,
  "CODING.md": DocClass.shipped,
  "LEARNED.md": DocClass.learned,
};

export const DOC_PURPOSE: Record<DocName, string> = {
  "PERSONA.md": "red lines that outrank everything, and how aug speaks to you",
  "JOB.md": "what your job is; weighs importance, never intent",
  "STYLE.md": "your voice in the drafts aug writes for you",
  "TRIAGE.md": "what makes something a task, a reply, a watch or an FYI",
  "ASSISTANT.md": "how a general agent works a task",
  "CODING.md": "how a coding agent works and closes out",
  "LEARNED.md": "what was learned from what you do",
};

// Characters each doc may take in a prompt; LEARNED's counts only the lines
// in use. Over it, aug proposes a shrink; over twice it, the prompt gets a cut
// that says so. Config's docBudgets overrides any of them.
export const DOC_BUDGET: Record<DocName, number> = {
  "PERSONA.md": 1500,
  "JOB.md": 3000,
  "STYLE.md": 1000,
  "TRIAGE.md": 2000,
  "ASSISTANT.md": 2000,
  "CODING.md": 2000,
  "LEARNED.md": 3000,
};

export function docBudget(name: DocName): number {
  return loadConfig().docBudgets?.[name] ?? DOC_BUDGET[name];
}

export const LEARNED_SECTIONS = [
  "Your people",
  "What you care about",
  "How you work",
  "Promises",
  "What to bring up",
] as const;

// LEARNED.md's header as the models are told it: written here, not read from
// the file, so a change to it reaches every install.
export const LEARNED_HEADER =
  "What was learned from what you do. Machine-written lines carry [s:strength | ev:evidence | seen:date]; lines without one are the owner's. PERSONA.md always outranks this file.";

// The starter text lives as Markdown in the repo so it can be read and edited
// as the files it becomes. Imported as text, not read from disk, so a compiled
// binary carries it.
const STARTERS: Record<DocName, string> = {
  "PERSONA.md": persona,
  "JOB.md": job,
  "STYLE.md": style,
  "TRIAGE.md": triage,
  "ASSISTANT.md": assistant,
  "CODING.md": coding,
  "LEARNED.md": learned,
};

export function shippedText(name: DocName): string {
  return STARTERS[name];
}

export function docHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function docPath(name: string): string {
  return join(paths.docs(), name);
}

export function docExists(name: DocName): boolean {
  return existsSync(docPath(name));
}

export function ensureDocs(): void {
  ensureHome();
  for (const name of Object.values(DocName)) {
    const file = docPath(name);
    if (!existsSync(file)) writeFileSync(file, shippedText(name));
  }
}

export function readDoc(name: DocName): string {
  const file = docPath(name);
  return existsSync(file) ? readFileSync(file, "utf8") : shippedText(name);
}

export function writeDoc(name: DocName, text: string): void {
  ensureHome();
  writeFileSync(docPath(name), text);
}

// ── the trash: the one way back from an aug write ─────────────────────────

const TRASH_DAYS = 30;

export function trashDir(): string {
  return join(paths.docs(), ".trash");
}

// A copy of the file as it is now, before aug writes over it.
export function trashDoc(name: string, at = new Date()): string | null {
  const file = docPath(name);
  if (!existsSync(file)) return null;
  mkdirSync(trashDir(), { recursive: true });
  const stamp = at.toISOString().replace(/[:.]/g, "-");
  const copy = join(trashDir(), `${name.replace(/\.md$/, "")}.${stamp}.md`);
  copyFileSync(file, copy);
  return copy;
}

export function pruneTrash(at = new Date()): number {
  if (!existsSync(trashDir())) return 0;
  let pruned = 0;
  for (const entry of readdirSync(trashDir())) {
    const file = join(trashDir(), entry);
    if (at.getTime() - statSync(file).mtimeMs > TRASH_DAYS * 86400000) {
      unlinkSync(file);
      pruned++;
    }
  }
  return pruned;
}

// An aug write over a doc the owner may have touched: the old one goes to
// the trash first. Lessons LEARNED.md writes as it goes do not come here.
export function replaceDoc(name: DocName, text: string): string | null {
  const copy = trashDoc(name);
  writeDoc(name, text);
  return copy;
}

export function head(text: string, chars: number): string {
  return text.length <= chars ? text : text.slice(0, chars) + "\n…";
}

// ── budgets ───────────────────────────────────────────────────────────────

// What the prompt counts: LEARNED's lines in use, any other doc whole.
export function docSize(name: DocName): number {
  return name === DocName.learned
    ? learnedInUse().length
    : readDoc(name).length;
}

export function overBudget(name: DocName): boolean {
  return docSize(name) > docBudget(name);
}

// A doc as a prompt gets it: whole up to twice its budget, past that cut
// with a note, so a runaway file costs a known amount and nobody wonders
// where its tail went.
export function forPrompt(name: DocName, text = readDoc(name)): string {
  const cap = docBudget(name) * 2;
  return text.length <= cap
    ? text
    : `${text.slice(0, cap)}\n(cut at budget: ${name} is ${text.length} characters, budget ${docBudget(name)})`;
}

// ── LEARNED.md ────────────────────────────────────────────────────────────

const WATCHING = /^## Watching/i;

// The sections and their lines, header left out: what is under the first
// "## " on.
function learnedSections(text: string): string[] {
  const lines = text.split("\n");
  const first = lines.findIndex((l) => l.startsWith("## "));
  return first === -1 ? [] : lines.slice(first);
}

// LEARNED.md's lines in use: the header from code, then every section but
// Watching, where new hypotheses wait at low strength and nothing reads them.
export function learnedInUse(text = readDoc(DocName.learned)): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of learnedSections(text)) {
    if (line.startsWith("## ")) skipping = WATCHING.test(line);
    if (!skipping) out.push(line);
  }
  const body = out.join("\n").trim();
  return body ? `${LEARNED_HEADER}\n\n${body}` : LEARNED_HEADER;
}

// Each shipped section present: a missing one goes in before Watching (or at
// the end). Never touches a line.
export function withLearnedSections(text: string): string {
  let lines = text.split("\n");
  for (const section of [...LEARNED_SECTIONS, "Watching"]) {
    const heading = `## ${section}`;
    if (lines.some((l) => l.trim() === heading)) continue;
    const watching = lines.findIndex((l) => WATCHING.test(l));
    const at = section === "Watching" || watching === -1 ? lines.length : watching;
    const before = lines.slice(0, at);
    while (before.length && before[before.length - 1].trim() === "")
      before.pop();
    lines = [...before, "", heading, "", ...lines.slice(at)];
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

const SEEN = /seen:\s*(\d{4}-\d{2}-\d{2})/;

// Watching lines not seen again within `days`: they leave the file and go to
// the archive. Pure.
export function staleWatching(
  text: string,
  at: Date,
  days = 30,
): { text: string; stale: string[] } {
  const stale: string[] = [];
  let watching = false;
  const kept = text.split("\n").filter((line) => {
    if (line.startsWith("## ")) watching = WATCHING.test(line);
    if (!watching || !line.startsWith("- ")) return true;
    const seen = line.match(SEEN)?.[1];
    if (!seen || at.getTime() - Date.parse(seen) <= days * 86400000)
      return true;
    stale.push(line);
    return false;
  });
  return { text: kept.join("\n"), stale };
}

// Whole lines out of LEARNED.md's text, matched trimmed. Pure.
export function withoutLines(text: string, lines: string[]): string {
  const drop = new Set(lines.map((l) => l.trim()).filter(Boolean));
  return text
    .split("\n")
    .filter((l) => !drop.has(l.trim()))
    .join("\n");
}

export const ARCHIVE = "LEARNED.archive.md";

// Lessons that left LEARNED.md, kept where the owner can read them and no
// prompt ever does.
export function archiveLearned(
  lines: string[],
  why: string,
  at = new Date(),
): void {
  const kept = lines.map((l) => l.trim()).filter(Boolean);
  if (kept.length === 0) return;
  ensureHome();
  const file = docPath(ARCHIVE);
  const top = existsSync(file)
    ? ""
    : "# LEARNED archive\n\nLessons that left LEARNED.md, and why. Never read by a prompt.\n";
  appendFileSync(
    file,
    `${top}\n## ${at.toISOString().slice(0, 10)}: ${why}\n${kept.join("\n")}\n`,
  );
}

export function readArchive(): string {
  const file = docPath(ARCHIVE);
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}
