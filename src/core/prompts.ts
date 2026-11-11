// The operator docs as the models are told them. Every system prompt stitches
// some of SOUL, JOB, STYLE and LEARNED under headings, each cut to a budget;
// this is that stitching, once, so a new prompt names what it wants.

import { DocName, head, learnedInUse, readDoc } from "./docs";

export interface DocsBlock {
  // Characters of each doc to include; left out, the doc is not included.
  soul?: number;
  job?: number;
  style?: number;
  // Lines of LEARNED.md in use (never the Watching section).
  learned?: boolean;
  // Appended to the heading, e.g. "(head)".
  note?: string;
}

export function docsBlock(parts: DocsBlock): string {
  const note = parts.note ? ` ${parts.note}` : "";
  const out: string[] = [];
  if (parts.soul) {
    out.push(`## SOUL.md${note}`, head(readDoc(DocName.soul), parts.soul));
  }
  if (parts.job) {
    out.push(`## JOB.md${note}`, head(readDoc(DocName.job), parts.job));
  }
  if (parts.style) {
    out.push(
      "## STYLE.md (for any reply you draft)",
      head(readDoc(DocName.style), parts.style),
    );
  }
  if (parts.learned) out.push("## LEARNED.md (lines in use)", learnedInUse());
  return out.join("\n");
}
