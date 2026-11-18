// The Advisor's daily look at the brain docs. LEARNED.md fills itself; this
// is how what it learned reaches the owner's own docs, and how a doc that
// grew past its budget gets smaller. It writes nothing the owner has not
// accepted: each edit is a proposal on a SYSTEM task.
//
// It runs once a day on the Advisor's clock, and calls a model only when
// something is new since the last pass (a lesson went in use, a correction
// came in) or a doc is over budget. Shipped docs are never proposed to: an
// edit would stop their updates, so a lesson that belongs in one becomes an
// Advisor idea to change aug instead.

import { think } from "./brain";
import type { AugConfig } from "./config";
import {
  archiveLearned,
  DOC_PURPOSE,
  docBudget,
  docHash,
  DocName,
  docSize,
  learnedInUse,
  overBudget,
  readDoc,
  staleWatching,
  writeDoc,
} from "./docs";
import { describeCorrection } from "./learn";
import { logger } from "./log";
import { propose } from "./proposals";
import * as store from "./store";
import { ProposalSource } from "./types";

const log = logger("doc-pass");

export const DOC_PASS_EVERY_MS = 24 * 3600 * 1000;
const LAST_RUN = "docpass.lastRun";
const SEEN = "docpass.seen";

// The docs a pass may propose to.
const EDITABLE = [
  DocName.persona,
  DocName.job,
  DocName.style,
  DocName.learned,
] as const;
type Editable = (typeof EDITABLE)[number];

const PASS_SCHEMA = {
  type: "object",
  properties: {
    edits: {
      type: "array",
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          doc: { type: "string", enum: [...EDITABLE] },
          text: { type: "string", description: "the whole new doc" },
          reason: {
            type: "string",
            description: "one or two sentences the owner reads: what changes and why",
          },
          absorbs: {
            type: "array",
            items: { type: "string" },
            description:
              "exact LEARNED.md lines this edit makes redundant (for a LEARNED.md edit: the lines it drops)",
          },
        },
        required: ["doc", "text", "reason"],
      },
    },
    ideas: {
      type: "array",
      maxItems: 2,
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["title", "body"],
      },
      description:
        "lessons that belong in one of aug's shipped docs (TRIAGE, ASSISTANT, CODING): what to change in aug",
    },
  },
  required: ["edits"],
} as const;

interface PassAnswer {
  edits: { doc: string; text: string; reason: string; absorbs?: string[] }[];
  ideas?: { title: string; body: string }[];
}

export function docPassDue(at: Date): boolean {
  const last = store.kvGet(LAST_RUN);
  return !last || at.getTime() - Date.parse(last) >= DOC_PASS_EVERY_MS;
}

// What the pass has seen: the lines in use and the newest correction.
function signature(): string {
  const newest = store.recentCorrections(1)[0]?.id ?? 0;
  return `${docHash(learnedInUse())}:${newest}`;
}

// Watching lines nobody saw again in 30 days leave for the archive, with no
// review: they were never in use.
export function archiveStale(at = new Date()): number {
  const text = readDoc(DocName.learned);
  const { text: kept, stale } = staleWatching(text, at);
  if (stale.length === 0) return 0;
  writeDoc(DocName.learned, kept);
  archiveLearned(stale, "stale: not seen again in 30 days", at);
  return stale.length;
}

const MACHINE = /\[s:\s*\d/;

// The lines a LEARNED.md edit drops that it may not: an owner's line (no
// [s:...] tag) ever, and a machine line it does not name in absorbs. A model
// that rewrites the file whole drops lines by leaving them out, so this is
// read off the text, not off what the model says it did.
export function unearnedDrops(
  current: string,
  proposed: string,
  absorbs: string[],
): string[] {
  const kept = new Set(proposed.split("\n").map((l) => l.trim()));
  const named = new Set(absorbs.map((l) => l.trim()));
  return current
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") && !kept.has(l))
    .filter((l) => !MACHINE.test(l) || !named.has(l));
}

function sinceLastPass(): string {
  const since = store.kvGet(LAST_RUN) ?? "";
  const fresh = store
    .recentCorrections(20)
    .filter((c) => c.created_at > since)
    .map(describeCorrection);
  return fresh.length ? fresh.join("\n\n") : "(none)";
}

function docSection(config: AugConfig, name: Editable): string {
  const size = docSize(name);
  const budget = docBudget(config, name);
  return [
    `## ${name} (${DOC_PURPOSE[name]}; ${size} of ${budget} characters${size > budget ? ", OVER BUDGET: shrink it" : ""})`,
    readDoc(name),
  ].join("\n");
}

export async function runDocPass(
  config: AugConfig,
  at = new Date(),
  force = false,
): Promise<{ proposed: number; ideas: number; archived: number; skipped?: string }> {
  const archived = archiveStale(at);
  if (!force && !docPassDue(at))
    return { proposed: 0, ideas: 0, archived, skipped: "not due" };
  const over = EDITABLE.filter((name) => overBudget(config, name));
  const sig = signature();
  if (!force && sig === store.kvGet(SEEN) && over.length === 0) {
    store.kvSet(LAST_RUN, at.toISOString());
    return { proposed: 0, ideas: 0, archived, skipped: "nothing new" };
  }
  const result = await think({
    prompt: [
      ...EDITABLE.map((name) => docSection(config, name)),
      "## Corrections since the last pass",
      sinceLastPass(),
      `Today is ${at.toISOString().slice(0, 10)}.`,
    ].join("\n\n"),
    system: [
      "You keep aug's brain docs. aug is the owner's work manager; these docs go into every prompt it runs, so each word costs on every call. LEARNED.md is what aug learned from the owner's corrections; PERSONA, JOB and STYLE are the owner's own docs, written as the owner speaking.",
      "Propose an edit only when it earns its place:",
      "- A lesson in use in LEARNED.md that is settled and belongs in PERSONA, JOB or STYLE: fold it in, in the owner's voice, and list the LEARNED.md lines it absorbs.",
      "- A doc marked OVER BUDGET: a shorter text that keeps every rule. For LEARNED.md, merge and drop lines and list the dropped ones under absorbs.",
      "Each text is the whole doc, under its budget. Never touch a line the owner wrote in LEARNED.md (one with no [s:...] tag) except to absorb it into their own doc. Never record a secret.",
      "A lesson that is about how aug itself triages or how its agents work belongs in aug's shipped docs, not here: say it as an idea instead.",
      "Zero edits is the usual answer.",
    ].join("\n"),
    schema: PASS_SCHEMA,
    model: config.brain.assistantModel,
  });
  const answer = result.structured as PassAnswer | null;
  let proposed = 0;
  for (const edit of answer?.edits ?? []) {
    const doc = EDITABLE.find((d) => d === edit.doc);
    if (!doc || !edit.text?.trim()) continue;
    const text = edit.text.trimEnd() + "\n";
    const current = readDoc(doc);
    if (text === current) continue;
    const size = doc === DocName.learned ? learnedInUse(text).length : text.length;
    // Never a proposal that is over budget and no smaller than what it
    // replaces.
    if (size > docBudget(config, doc) && text.length >= current.length) continue;
    if (doc === DocName.learned) {
      const drops = unearnedDrops(current, text, edit.absorbs ?? []);
      if (drops.length) {
        log.info("doc pass dropped a LEARNED.md edit", { lines: drops.length });
        continue;
      }
    }
    propose({
      doc,
      source: ProposalSource.evolve,
      proposed: text,
      reason: edit.reason,
      absorbs: edit.absorbs ?? [],
    });
    proposed++;
  }
  let ideas = 0;
  const open = store.openIdeas().map((i) => i.title.toLowerCase());
  for (const idea of answer?.ideas ?? []) {
    if (open.includes(idea.title.toLowerCase())) continue;
    store.addIdea(idea.title, `${idea.body}\n\n(A change to aug's shipped docs: an AUG-MISC task.)`, null);
    ideas++;
  }
  store.kvSet(SEEN, signature());
  store.kvSet(LAST_RUN, at.toISOString());
  log.info("doc pass", { proposed, ideas, archived });
  return { proposed, ideas, archived };
}
