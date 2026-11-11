// Correcting it teaches it. Every correction (Not a task, a changed kind or
// priority, an edited or redrafted draft) is evidence; one small model call
// turns it into a line in LEARNED.md, which triage and the agents read on the
// next message like it.
//
// A new line starts at strength 2 under Watching, where nothing reads it. The
// same lesson seen again comes back stronger and replaces its old line; at 4
// it moves into the section it belongs to and is in use.

import { think } from "./brain";
import { loadConfig } from "./config";
import { DocName, readDoc, writeDoc } from "./docs";
import * as store from "./store";
import type { CorrectionRow } from "./types";

export const LEARNED_SECTIONS = [
  "Your people",
  "What you care about",
  "How you work",
  "Promises",
  "What to bring up",
] as const;

export const PROMOTE_AT = 4;

const LESSON_SCHEMA = {
  type: "object",
  properties: {
    skip: {
      type: "boolean",
      description:
        "true when this correction adds nothing LEARNED.md does not already say",
    },
    section: { type: "string", enum: [...LEARNED_SECTIONS] },
    text: {
      type: "string",
      description:
        "the lesson in words - the kind of work and why - ending (about: X) when it holds only for one sender or topic",
    },
    strength: {
      type: "integer",
      description:
        "2 for a new hypothesis; the old line's strength + 1 when this repeats it",
    },
    replaces: {
      type: "string",
      description: "the exact existing line this lesson replaces, or empty",
    },
  },
  required: ["skip", "section", "text", "strength"],
} as const;

export interface Lesson {
  skip: boolean;
  section: (typeof LEARNED_SECTIONS)[number];
  text: string;
  strength: number;
  replaces?: string;
}

export function formatLine(
  lesson: Lesson,
  evidence: string[],
  date: string,
): string {
  return `- ${lesson.text.trim()} [s:${lesson.strength} | ev: ${evidence.join(",")} | seen: ${date}]`;
}

function evidenceOf(line: string): string[] {
  const m = line.match(/ev:\s*([^|\]]+)/);
  return m
    ? m[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
}

// Pure: apply a lesson to LEARNED.md's text.
export function applyLesson(
  text: string,
  lesson: Lesson,
  evidenceId: string,
  date: string,
): { text: string; line: string } {
  let lines = text.split("\n");
  let evidence = [evidenceId];
  if (lesson.replaces?.trim()) {
    const target = lesson.replaces.trim();
    const idx = lines.findIndex((l) => l.trim() === target);
    if (idx !== -1) {
      evidence = [...new Set([...evidenceOf(lines[idx]), evidenceId])];
      lines = lines.filter((_, i) => i !== idx);
    }
  }
  const line = formatLine(lesson, evidence, date);
  const heading =
    lesson.strength >= PROMOTE_AT ? `## ${lesson.section}` : "## Watching";
  let at = lines.findIndex((l) => l.trim() === heading);
  if (at === -1) {
    lines.push("", heading);
    at = lines.length - 1;
  }
  // After the heading's last line, before the next heading.
  let insert = at + 1;
  while (insert < lines.length && !lines[insert].startsWith("## ")) insert++;
  while (insert > at + 1 && lines[insert - 1].trim() === "") insert--;
  lines.splice(insert, 0, line);
  return { text: lines.join("\n"), line };
}

export function describeCorrection(c: CorrectionRow): string {
  const task = c.task_id ? store.getTask(c.task_id) : null;
  const message = c.message_id ? store.getMessage(c.message_id) : null;
  const about = task
    ? `Task "${task.title}" (${task.channel}${task.repo ? `, ${task.repo}` : ""})`
    : message
      ? `Message from ${message.author_name}: "${message.body.slice(0, 300)}"`
      : "";
  return [
    `Correction: ${c.what}`,
    about,
    c.before ? `Before: ${c.before}` : "",
    c.after ? `After: ${c.after}` : "",
    c.note ? `The owner's words: ${c.note}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function learnFrom(c: CorrectionRow): Promise<string | null> {
  if (!loadConfig().learning) return null;
  const learned = readDoc(DocName.learned);
  const result = await think({
    prompt: `${describeCorrection(c)}\n\nCurrent LEARNED.md:\n${learned}`,
    system:
      "You maintain LEARNED.md, what aug has learned about how its owner works. Turn one correction into at most one lesson in plain words. Never record a secret. If an existing line already says it, either skip or return a stronger version that replaces it (strength + 1). Lines without an [s:...] tag were written by the owner: never replace them.",
    schema: LESSON_SCHEMA,
    model: loadConfig().brain.triageModel,
  });
  const lesson = result.structured as Lesson | null;
  if (!lesson || lesson.skip || !lesson.text?.trim()) return null;
  const { text, line } = applyLesson(
    learned,
    lesson,
    `c${c.id}`,
    new Date().toISOString().slice(0, 10),
  );
  writeDoc(DocName.learned, text);
  store.setCorrectionLearned(c.id, line);
  return line;
}

// Record and learn in the background: a correction never waits on a model.
export function correct(
  c: Parameters<typeof store.addCorrection>[0],
  onLearned?: (line: string) => void,
): void {
  const row = store.addCorrection(c);
  void learnFrom(row)
    .then((line) => {
      if (line) onLearned?.(line);
    })
    .catch(() => {});
}
