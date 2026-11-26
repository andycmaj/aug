// One review of a checkout's change, start to end, with the model call
// handed in: the patch against the base, its batches, the calls, and the
// guide fitted to the patch. Saving it (Plannotator, files) is the caller's.

import {
  branchCommits,
  commitLog,
  planBatches,
  type BatchPlan,
} from "./batches";
import {
  fitGuide,
  patchFor,
  type Finding,
  type Guide,
  type Patch,
  type ReviewComment,
} from "./guide";
import type { GuideProgress } from "./progress";
import { jobPrompt } from "./prompt";
import { reviewInBatches, type GuideAsk } from "./run";

export interface ReviewOptions {
  cwd: string;
  ask: GuideAsk;
  // `main` also tries `master`; `origin/<base>` when the remote is ahead.
  base?: string;
  // The skill's arguments for a job; a plain one from base, pr and about by default.
  prompt?: (job: string) => string;
  pr?: string;
  about?: string;
  // Characters of numbered diff per call (batches.ts, BATCH_CHARS).
  batchChars?: number;
  fileMax?: number;
  progress?: (p: GuideProgress) => void;
}

export interface Review {
  patch: Patch;
  plan: BatchPlan;
  // As the calls answered it, every finding on it: what saveGuide takes.
  answered: Guide;
  // Fitted to the patch: chapters name only its files, notes only on their hunks.
  guide: Guide;
  findings: Finding[];
  // One Markdown line per finding.
  lines: string[];
  comments: ReviewComment[];
  gaps: string[];
  denied: string[];
  calls: number;
}

export async function review(
  opts: ReviewOptions,
): Promise<Review | { error: string; answer?: string }> {
  const patch = patchFor(opts.cwd, opts.base ?? "main");
  if ("error" in patch) {
    return patch;
  }
  const plan = planBatches(patch, opts.cwd, {
    budget: opts.batchChars,
    fileMax: opts.fileMax,
  });
  const commits = branchCommits(opts.cwd, patch.mergeBase).length
    ? commitLog(opts.cwd, patch.mergeBase)
    : "";
  const ran = await reviewInBatches({
    plan,
    commits,
    prompt:
      opts.prompt ??
      jobPrompt({ base: patch.base, pr: opts.pr, about: opts.about }),
    ask: opts.ask,
    progress: opts.progress,
  });
  if ("error" in ran) {
    return ran;
  }
  const fitted = fitGuide(ran.guide, patch.text);
  return {
    patch,
    plan,
    answered: ran.guide,
    guide: fitted.guide,
    findings: fitted.findings,
    lines: fitted.lines,
    comments: fitted.comments,
    gaps: ran.gaps,
    denied: ran.denied,
    calls: ran.calls,
  };
}
