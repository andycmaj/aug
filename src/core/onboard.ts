// The onboarding interview: interactive claude in its System task's own tmux
// window, so the owner answers in a real session (their settings, connectors
// and permission prompts) shown in the task's canvas. It researches first,
// asks only what it could not find, and hands drafts of the owner's docs in
// through `move propose_doc --file`, where they wait on the same task. It
// never writes a doc itself.

import { join } from "node:path";
import type { AugConfig } from "./config";
import { docBudget, DocName, readDoc } from "./docs";
import { docDraftsDir } from "./paths";
import { toolsCommand } from "./self";
import * as store from "./store";
import type { TaskRow } from "./types";

export const ONBOARD_START =
  "Start the onboarding interview: look first, then ask me what you could not find.";

export function onboardBrief(config: AugConfig, task: TaskRow): string {
  const persona = docBudget(config, DocName.persona);
  const job = docBudget(config, DocName.job);
  const style = docBudget(config, DocName.style);
  const draft = (doc: string) => join(docDraftsDir(), `${doc}.md`);
  return [
    `You are running aug's onboarding interview (${store.taskRef(task.id)}). The owner of aug asked you to interview them in this session and draft their brain docs (PERSONA.md, JOB.md, STYLE.md), which go into every prompt aug runs.`,
    "",
    "1. Look first, without asking: their GitHub (gh's read commands: their repos, teams, the PRs and issues they are on), Slack if you can read it (channels they are in, who they talk to), and aug's own tasks and projects:",
    `   ${toolsCommand("tasks")}, ${toolsCommand("projects")}, ${toolsCommand("project", "<name>")}, ${toolsCommand("knowledge", "search", "<words>")}`,
    "2. Ask the owner only what you could not find, two or three questions at a time: their role, team and company; which channels and repos matter; what is high priority (who or what should pull them in); who they serve; red lines aug must never cross; how replies drafted for them should sound (tone, length, greeting, sign-off).",
    `3. Draft each doc in the owner's voice, plain Markdown, short: every word is paid for on every call. PERSONA.md: red lines first, then a "## How you speak to me" section (under ${persona} characters). JOB.md: mission, responsibilities, what is high priority, who I serve (under ${job}). STYLE.md: tone and length, by recipient where it differs (under ${style}). Keep every rule the current docs have unless the owner drops it.`,
    `4. Hand each in: write the whole doc with the Write tool to ${draft("PERSONA")}, then run`,
    `   ${toolsCommand("move", "propose_doc", "--doc", "PERSONA", "--file", draft("PERSONA"), "--reason", "<one line>")}`,
    "   then JOB, then STYLE. Never put the doc itself on the command line. Handing one in again replaces the draft. Nothing is written until the owner accepts.",
    "5. Tell the owner the drafts wait on this task in aug: end this session (/exit), then e shows the diff in revdiff (notes left there redraft it), y accepts, x rejects. y with no drafts waiting picks this interview up again.",
    "Do not edit the brain docs, the owner's dotfiles or Claude settings yourself.",
    "",
    "The docs as they are now:",
    `## PERSONA.md\n${readDoc(DocName.persona)}`,
    `## JOB.md\n${readDoc(DocName.job)}`,
    `## STYLE.md\n${readDoc(DocName.style)}`,
  ].join("\n");
}
