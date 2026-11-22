// SYSTEM tasks: Riker asking the owner about its own brain docs. Each holds one
// or more proposals (a whole new text for one doc, drafted against `base`),
// and the owner accepts or rejects the lot. Accept writes the docs (the old
// files go to .trash) and archives the LEARNED.md lines they absorbed.
//
// A doc keeps moving under an open proposal (a remembered line, a lesson), so
// only the proposal's own changes, base to proposed, are laid over the doc as
// it is now (`rebased`). Read whole, the old snapshot would delete every line
// written since. A shipped version is the exception: it replaces yours.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { think } from "./brain";
import type { RikerConfig } from "./config";
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
  SpendRole,
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
      return `Riker ships a new ${doc}. Yours has edits, so it was left alone. e: read the diff in revdiff. y: take the shipped one (yours goes to docs/.trash). x: keep yours.`;
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

// diff3 by git, which writeReview already needs: `ours` with base-to-theirs
// applied, or null when both touched the same lines.
export function mergeText(ours: string, base: string, theirs: string): string | null {
  if (ours === base) return theirs;
  if (theirs === base || ours === theirs) return ours;
  const dir = mkdtempSync(join(tmpdir(), "riker-merge-"));
  try {
    const files = { ours, base, theirs };
    for (const [name, text] of Object.entries(files))
      writeFileSync(join(dir, name), text);
    const run = Bun.spawnSync(
      ["git", "merge-file", "-p", "--quiet", "ours", "base", "theirs"],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    return run.exitCode === 0 ? run.stdout.toString() : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// What accepting `p` would write now; null when the doc changed since in the
// lines the proposal edits.
export function rebased(p: DocProposalRow): string | null {
  if (!isDocName(p.doc)) return null;
  if (p.source === ProposalSource.shipped) return shippedText(p.doc);
  return mergeText(readDoc(p.doc), p.base, p.proposed);
}

const STALE =
  "changed since where the proposal edits it: x rejects it and the next pass drafts again";

function openOn(taskId: number): DocProposalRow[] {
  return store
    .proposalsForTask(taskId)
    .filter((p) => p.status === ProposalStatus.open);
}

export function hasOpenProposals(taskId: number): boolean {
  return openOn(taskId).length > 0;
}

// Accept: each doc written (its old file to the trash), its absorbed lessons
// out of LEARNED.md and into the archive. A proposal whose lines changed
// since stays open. One line back.
export function acceptProposals(taskId: number): string {
  const open = openOn(taskId);
  if (open.length === 0) return "nothing to accept";
  const wrote: string[] = [];
  const held: string[] = [];
  for (const p of open) {
    if (!isDocName(p.doc)) continue;
    const doc = p.doc;
    const text = rebased(p);
    if (text === null) {
      held.push(doc);
      continue;
    }
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
    wrote.push(doc);
  }
  if (held.length === 0) taskClosed(taskId);
  return [
    ...(wrote.length ? [`wrote ${wrote.join(", ")}`] : []),
    ...(held.length ? [`${held.join(", ")} ${STALE}`] : []),
  ].join("; ");
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
  config: RikerConfig,
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
    const now = readDoc(doc);
    const result = await think({
      prompt: [
        `## ${doc} as it is now`,
        now,
        `## The proposed ${doc}`,
        rebased(p) ?? p.proposed,
        "## The owner's notes on the proposal (file:line, then the note)",
        notes,
      ].join("\n\n"),
      system: `You revise a proposed edit to ${doc} (${DOC_PURPOSE[doc]}), one of the brain docs that riker, the owner's work manager, puts into its prompts. Apply the owner's notes that are about ${doc}; leave the rest of the proposal as it is. Keep it under ${docBudget(config, doc)} characters, plain Markdown, written as the owner speaking. Never record a secret.`,
      schema: REDRAFT_SCHEMA,
      model: config.brain.assistantModel,
      spend: { role: SpendRole.redraft, taskId },
    });
    const answer = result.structured as { text?: string; reason?: string } | null;
    if (!answer?.text?.trim()) continue;
    store.reviseProposal(p.id, {
      proposed: answer.text.trimEnd() + "\n",
      reason: answer.reason ?? p.reason,
      base: now,
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
  // Docs that changed since where their proposal edits: shown against the
  // text the proposal was drafted on instead.
  stale: DocName[];
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
  const stale: DocName[] = [];
  for (const p of open) {
    const doc = isDocName(p.doc) ? p.doc : null;
    if (!doc) continue;
    const merged = rebased(p);
    if (merged === null) stale.push(doc);
    writeFileSync(join(dir, "yours", doc), merged === null ? p.base : readDoc(doc));
    writeFileSync(join(dir, "proposed", doc), merged ?? p.proposed);
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
    stale,
  };
}
