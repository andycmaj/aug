// SYSTEM tasks: aug asking the owner about its own brain docs. Each holds one
// or more proposals (a whole new text for one doc), and the owner accepts or
// rejects the lot. Accept writes the docs (the old files go to .trash) and
// archives the LEARNED.md lines they absorbed; nothing is ever merged.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { think } from "./brain";
import { loadConfig } from "./config";
import {
  archiveLearned,
  DOC_PURPOSE,
  docBudget,
  DocName,
  readDoc,
  replaceDoc,
  shippedText,
  withoutLines,
  writeDoc,
} from "./docs";
import { taskClosed } from "./lifecycle";
import { paths } from "./paths";
import * as store from "./store";
import {
  Kind,
  ProposalSource,
  ProposalStatus,
  TaskStatus,
  TurnRole,
  type DocProposalRow,
  type TaskRow,
} from "./types";

const DOC_NAMES = new Set<string>(Object.values(DocName));

export function isDocName(name: string): name is DocName {
  return DOC_NAMES.has(name);
}

// "job", "JOB", "JOB.md" -> "JOB.md".
export function docNamed(name: string): DocName | null {
  const upper = name.trim().toUpperCase().replace(/\.MD$/, "");
  const full = `${upper}.md`;
  return isDocName(full) ? full : null;
}

export function systemTask(title: string, summary: string): TaskRow {
  return store.createTask({
    title,
    summary,
    kind: Kind.system,
    channel: "owner",
  });
}

export const ONBOARD_TASK = "onboard.task";

const KEYS =
  "e: read the diff in revdiff (notes you leave there redraft it). y: accept. x: reject.";

function summaryFor(source: string, doc: DocName, reason: string): string {
  switch (source) {
    case ProposalSource.shipped:
      return `aug ships a new ${doc}. Yours has edits, so it was left alone. e: read the diff in revdiff. y: take the shipped one (yours goes to docs/.trash). x: keep yours.`;
    default:
      return `${reason}\n\n${KEYS}`;
  }
}

function titleFor(source: string, doc: DocName): string {
  return source === ProposalSource.shipped
    ? `${doc}: new shipped version`
    : `${doc}: proposed edit`;
}

// The open onboarding task, if the offer is still waiting.
export function onboardingTask(): TaskRow | null {
  const id = Number(store.kvGet(ONBOARD_TASK) ?? 0);
  const task = id ? store.getTask(id) : null;
  return task && task.status === TaskStatus.open ? task : null;
}

export interface Proposal {
  doc: DocName;
  source: (typeof ProposalSource)[keyof typeof ProposalSource];
  proposed: string;
  reason?: string;
  absorbs?: string[];
}

// One open proposal per doc and source: a newer one revises it in place
// rather than stacking a second task.
export function propose(p: Proposal): DocProposalRow {
  const base = readDoc(p.doc);
  const existing = store.openProposalFor(p.doc, p.source);
  if (existing) {
    store.reviseProposal(existing.id, {
      proposed: p.proposed,
      reason: p.reason,
      absorbs: p.absorbs,
      base,
    });
    store.addTurn({
      taskId: existing.task_id,
      role: TurnRole.trigger,
      body: `${p.doc} proposal revised${p.reason ? `: ${p.reason}` : ""}`,
    });
    return store.getProposal(existing.id)!;
  }
  let task: TaskRow | null = null;
  if (p.source === ProposalSource.onboard) {
    task = onboardingTask();
    if (!task) {
      task = systemTask(
        "Your docs, drafted from the interview",
        `Drafts of PERSONA, JOB and STYLE from the onboarding interview.\n\n${KEYS}`,
      );
      store.kvSet(ONBOARD_TASK, String(task.id));
    } else if (store.proposalsForTask(task.id).length === 0) {
      store.updateTask(task.id, {
        title: "Your docs, drafted from the interview",
        summary: `Drafts from the onboarding interview.\n\n${KEYS}`,
      });
    }
  }
  task ??= systemTask(
    titleFor(p.source, p.doc),
    summaryFor(p.source, p.doc, p.reason ?? ""),
  );
  return store.addProposal({
    taskId: task.id,
    doc: p.doc,
    source: p.source,
    base,
    proposed: p.proposed,
    reason: p.reason,
    absorbs: p.absorbs,
  });
}

function absorbed(p: DocProposalRow): string[] {
  try {
    const lines = JSON.parse(p.absorbs) as unknown;
    return Array.isArray(lines)
      ? lines.filter((l): l is string => typeof l === "string")
      : [];
  } catch {
    return [];
  }
}

function openOn(taskId: number): DocProposalRow[] {
  return store
    .proposalsForTask(taskId)
    .filter((p) => p.status === ProposalStatus.open);
}

export function hasOpenProposals(taskId: number): boolean {
  return openOn(taskId).length > 0;
}

// Accept: each doc written whole (its old file to the trash), its absorbed
// lessons out of LEARNED.md and into the archive. One line back.
export function acceptProposals(taskId: number): string {
  const open = openOn(taskId);
  if (open.length === 0) return "nothing to accept";
  const notes: string[] = [];
  for (const p of open) {
    if (!isDocName(p.doc)) continue;
    const doc = p.doc;
    if (readDoc(doc) !== p.base)
      notes.push(`${doc} had changed since; that version is in docs/.trash`);
    const text =
      p.source === ProposalSource.shipped ? shippedText(doc) : p.proposed;
    replaceDoc(doc, text);
    const lines = absorbed(p);
    if (lines.length) {
      if (doc !== DocName.learned)
        writeDoc(
          DocName.learned,
          withoutLines(readDoc(DocName.learned), lines),
        );
      archiveLearned(
        lines,
        doc === DocName.learned ? "compacted" : `absorbed into ${doc}`,
      );
    }
    store.setProposalStatus(p.id, ProposalStatus.accepted);
  }
  taskClosed(taskId);
  const docs = open.map((p) => p.doc).join(", ");
  return [`wrote ${docs}`, ...notes].join("; ");
}

export function rejectProposals(taskId: number): string {
  const open = openOn(taskId);
  for (const p of open) store.setProposalStatus(p.id, ProposalStatus.rejected);
  taskClosed(taskId);
  if (store.kvGet(ONBOARD_TASK) === String(taskId) && open.length === 0)
    return "onboarding skipped: the templates stay";
  return open.length
    ? `kept your ${open.map((p) => p.doc).join(", ")}`
    : "dismissed";
}

const REDRAFT_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string", description: "the whole revised doc" },
    reason: { type: "string", description: "one line: what changed" },
  },
  required: ["text", "reason"],
} as const;

// The owner's notes on a proposal (from revdiff) back to a drafter: one
// model call per doc, the proposal revised in place. A shipped version has
// nobody to redraft it.
export async function redraftProposals(
  taskId: number,
  notes: string,
): Promise<string> {
  const open = openOn(taskId).filter(
    (p) => p.source !== ProposalSource.shipped && isDocName(p.doc),
  );
  if (!notes.trim()) return "nothing to redraft";
  store.addTurn({
    taskId,
    role: TurnRole.you,
    author: "you",
    body: notes.trim(),
  });
  if (open.length === 0) {
    store.addTurn({
      taskId,
      role: TurnRole.trigger,
      body: "Nothing here to redraft: a shipped version is taken (y) or kept (x)",
    });
    return "nothing to redraft";
  }
  const done: string[] = [];
  for (const p of open) {
    const doc = p.doc as DocName;
    const result = await think({
      prompt: [
        `## ${doc} as it is now`,
        p.base,
        `## The proposed ${doc}`,
        p.proposed,
        "## The owner's notes on the proposal (file:line, then the note)",
        notes,
      ].join("\n\n"),
      system: `You revise a proposed edit to ${doc} (${DOC_PURPOSE[doc]}), one of the brain docs that aug, the owner's work manager, puts into its prompts. Apply the owner's notes that are about ${doc}; leave the rest of the proposal as it is. Keep it under ${docBudget(doc)} characters, plain Markdown, written as the owner speaking. Never record a secret.`,
      schema: REDRAFT_SCHEMA,
      model: loadConfig().brain.assistantModel,
    });
    const answer = result.structured as { text?: string; reason?: string } | null;
    if (!answer?.text?.trim()) continue;
    store.reviseProposal(p.id, {
      proposed: answer.text.trimEnd() + "\n",
      reason: answer.reason ?? p.reason,
    });
    done.push(doc);
  }
  store.addTurn({
    taskId,
    role: TurnRole.trigger,
    body: done.length
      ? `Redrafted ${done.join(", ")} from your notes`
      : "Your notes changed nothing",
  });
  return done.length ? `redrafted ${done.join(", ")}` : "nothing changed";
}

export interface ReviewFiles {
  dir: string;
  // The unified diff, every open proposal on the task: yours (a/) against
  // the proposal (b/).
  diff: string;
  // Where revdiff writes the owner's notes.
  out: string;
  empty: boolean;
}

// The task's proposals as one diff file for revdiff (or a pager). Each doc's
// diff comes from git diff --no-index, its paths cut back to the doc's name.
export function writeReview(taskId: number): ReviewFiles | null {
  const open = openOn(taskId);
  if (open.length === 0) return null;
  const dir = join(paths.home(), "review", store.taskRef(taskId));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "yours"), { recursive: true });
  mkdirSync(join(dir, "proposed"), { recursive: true });
  const parts: string[] = [];
  for (const p of open) {
    const doc = isDocName(p.doc) ? p.doc : null;
    if (!doc) continue;
    const proposed =
      p.source === ProposalSource.shipped ? shippedText(doc) : p.proposed;
    writeFileSync(join(dir, "yours", doc), readDoc(doc));
    writeFileSync(join(dir, "proposed", doc), proposed);
    const run = Bun.spawnSync(
      [
        "git",
        "diff",
        "--no-index",
        "--no-color",
        join("yours", doc),
        join("proposed", doc),
      ],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    parts.push(
      run.stdout
        .toString()
        .replaceAll(`a/yours/${doc}`, `a/${doc}`)
        .replaceAll(`b/proposed/${doc}`, `b/${doc}`),
    );
  }
  const diff = join(dir, "proposal.diff");
  writeFileSync(diff, parts.join(""));
  return {
    dir,
    diff,
    out: join(dir, "notes.md"),
    empty: parts.every((d) => !d.trim()),
  };
}
