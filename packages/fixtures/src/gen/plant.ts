// --plant: haiku writes a small, plausible change to one file with exactly
// one subtle bug in it, and says where, so a guide's findings can be checked
// against a known answer (the evals' corpus). The PR's words never give the
// bug away; the generator keeps it in its own state.

import { think } from "@riker/core/brain";
import { SpendRole } from "@riker/core/types";
import type { Change } from "./target";

export interface Planted {
  change: Change;
  bug: { path: string; line: number; what: string };
}

const SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    body: { type: "string" },
    content: { type: "string" },
    bugLine: { type: "number" },
    bug: { type: "string" },
  },
  required: ["title", "body", "content", "bugLine", "bug"],
} as const;

interface Answer {
  title: string;
  body: string;
  content: string;
  bugLine: number;
  bug: string;
}

export const PLANT_MODEL = "haiku";

export async function plant(path: string, content: string): Promise<Planted> {
  const result = await think({
    model: PLANT_MODEL,
    schema: SCHEMA,
    spend: { role: SpendRole.gen, taskId: null },
    system:
      "You write test material for a code review tool. Change files as asked; answer with the JSON only.",
    prompt: [
      `Make one small, realistic change to ${path} (a tweak to behaviour, a small feature or a refactor, 5 to 40 lines), as a colleague's pull request would.`,
      "Plant exactly one subtle bug in the lines you change: an off-by-one, a wrong comparison, a missed await, a swapped argument, an unhandled empty case. It must look intentional and compile.",
      "title: the PR's title. body: its description, as the author would write it; it must not hint at the bug.",
      "content: the whole new file. bugLine: the bug's line in the new file. bug: one sentence saying what is wrong.",
      "",
      `The file now:\n\`\`\`\n${content}\n\`\`\``,
    ].join("\n"),
  });
  if (result.isError) {
    throw new Error(`plant: ${result.text}`);
  }
  const a = (result.structured ?? JSON.parse(result.text)) as Answer;
  return {
    change: {
      title: a.title,
      body: a.body,
      files: [{ path, content: a.content }],
      source: `planted in ${path}`,
    },
    bug: { path, line: a.bugLine, what: a.bug },
  };
}

// A file worth planting in: source, not too long.
export function plantable(path: string, content: string): boolean {
  return (
    /\.(ts|tsx|js|py|go|rs)$/.test(path) &&
    !/test|spec|fixture/i.test(path) &&
    content.split("\n").length <= 400
  );
}
