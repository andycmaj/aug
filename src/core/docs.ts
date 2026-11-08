// The operator documents: plain Markdown under ~/.aug/docs that the models are
// actually told. Three you write (SOUL, JOB, STYLE), the rest ship with
// defaults you can rewrite, and LEARNED.md writes itself.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths, ensureHome } from "./paths";

export const DocName = {
  soul: "SOUL.md",
  job: "JOB.md",
  triage: "TRIAGE.md",
  style: "STYLE.md",
  counsel: "COUNSEL.md",
  assistant: "ASSISTANT.md",
  coding: "CODING.md",
  learned: "LEARNED.md",
} as const;
export type DocName = (typeof DocName)[keyof typeof DocName];

export const DOC_PURPOSE: Record<DocName, string> = {
  "SOUL.md": "the constitution: rules, voice, escalation lines",
  "JOB.md": "what your job is; weighs importance, never intent",
  "TRIAGE.md": "what makes something a task, a reply, a watch or an FYI",
  "STYLE.md": "greeting, tone, length, phrasing of replies",
  "COUNSEL.md": "how the assistant speaks and takes a position",
  "ASSISTANT.md": "how a general agent works a task",
  "CODING.md": "how a coding agent works and closes out",
  "LEARNED.md": "what was learned from what you do",
};

// The starter text lives as Markdown in the repo so it can be read and edited
// as the files it becomes.
const DEFAULTS_DIR = join(import.meta.dir, "../../docs/defaults");

function starter(name: DocName): string {
  return readFileSync(join(DEFAULTS_DIR, name), "utf8");
}

export function docPath(name: DocName): string {
  return join(paths.docs(), name);
}

export function ensureDocs(): void {
  ensureHome();
  for (const name of Object.values(DocName)) {
    const file = docPath(name);
    if (!existsSync(file)) writeFileSync(file, starter(name));
  }
}

export function readDoc(name: DocName): string {
  const file = docPath(name);
  return existsSync(file) ? readFileSync(file, "utf8") : starter(name);
}

export function writeDoc(name: DocName, text: string): void {
  ensureHome();
  writeFileSync(docPath(name), text);
}

export function head(text: string, chars: number): string {
  return text.length <= chars ? text : text.slice(0, chars) + "\n…";
}

// LEARNED.md's lines in use: everything but the Watching section, where new
// hypotheses wait at low strength and nothing reads them.
export function learnedInUse(text = readDoc(DocName.learned)): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) skipping = /^## Watching/i.test(line);
    if (!skipping) out.push(line);
  }
  return out.join("\n").trim();
}
