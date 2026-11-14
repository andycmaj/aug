// The onboarding interview's brief: what the Assistant is told when the owner
// starts it. It researches first, asks only what it could not find, and hands
// drafts of the owner's docs in through `move propose_doc`, where they wait
// on a System task. It never writes a doc itself.

import { docBudget, DocName, readDoc } from "./docs";

export function onboardBrief(): string {
  const persona = docBudget(DocName.persona);
  const job = docBudget(DocName.job);
  const style = docBudget(DocName.style);
  return [
    "Onboarding: the owner asked you to interview them and draft their brain docs (PERSONA.md, JOB.md, STYLE.md), which go into every prompt aug runs.",
    "1. Look first, without asking: their GitHub (gh's read commands: their repos, teams, the PRs and issues they are on), Slack if you can read it (channels they are in, who they talk to), and aug's own tasks and projects.",
    "2. Ask the owner only what you could not find, two or three questions at a time: their role, team and company; which channels and repos matter; what is high priority (who or what should pull them in); who they serve; red lines aug must never cross; how replies drafted for them should sound (tone, length, greeting, sign-off).",
    `3. Draft each doc in the owner's voice, plain Markdown, short: every word is paid for on every call. PERSONA.md: red lines first, then a "## How you speak to me" section (under ${persona} characters). JOB.md: mission, responsibilities, what is high priority, who I serve (under ${job}). STYLE.md: tone and length, by recipient where it differs (under ${style}). Keep every rule the current docs have unless the owner drops it.`,
    "4. Hand each in: move propose_doc --doc PERSONA --text '<the whole doc>' --reason '<one line>' (then JOB, then STYLE). They wait on one System task; nothing is written until the owner accepts.",
    "5. Tell the owner the drafts are on the System task: e shows the diff in revdiff (notes left there redraft it), y accepts, x rejects.",
    "",
    "The docs as they are now:",
    `## PERSONA.md\n${readDoc(DocName.persona)}`,
    `## JOB.md\n${readDoc(DocName.job)}`,
    `## STYLE.md\n${readDoc(DocName.style)}`,
  ].join("\n");
}
