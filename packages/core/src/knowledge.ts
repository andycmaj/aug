// Keeping Knowledge (the agents' durable discoveries, table `hub`) from
// rotting: the daily doc pass (core/doc-pass.ts) reads every live entry with
// the facts Riker can check (its task is gone, files it cites are gone) and
// may propose merging near-duplicates and retiring what no longer holds. A
// plan is a proposal on a System task like a doc's (core/proposals.ts), and
// nothing changes until the owner accepts it. A retired entry is kept, out of
// what agents read.

import { basename } from "node:path";
import { REF_WORD } from "./brand";
import type { RikerConfig } from "./config";
import { expandHome, repoPath } from "./repos";
import * as store from "./store";
import { TaskStatus, type DocProposalRow, type KnowledgeRow } from "./types";

// The `doc` of a Knowledge proposal in doc_proposals: no brain doc has it.
export const KNOWLEDGE_DOC = "Knowledge";

export interface KnowledgeMerge {
  ids: number[];
  topic: string;
  title: string;
  body: string;
  reason: string;
}

export interface KnowledgeRetire {
  id: number;
  reason: string;
}

export interface KnowledgePlan {
  merge: KnowledgeMerge[];
  retire: KnowledgeRetire[];
}

export const KNOWLEDGE_SCHEMA = {
  type: "object",
  properties: {
    merge: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "integer" },
            description: "two or more entries that say the same thing",
          },
          topic: { type: "string" },
          title: { type: "string" },
          body: {
            type: "string",
            description: "one entry that keeps every fact still true in them",
          },
          reason: { type: "string", description: "one line the owner reads" },
        },
        required: ["ids", "topic", "title", "body", "reason"],
      },
    },
    retire: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          reason: { type: "string", description: "one line the owner reads" },
        },
        required: ["id", "reason"],
      },
    },
  },
  required: ["merge", "retire"],
} as const;

export const KNOWLEDGE_SYSTEM = [
  "You keep Knowledge, the durable discoveries Riker's coding agents leave for each other (how a tool behaves, where something lives, why a choice was made). Agents search it before they work, so a stale or doubled entry misleads them.",
  "Propose only what earns it:",
  "- merge: two or more entries that say the same thing, or where a later one corrects an earlier one. Write the one entry that replaces them, keeping every fact that still holds; a later entry wins over an earlier one it contradicts.",
  "- retire: an entry that no longer holds - its facts say its files are gone and nothing in it is still true, or a later entry says it is wrong. A task done or dropped is not a reason by itself: what it found can still hold.",
  "The Fact lines are what Riker checked, for you to weigh: never write them into an entry. Each entry is in at most one merge or retire. Never record a secret. An empty plan is the usual answer.",
].join("\n");

const BODY_CHARS = 1500;

// Paths an entry cites: a/b.ts, packages/core/src/x.ts. Not URLs (the scheme
// stops the match) and not absolute or home paths, which are not a repo's.
const PATH = /(?:^|[\s`'"(\[])((?:[\w.-]+\/)+[\w-][\w.-]*\.[A-Za-z]{1,5})(?=$|[\s`'"),:;\].])/g;

export function citedPaths(text: string): string[] {
  return [...new Set([...text.matchAll(PATH)].map((m) => m[1]))];
}

// The task an entry came from: its author ("agent RIKER-0135") first, else
// the first ref in its title.
export function entryTask(entry: KnowledgeRow): number | null {
  const ref = new RegExp(`\\b${REF_WORD}-0*(\\d+)\\b`, "i");
  const m = entry.author.match(ref) ?? entry.title.match(ref);
  return m ? Number(m[1]) : null;
}

// Basenames of the files a checkout tracks, null when there is no checkout
// to read.
export type RepoFiles = (path: string) => Set<string> | null;

export function gitFiles(): RepoFiles {
  const seen = new Map<string, Set<string> | null>();
  return (path) => {
    if (!seen.has(path)) {
      const run = Bun.spawnSync(["git", "-C", path, "ls-files"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      seen.set(
        path,
        run.exitCode === 0
          ? new Set(run.stdout.toString().split("\n").filter(Boolean).map((f) => basename(f)))
          : null,
      );
    }
    return seen.get(path) ?? null;
  };
}

// What Riker can check about an entry, in words for the model and the owner.
// A cited file is gone only when no file of that name is left in the repo,
// so a move between folders is not one.
export function entryFacts(
  entry: KnowledgeRow,
  config: RikerConfig,
  files: RepoFiles,
): string[] {
  const facts: string[] = [];
  const taskId = entryTask(entry);
  const task = taskId ? store.getTask(taskId) : null;
  if (taskId && !task) facts.push(`its task ${store.taskRef(taskId)} no longer exists`);
  if (task?.status === TaskStatus.dropped)
    facts.push(`its task ${store.taskRef(task.id)} was dropped`);
  const path = repoPath(config, task?.repo ?? null);
  const tracked = path ? files(expandHome(path)) : null;
  if (tracked) {
    const gone = citedPaths(`${entry.title}\n${entry.body}`).filter(
      (p) => !tracked.has(basename(p)),
    );
    if (gone.length) facts.push(`files it cites are no longer in ${task!.repo}: ${gone.join(", ")}`);
  }
  return facts;
}

function clip(text: string): string {
  return text.length > BODY_CHARS ? `${text.slice(0, BODY_CHARS)}…` : text;
}

// Every live entry with its facts: the model's whole view of Knowledge.
export function knowledgeSection(
  config: RikerConfig,
  files: RepoFiles = gitFiles(),
): { text: string; entries: KnowledgeRow[] } {
  const entries = store.listKnowledge();
  const text = entries
    .map((e) => {
      const facts = entryFacts(e, config, files);
      return [
        `### #${e.id} [${e.topic}] ${e.title} (${e.author}, ${e.created_at.slice(0, 10)})`,
        ...facts.map((f) => `Fact: ${f}`),
        clip(e.body),
      ].join("\n");
    })
    .join("\n\n");
  return { text, entries };
}

function isPlan(value: unknown): value is Partial<KnowledgePlan> {
  return typeof value === "object" && value !== null;
}

// The model's plan held to the live entries: a merge of fewer than two, an
// unknown id or one already claimed by another step is dropped.
export function checkPlan(answer: unknown, live: KnowledgeRow[]): KnowledgePlan {
  const ids = new Set(live.map((e) => e.id));
  const used = new Set<number>();
  const claim = (list: number[]) => {
    if (list.some((id) => !ids.has(id) || used.has(id))) return false;
    for (const id of list) used.add(id);
    return true;
  };
  const plan: KnowledgePlan = { merge: [], retire: [] };
  if (!isPlan(answer)) return plan;
  for (const m of answer.merge ?? []) {
    const list = [...new Set(m.ids ?? [])];
    if (list.length < 2 || !m.body?.trim() || !m.title?.trim()) continue;
    if (!claim(list)) continue;
    plan.merge.push({
      ids: list,
      topic: (m.topic || live.find((e) => e.id === list[0])!.topic).trim().toLowerCase(),
      title: m.title.trim(),
      body: m.body.trim(),
      reason: m.reason?.trim() ?? "",
    });
  }
  for (const r of answer.retire ?? []) {
    if (!claim([r.id])) continue;
    plan.retire.push({ id: r.id, reason: r.reason?.trim() ?? "" });
  }
  return plan;
}

export const planEmpty = (p: KnowledgePlan) => p.merge.length === 0 && p.retire.length === 0;

export function parsePlan(json: string): KnowledgePlan {
  try {
    const value = JSON.parse(json) as unknown;
    if (isPlan(value))
      return { merge: value.merge ?? [], retire: value.retire ?? [] };
  } catch {}
  return { merge: [], retire: [] };
}

export function planIds(plan: KnowledgePlan): number[] {
  return [...plan.merge.flatMap((m) => m.ids), ...plan.retire.map((r) => r.id)];
}

// One line per step, for the System task and its proposal.
export function planReason(plan: KnowledgePlan): string {
  return [
    ...plan.merge.map(
      (m) => `Merge ${m.ids.map((id) => `#${id}`).join(", ")} into "${m.title}"${m.reason ? `: ${m.reason}` : ""}`,
    ),
    ...plan.retire.map((r) => `Retire #${r.id}${r.reason ? `: ${r.reason}` : ""}`),
  ].join("\n");
}

export function planHeadline(plan: KnowledgePlan): string {
  return [
    plan.merge.length ? `merge ${plan.merge.length}` : "",
    plan.retire.length ? `retire ${plan.retire.length}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

// A proposal's heading on the Canvas: a doc's size change, a Knowledge
// plan's steps.
export function proposalHeadline(p: DocProposalRow): string {
  const what =
    p.doc === KNOWLEDGE_DOC
      ? planHeadline(parsePlan(p.proposed))
      : `${p.base.length} -> ${p.proposed.length} characters`;
  return `${p.doc} · ${p.source} · ${what}`;
}

type Snapshot = Pick<KnowledgeRow, "id" | "topic" | "title" | "body">;

// The entries a plan touches, as they were: the proposal's base.
export function snapshot(plan: KnowledgePlan): string {
  const rows: Snapshot[] = planIds(plan)
    .map((id) => store.getKnowledge(id))
    .filter((e): e is KnowledgeRow => e !== null)
    .map(({ id, topic, title, body }) => ({ id, topic, title, body }));
  return JSON.stringify(rows);
}

function entryText(e: Pick<KnowledgeRow, "topic" | "title" | "body">, id: string): string {
  return `## ${id} [${e.topic}] ${e.title}\n\n${e.body.trimEnd()}\n`;
}

// The review's two sides, as Markdown: the entries the plan touches, and what
// stands in their place after it (a merge's one entry; a retired one gone).
export function reviewTexts(plan: KnowledgePlan): { yours: string; proposed: string } {
  const live = (id: number) => store.getKnowledge(id);
  const yours = planIds(plan)
    .map(live)
    .filter((e): e is KnowledgeRow => e !== null)
    .map((e) => entryText(e, `#${e.id}`))
    .join("\n");
  const proposed = plan.merge
    .map((m) => entryText(m, `new (merges ${m.ids.map((id) => `#${id}`).join(", ")})`))
    .join("\n");
  return { yours, proposed };
}

// Accept: each step whose entries are all still live is done; one whose
// entries were retired since is skipped.
export function applyPlan(plan: KnowledgePlan, at = new Date()): { done: number; skipped: number } {
  const isLive = (id: number) => {
    const e = store.getKnowledge(id);
    return e !== null && e.retired_at === null;
  };
  let done = 0;
  let skipped = 0;
  for (const m of plan.merge) {
    if (!m.ids.every(isLive)) {
      skipped++;
      continue;
    }
    const merged = store.addKnowledge(
      m.topic,
      m.title,
      m.body,
      `riker (merged ${m.ids.map((id) => `#${id}`).join(", ")} on ${at.toISOString().slice(0, 10)})`,
    );
    for (const id of m.ids) store.retireKnowledge(id, `merged into #${merged.id}`, merged.id);
    done++;
  }
  for (const r of plan.retire) {
    if (!isLive(r.id)) {
      skipped++;
      continue;
    }
    store.retireKnowledge(r.id, r.reason || "retired");
    done++;
  }
  return { done, skipped };
}
