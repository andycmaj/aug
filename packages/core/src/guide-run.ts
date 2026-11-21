// The guide's calls (docs/task-actions-design.md, guide in batches). A
// change that fits one call is one call (job whole): the whole numbered
// diff in the prompt, the guide JSON back. A bigger one is one call per
// batch (job notes: its files' summaries and review notes), a few at a time,
// then one call that orders every file into chapters from the index and
// those summaries (job chapters). aug lays the notes into the chapters.
// Every file's diff is in exactly one prompt; what no call answered for is
// said on the turn, never passed over.

import {
  numberedPatch,
  parseBatchNotes,
  parseGuide,
  type Guide,
  type GuideDiff,
} from "./guide";
import type { BatchPlan, FilePatch } from "./guide-batches";

export type GuideAsk = (prompt: string, label: string) => Promise<{ text: string; denied: string[] }>;

export interface GuideRun {
  guide: Guide;
  denied: string[];
  // What the review does not cover, one line each, for the turn.
  gaps: string[];
  calls: number;
}

const CONCURRENCY = 3;

export const GuideJob = {
  whole: "whole",
  notes: "notes",
  chapters: "chapters",
} as const;

function counts(f: FilePatch): string {
  return `(+${f.added} -${f.removed})`;
}

// Every changed file, one line each, with where it is.
function indexLines(
  plan: BatchPlan,
  mark: (f: FilePatch) => string,
): string {
  return plan.all
    .map((f) => {
      const why = plan.lockfiles.includes(f.file)
        ? " lock file, not shown"
        : plan.tooLarge.includes(f.file)
          ? " too large to show"
          : mark(f);
      return `- ${f.file} ${counts(f)}${why ? `:${why}` : ""}`;
    })
    .join("\n");
}

function diffs(files: FilePatch[]): string {
  return files.map((f) => numberedPatch(f.text)).join("\n");
}

const NUMBERS =
  "Each hunk line carries its old and new line numbers in two columns: pin notes to those, never to any other numbering.";

export async function reviewInBatches(opts: {
  plan: BatchPlan;
  // The task's context and the skill's invocation, ending in its args.
  prompt: (job: string) => string;
  commits: string;
  ask: GuideAsk;
}): Promise<GuideRun | { error: string; answer?: string }> {
  const { plan, ask } = opts;
  const denied: string[] = [];
  const gaps = plan.tooLarge.length
    ? [`Not reviewed, too large for one call: ${plan.tooLarge.map((f) => `\`${f}\``).join(", ")}.`]
    : [];
  if (plan.batches.length === 0) return { error: "nothing in the change to review (only lock files or files too large)" };

  if (plan.batches.length === 1) {
    const answer = await ask(
      [
        opts.prompt(GuideJob.whole),
        "",
        `The change's diff, in full. ${NUMBERS}`,
        "",
        "Changed files:",
        indexLines(plan, () => ""),
        "",
        diffs(plan.batches[0]!),
      ].join("\n"),
      "guide",
    );
    denied.push(...answer.denied);
    const guide = parseGuide(answer.text);
    if ("error" in guide) return { error: guide.error, answer: answer.text };
    return { guide, denied, gaps, calls: 1 };
  }

  // Job notes, a few batches at a time.
  const n = plan.batches.length;
  const reviewed = new Map<string, GuideDiff>();
  const unanswered: string[] = [];
  const batchOf = new Map<string, number>();
  plan.batches.forEach((b, k) => b.forEach((f) => batchOf.set(f.file, k + 1)));
  const one = async (k: number) => {
    const batch = plan.batches[k]!;
    const mine = new Set(batch.map((f) => f.file));
    const answer = await ask(
      [
        opts.prompt(`${GuideJob.notes}, batch ${k + 1} of ${n}`),
        "",
        `This batch's files, their diffs in full below. ${NUMBERS} Review only these files; Read any other file when a finding needs it.`,
        "",
        "Every changed file:",
        indexLines(plan, (f) => (mine.has(f.file) ? " in this batch" : ` batch ${batchOf.get(f.file)}`)),
        "",
        diffs(batch),
      ].join("\n"),
      `batch ${k + 1}/${n}`,
    );
    denied.push(...answer.denied);
    const parsed = parseBatchNotes(answer.text);
    const got = "error" in parsed ? [] : parsed.filter((d) => mine.has(d.file));
    for (const d of got) reviewed.set(d.file, d);
    for (const f of batch) if (!reviewed.has(f.file)) unanswered.push(f.file);
  };
  for (let k = 0; k < n; k += CONCURRENCY)
    await Promise.all(plan.batches.slice(k, k + CONCURRENCY).map((_, i) => one(k + i)));
  if (unanswered.length)
    gaps.push(`No review came back for ${unanswered.map((f) => `\`${f}\``).join(", ")}.`);

  // Job chapters, from the index and the summaries.
  const answer = await ask(
    [
      opts.prompt(GuideJob.chapters),
      "",
      `Every file's diff was reviewed in ${n} batches. Order the files into chapters from this index and its summaries.`,
      opts.commits ? `\nThe branch's commits:\n${opts.commits}` : "",
      "",
      "Every changed file, with its summary:",
      indexLines(plan, (f) => {
        const d = reviewed.get(f.file);
        return d?.summary ? ` ${d.summary}` : "";
      }),
    ].join("\n"),
    "chapters",
  );
  denied.push(...answer.denied);
  const chapters = parseGuide(answer.text);
  const shown = plan.all.filter((f) => !plan.lockfiles.includes(f.file) && !plan.tooLarge.includes(f.file));
  let guide: Guide;
  if ("error" in chapters) {
    gaps.push(`The chapters were not written (${chapters.error}): every file is in one.`);
    guide = { title: "Guided review", intent: "", sections: [{ title: "Changes", overview: "", diffs: [] }], unplacedFiles: [] };
  } else guide = chapters;

  // The batches' notes laid into the chapters; a reviewed file no chapter
  // named goes in a last one, so its notes are kept.
  const placed = new Set<string>();
  const sections = guide.sections.map((s) => ({
    ...s,
    diffs: s.diffs.flatMap((d) => {
      if (placed.has(d.file)) return [];
      placed.add(d.file);
      const r = reviewed.get(d.file);
      return [{ file: d.file, summary: r?.summary || d.summary, ...(r?.notes?.length ? { notes: r.notes } : {}) }];
    }),
  }));
  const left = shown.filter((f) => !placed.has(f.file));
  if (left.length)
    sections.push({
      title: "Other changes",
      overview: "",
      diffs: left.map((f) => {
        const r = reviewed.get(f.file);
        return { file: f.file, summary: r?.summary ?? "", ...(r?.notes?.length ? { notes: r.notes } : {}) };
      }),
    });
  return {
    guide: { ...guide, sections: sections.filter((s) => s.diffs.length > 0) },
    denied,
    gaps,
    calls: n + 1,
  };
}
