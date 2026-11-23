// The watcher: a digest for a coding session that ended without `done`
// but changed something. It reads only the transcript since the session's
// last digest, as text (what was said, which tools ran on what, never what
// they gave back), and asks a cheap model for the digest's fields. No tools.

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { think } from "./brain";
import type { RikerConfig } from "./config";
import { redact, sessionLinks, toLines } from "./digests";
import { logger } from "./log";
import { capReached } from "./spend";
import * as store from "./store";
import {
  DigestBy,
  DigestOutcome,
  SpendRole,
  type DigestRow,
  type SessionRow,
  type TaskRow,
} from "./types";

const log = logger("digest");

// Past this, the slice keeps its end: the latest work says most.
const SLICE_CHARS = 40_000;
const INPUT_CHARS = 200;

const CHANGING_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);

export interface TranscriptSlice {
  text: string;
  // An edit, a write, or a git commit ran in it.
  changed: boolean;
  // Byte offset it read up to.
  end: number;
}

interface Entry {
  type?: string;
  message?: { role?: string; content?: unknown };
}

interface Part {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
}

function short(v: unknown): string {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return s.length > INPUT_CHARS ? `${s.slice(0, INPUT_CHARS - 1)}…` : s;
}

function toolLine(p: Part): string {
  const input = p.input ?? {};
  const what = input.file_path ?? input.command ?? input.pattern ?? input.path ?? input.url ?? "";
  return `[tool ${p.name ?? "?"}${what ? `: ${short(what)}` : ""}]`;
}

// What a transcript says from byte `from` on: the owner's words, the
// agent's words, and one line per tool call.
export function sliceText(jsonl: string): { text: string; changed: boolean } {
  const out: string[] = [];
  let changed = false;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch {
      continue;
    }
    const content = e.message?.content;
    if (e.type === "user") {
      if (typeof content === "string" && content.trim()) out.push(`Owner: ${content.trim()}`);
      continue;
    }
    if (e.type !== "assistant" || !Array.isArray(content)) continue;
    for (const p of content as Part[]) {
      if (p.type === "text" && p.text?.trim()) out.push(`Agent: ${p.text.trim()}`);
      if (p.type !== "tool_use") continue;
      out.push(toolLine(p));
      if (CHANGING_TOOLS.has(p.name ?? "")) changed = true;
      if (p.name === "Bash" && /\bgit\s+commit\b/.test(String(p.input?.command ?? ""))) changed = true;
    }
  }
  const text = out.join("\n");
  return { text: text.length > SLICE_CHARS ? `…\n${text.slice(-SLICE_CHARS)}` : text, changed };
}

export function readSlice(path: string, from: number): TranscriptSlice | null {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    const start = from > size ? 0 : from;
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return { ...sliceText(buf.toString("utf8")), end: size };
  } finally {
    closeSync(fd);
  }
}

const SCHEMA = {
  type: "object",
  properties: {
    outcome: { type: "string", enum: Object.values(DigestOutcome) },
    did: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    learned: { type: "array", items: { type: "string" } },
    next: { type: "array", items: { type: "string" } },
    blocked: { type: "array", items: { type: "string" } },
    questions: { type: "array", items: { type: "string" } },
  },
  required: ["outcome", "did", "next"],
} as const;

interface Answer {
  outcome?: string;
  did?: string[];
  decisions?: string[];
  learned?: string[];
  next?: string[];
  blocked?: string[];
  questions?: string[];
}

const SYSTEM = `You write up a coding agent's session for its owner, from its transcript. \
Short plain lines, the result first, no preamble. did: what changed. decisions: choices made and why. \
learned: surprises, gotchas, what to do differently. next: what is left. blocked: what waits on whom. \
questions: what the owner must answer. outcome: ready (work finished), blocked, waiting (on the owner), \
or stopped (cut off mid-work). Never copy a token, password or key.`;

function prompt(task: TaskRow, slice: string): string {
  return `Task ${store.taskRef(task.id)}: ${task.title}\n\nThe session, from its transcript:\n\n${slice}`;
}

// Why a session gets no watcher digest, or null when it should get one.
export function watchSkip(session: SessionRow, slice: TranscriptSlice | null): string | null {
  if (!session.transcript_path) return "no transcript";
  if (!slice) return "transcript unreadable";
  if (!slice.changed) return "nothing changed";
  return null;
}

// The watcher's digest for a session, or null (said why in the log; never
// its text).
export async function watchSession(
  config: RikerConfig,
  task: TaskRow,
  session: SessionRow,
): Promise<DigestRow | null> {
  const from = Math.max(0, ...store.digestsForSession(session.id).map((d) => d.covers_to ?? 0));
  const slice = session.transcript_path ? readSlice(session.transcript_path, from) : null;
  const skip = watchSkip(session, slice);
  if (skip || !slice) {
    log.debug("no watcher digest", { task: task.id, session: session.id, why: skip });
    return null;
  }
  if (capReached(config)) {
    log.info("no watcher digest: daily spend cap", { task: task.id, session: session.id });
    return null;
  }
  try {
    const result = await think({
      prompt: prompt(task, slice.text),
      system: SYSTEM,
      schema: SCHEMA,
      model: config.digests.watcherModel,
      spend: { role: SpendRole.digest, taskId: task.id },
    });
    const a = (result.structured ?? {}) as Answer;
    if (result.isError || !a.did) {
      log.warn("watcher digest failed", { task: task.id, session: session.id });
      return null;
    }
    const clean = (v: string[] | undefined) => toLines(v).map(redact).join("\n");
    const outcomes = Object.values(DigestOutcome) as string[];
    return store.addDigest({
      task_id: task.id,
      session_id: session.id,
      by: DigestBy.watcher,
      outcome: outcomes.includes(a.outcome ?? "") ? (a.outcome as DigestOutcome) : DigestOutcome.stopped,
      goals: "",
      did: clean(a.did),
      decisions: clean(a.decisions),
      learned: clean(a.learned),
      next: clean(a.next),
      blocked: clean(a.blocked),
      questions: clean(a.questions),
      links: JSON.stringify(sessionLinks(task, session)),
      knowledge: "[]",
      covers_to: slice.end,
    });
  } catch (err) {
    log.warn("watcher digest failed", { task: task.id, session: session.id, err: err instanceof Error ? err.name : "error" });
    return null;
  }
}
