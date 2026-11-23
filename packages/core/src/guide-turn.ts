// Riker's words for a guide run (@riker/code-review-plannotator does the run):
// the action's turn, and how the task's actions name reopening its review.

import { reviewNotes, type SavedGuide } from "@riker/code-review-plannotator/guide";
import { GuideStage, type GuideProgress } from "@riker/code-review-plannotator/progress";
import type { RikerConfig } from "./config";
import { reviewedPr } from "./pr";
import { ActionOutput, makesCheckout, registeredActions, whyNotOffered } from "./task-actions";
import type { TaskRow } from "./types";

// The line a review task gets when it arrives: the guide is there to run,
// on the owner's word only (it spends money), and what running it does.
// Null when no guide action is offered on the task (turned off in config).
export function guideOffer(
  config: Pick<RikerConfig, "actions">,
  task: TaskRow,
): string | null {
  const spec = registeredActions(config).find(
    (a) => a.output === ActionOutput.guide && whyNotOffered(a, task) === null,
  );
  if (!spec) return null;
  const key = spec.key ? `\`${spec.key}\`, or ` : "";
  const checkout = makesCheckout(spec, task)
    ? `it makes the worktree on ${task.branch ?? "its branch"} (no agent starts), then `
    : "it ";
  const opens = reviewedPr(task)
    ? "opens the pull request in Plannotator with its findings; Post to GitHub there sends your review"
    : "opens it in Plannotator with its findings; what you send goes to the agent, not GitHub";
  return `A guided review is ready to run: ${key}\`.\` then "${spec.title}". ${checkout[0]!.toUpperCase()}${checkout.slice(1)}reviews the change headless and ${opens}. Start runs the review agent instead.`;
}

// What the action's turn says: the chapters, then the findings by file.
// `opened`: Riker opens the review now; else (a trigger ran it) the owner
// opens it from the task's actions. `denied`: calls the run was refused,
// so no notes may mean it did not look, not that nothing stood out.
export function guideMarkdown(
  saved: SavedGuide,
  opts: { opened?: boolean; denied?: string[]; gaps?: string[] } = {},
): string {
  const opened = opts.opened ?? true;
  const denied = opts.denied ?? [];
  const gaps = opts.gaps ?? [];
  const notes = saved.guide.sections.flatMap((s) =>
    s.diffs.flatMap((d) => (d.notes ?? []).map((n) => ({ file: d.file, n }))),
  );
  const count = saved.findings.length;
  const unpinned = count - notes.length;
  return [
    `**${saved.guide.title}**`,
    saved.guide.intent,
    "",
    `${saved.guide.sections.length} chapter${saved.guide.sections.length === 1 ? "" : "s"}: ${saved.guide.sections.map((s) => s.title).join("; ")}.`,
    ...(denied.length
      ? [
          `A read was denied (${denied.map((d) => `\`${d.slice(0, 120)}\``).join(", ")}): the review may have missed things.`,
          "",
        ]
      : []),
    ...(gaps.length ? [...gaps, ""] : []),
    count
      ? `${count} review note${count === 1 ? "" : "s"}${unpinned > 0 ? ` (${unpinned} not on a changed line)` : ""}:`
      : denied.length || gaps.length
        ? "No review notes."
        : "No review notes: nothing stood out.",
    ...saved.lines,
    "",
    opened
      ? `Saved in Plannotator (\`${saved.id}\`). The review Riker opens has these notes as comments; its Agents tab lists the guide.`
      : `Saved in Plannotator (\`${saved.id}\`). To see these notes as comments in its review, pick "${OPEN_REVIEW_TITLE}" from this task's actions (\`.\` or the palette).`,
  ]
    .filter((line, i, all) => line !== "" || all[i - 1] !== "")
    .join("\n");
}

// How the task's actions name opening the saved guide's review.
export const OPEN_REVIEW_TITLE = "Open the guide's review";

// One short line for where a guide run is, kept on its turn (`progress`)
// for the Canvas and the rail (whose row is narrow) while it runs, and
// after a failure to say where it stopped.
export function guideProgressLine(p: GuideProgress): string {
  switch (p.stage) {
    case GuideStage.read:
      return `diff read: ${p.files} file${p.files === 1 ? "" : "s"}, ${p.batches} batch${p.batches === 1 ? "" : "es"}`;
    case GuideStage.whole:
      return "reviewing in one call";
    case GuideStage.batches:
      // A few run at once and finish in any order: counted, not named.
      return `batches ${p.done}/${p.of} done${p.running ? `, ${p.running} running` : ""}`;
    case GuideStage.chapters:
      return "writing the chapters";
    case GuideStage.fitting:
      return "fitting the notes";
    case GuideStage.saving:
      return "saving to Plannotator";
  }
}

// What a guide's review leaves when it closes: notes for the agent, and a
// line for the toast. A PR the owner was asked to review opens in
// Plannotator's PR mode, where Post to GitHub sends the review and leaves
// one status line ("Pull request reviewed on GitHub: ..."); there nothing
// goes to the agent, and feedback sent the agent's way instead stays in
// the feedback file, unposted. Otherwise what was sent goes to the agent
// (reviewNotes).
export function reviewExit(
  posts: "github" | undefined,
  output: string,
): { notes: string | null; status: string | null } {
  if (posts !== "github") return { notes: reviewNotes(output), status: null };
  const said = reviewNotes(output);
  if (!said) return { notes: null, status: "Nothing was posted to GitHub" };
  const lines = said.split("\n").filter((l) => l.trim());
  if (lines.length === 1) return { notes: null, status: lines[0]!.trim().slice(0, 200) };
  return {
    notes: null,
    status: "Not posted to GitHub: Plannotator's Post to GitHub sends a review (your notes are in guide-feedback.md)",
  };
}
