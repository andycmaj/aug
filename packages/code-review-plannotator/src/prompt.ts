// The job instructions (skill/SKILL.md) for a caller with no plugin to load
// them from: the body goes in the system prompt, and its `allowed-tools` are
// what the call may run. Riker loads the same file as its plugin skill
// `riker:guide` instead, so there is one text of them.

import skill from "../skill/SKILL.md" with { type: "text" };

export const GUIDE_SKILL: string = skill;

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/;

// The instructions without their frontmatter.
export function skillBody(text: string = GUIDE_SKILL): string {
  return text.replace(FRONTMATTER, "").trim();
}

// The skill's `allowed-tools`, one rule each: `Read`, `Bash(git log:*)`.
export function skillTools(text: string = GUIDE_SKILL): string[] {
  const line = FRONTMATTER.exec(text)?.[1]
    ?.split("\n")
    .find((l) => l.startsWith("allowed-tools:"));
  if (!line) {
    return [];
  }
  const rules: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of line.slice("allowed-tools:".length)) {
    if (ch === "(") {
      depth++;
    }
    if (ch === ")") {
      depth--;
    }
    if (ch === "," && depth === 0) {
      if (current.trim()) {
        rules.push(current.trim());
      }
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) {
    rules.push(current.trim());
  }
  return rules;
}

// What the change is for, the base and the job, as the skill's arguments.
export function jobPrompt(opts: {
  base: string;
  pr?: string;
  about?: string;
}): (job: string) => string {
  return (job) =>
    [
      "Write the guided review in your instructions for the change in this checkout.",
      opts.about ? `What the change is for: ${opts.about}` : "",
      `Base branch: ${opts.base}`,
      opts.pr ? `Pull request: ${opts.pr}` : "",
      `Arguments: job: ${job}`,
    ]
      .filter(Boolean)
      .join("\n");
}
