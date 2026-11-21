// Riker's words for a guide run (@riker/code-review-plannotator does the run):
// the action's turn, and how the task's actions name reopening its review.

import type { SavedGuide } from "@riker/code-review-plannotator/guide";

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
