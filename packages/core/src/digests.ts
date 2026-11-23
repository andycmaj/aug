// A finished session written up once (docs/session-digests-design.md): the
// project journal (core/journal.ts) and the task's story (core/story.ts)
// both read it. The agent writes one with `riker-tools done`; the watcher
// (core/digest-watcher.ts) writes one for a session that ended without.

import { statSync } from "node:fs";
import type { RikerConfig } from "./config";
import { taskPr } from "./pr";
import * as store from "./store";
import {
  DigestBy,
  DigestOutcome,
  type DigestLinks,
  type DigestRow,
  type ProjectRow,
  type SessionRow,
  type TaskRow,
} from "./types";

// ── switches ────────────────────────────────────────────────────────────

// Where a switch's value came from: the row's own, the project's, config.
export const SwitchFrom = {
  task: "task",
  project: "project",
  config: "config",
} as const;
export type SwitchFrom = (typeof SwitchFrom)[keyof typeof SwitchFrom];

export interface Switch {
  on: boolean;
  from: SwitchFrom;
}

function set(v: number | null | undefined): v is number {
  return v === 0 || v === 1;
}

export function journalSwitch(config: RikerConfig, project: ProjectRow | null): Switch {
  if (project && set(project.journal)) return { on: project.journal === 1, from: SwitchFrom.project };
  return { on: config.journal.enabled, from: SwitchFrom.config };
}

export function storySwitch(config: RikerConfig, task: TaskRow): Switch {
  if (set(task.story)) return { on: task.story === 1, from: SwitchFrom.task };
  const project = task.project_id ? store.getProject(task.project_id) : null;
  if (project && set(project.story)) return { on: project.story === 1, from: SwitchFrom.project };
  return { on: config.story.enabled, from: SwitchFrom.config };
}

export function journalOn(config: RikerConfig, task: TaskRow): boolean {
  if (!task.project_id) return false;
  return journalSwitch(config, store.getProject(task.project_id)).on;
}

// A digest is made when either reader wants it.
export function digestWanted(config: RikerConfig, task: TaskRow): boolean {
  return storySwitch(config, task).on || journalOn(config, task);
}

// "story: on (project)": what the Canvas and info views say.
export function switchWords(name: string, s: Switch): string {
  return `${name}: ${s.on ? "on" : "off"} (${s.from})`;
}

// A switch as the owner sets it: on, off, or back to the level above.
export const SwitchValue = { on: "on", off: "off", default: "default" } as const;
export type SwitchValue = (typeof SwitchValue)[keyof typeof SwitchValue];

export function switchColumn(v: SwitchValue): number | null {
  return v === SwitchValue.on ? 1 : v === SwitchValue.off ? 0 : null;
}

// ── secrets ─────────────────────────────────────────────────────────────

const REDACTED = "[redacted]";

// Obvious secret shapes. Not a scanner: a guard against an agent pasting a
// token into what it learned.
const SECRET_SHAPES: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g,
];

const SECRET_VALUE = /\b(password|passwd|token|secret|api[_-]?key)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi;

export function redact(text: string): string {
  let out = text;
  for (const shape of SECRET_SHAPES) out = out.replace(shape, REDACTED);
  return out.replace(SECRET_VALUE, (_m, key: string, sep: string) => `${key}${sep}${REDACTED}`);
}

// ── lists ───────────────────────────────────────────────────────────────

// A list field holds one item per line: given as repeated flags or as one
// text with lines or "- " bullets.
export function toLines(v: string | string[] | undefined): string[] {
  const items = Array.isArray(v) ? v : v ? [v] : [];
  return items
    .flatMap((i) => i.split("\n"))
    .map((l) => l.replace(/^\s*[-*•]\s+/, "").trim())
    .filter(Boolean);
}

export function lines(field: string): string[] {
  return field ? field.split("\n").filter(Boolean) : [];
}

// riker-tools done's list flags, one item each: citty keeps only the last
// value of a flag given twice.
export function repeated(rawArgs: string[], name: string): string[] | undefined {
  const out: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i];
    if (a === `--${name}` && i + 1 < rawArgs.length) out.push(rawArgs[++i]);
    else if (a.startsWith(`--${name}=`)) out.push(a.slice(name.length + 3));
  }
  return out.length ? out : undefined;
}

// ── what the agent says at done ─────────────────────────────────────────

export interface DigestArgs {
  summary: string;
  goal?: string | string[];
  did?: string | string[];
  decision?: string | string[];
  learned?: string | string[];
  next?: string | string[];
  blocked?: string | string[];
  question?: string | string[];
  outcome?: string;
}

const KNOWLEDGE_LINE = /^knowledge:\s*([\w .-]+?)\s*:\s*(.+)$/i;

export interface Learned {
  text: string;
  topic: string | null;
}

// A learned line written `knowledge:<topic>: <text>` also goes to Knowledge.
export function parseLearned(line: string): Learned {
  const m = line.match(KNOWLEDGE_LINE);
  return m ? { text: m[2].trim(), topic: m[1].trim() } : { text: line, topic: null };
}

function outcomeOf(v: string | undefined): DigestOutcome {
  const known = Object.values(DigestOutcome) as string[];
  return v && known.includes(v) ? (v as DigestOutcome) : DigestOutcome.ready;
}

// The links a session leaves: the task's PR and branch, and the docs
// linked to the task since the session started.
export function sessionLinks(task: TaskRow, session: SessionRow | null): DigestLinks {
  const links: DigestLinks = {};
  const pr = taskPr(task);
  if (pr) links.pr = pr.url;
  if (task.branch) links.branch = task.branch;
  const since = session?.started_at ?? "";
  const docs = store
    .linksForTask(task.id)
    .filter((l) => l.created_at >= since && l.url !== links.pr)
    .map((l) => ({ url: l.url, title: l.title }));
  if (docs.length) links.docs = docs;
  return links;
}

// Knowledge entries for the learned lines that ask for one: the line keeps
// its text and the entry's id, so nothing is written twice.
function knowledgeFrom(task: TaskRow, learned: string[]): { lines: string[]; ids: number[] } {
  const ref = store.taskRef(task.id);
  const ids: number[] = [];
  const out = learned.map((line) => {
    const l = parseLearned(line);
    if (!l.topic) return l.text;
    const title = l.text.length > 80 ? `${l.text.slice(0, 79)}…` : l.text;
    const row = store.addKnowledge(l.topic, title, `${l.text}\n\nFrom ${ref} (${task.title}).`, `agent ${ref}`);
    ids.push(row.id);
    return `(Knowledge #${row.id}) ${l.text}`;
  });
  return { lines: out, ids };
}

// How far the transcript had got at done, so a watcher on a later run of
// the same session reads only what came after.
function transcriptSize(session: SessionRow | null): number | null {
  if (!session?.transcript_path) return null;
  try {
    return statSync(session.transcript_path).size;
  } catch {
    return null;
  }
}

// The agent's own digest, at done. Null when neither the journal nor the
// story wants one for this task.
export function digestFromDone(
  config: RikerConfig,
  task: TaskRow,
  session: SessionRow | null,
  args: DigestArgs,
): DigestRow | null {
  if (!digestWanted(config, task)) return null;
  const clean = (v: string | string[] | undefined) => toLines(v).map(redact);
  const did = clean(args.did);
  const knowledge = knowledgeFrom(task, clean(args.learned));
  return store.addDigest({
    task_id: task.id,
    session_id: session?.id ?? null,
    by: DigestBy.agent,
    outcome: outcomeOf(args.outcome),
    goals: clean(args.goal).join("\n"),
    did: (did.length ? did : [redact(args.summary)]).join("\n"),
    decisions: clean(args.decision).join("\n"),
    learned: knowledge.lines.join("\n"),
    next: clean(args.next).join("\n"),
    blocked: clean(args.blocked).join("\n"),
    questions: clean(args.question).join("\n"),
    links: JSON.stringify(sessionLinks(task, session)),
    knowledge: JSON.stringify(knowledge.ids),
    covers_to: transcriptSize(session),
  });
}

export function digestLinks(d: DigestRow): DigestLinks {
  try {
    return JSON.parse(d.links) as DigestLinks;
  } catch {
    return {};
  }
}
