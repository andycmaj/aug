// The operator docs as the models are told them. Every system prompt stitches
// some of PERSONA, JOB, STYLE and LEARNED under headings; this is that
// stitching, once, so a new prompt names what it wants. Each doc comes whole
// up to twice its budget (docs.ts forPrompt).

import { DocName, forPrompt, learnedInUse } from "./docs";

export interface DocsBlock {
  persona?: boolean;
  job?: boolean;
  style?: boolean;
  // Lines of LEARNED.md in use (never the Watching section).
  learned?: boolean;
}

export function docsBlock(parts: DocsBlock): string {
  const out: string[] = [];
  if (parts.persona) out.push("## PERSONA.md", forPrompt(DocName.persona));
  if (parts.job) out.push("## JOB.md", forPrompt(DocName.job));
  if (parts.style)
    out.push("## STYLE.md (for any reply you draft)", forPrompt(DocName.style));
  if (parts.learned)
    out.push(
      "## LEARNED.md (lines in use)",
      forPrompt(DocName.learned, learnedInUse()),
    );
  return out.join("\n");
}
