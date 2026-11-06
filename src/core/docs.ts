// The operator documents: plain Markdown under ~/.aug/docs that the models are
// actually told. Three you write (SOUL, JOB, STYLE), the rest ship with
// defaults you can rewrite, and LEARNED.md writes itself.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths, ensureHome } from "./paths";

export const DocName = {
  soul: "SOUL.md",
  job: "JOB.md",
  triage: "TRIAGE.md",
  style: "STYLE.md",
  counsel: "COUNSEL.md",
  assistant: "ASSISTANT.md",
  coding: "CODING.md",
  learned: "LEARNED.md",
} as const;
export type DocName = (typeof DocName)[keyof typeof DocName];

export const DOC_PURPOSE: Record<DocName, string> = {
  "SOUL.md": "the constitution: rules, voice, escalation lines",
  "JOB.md": "what your job is; weighs importance, never intent",
  "TRIAGE.md": "what makes something a task, a reply, a watch or an FYI",
  "STYLE.md": "greeting, tone, length, phrasing of replies",
  "COUNSEL.md": "how the assistant speaks and takes a position",
  "ASSISTANT.md": "how a general agent works a task",
  "CODING.md": "how a coding agent works and closes out",
  "LEARNED.md": "what was learned from what you do",
};

const DEFAULTS: Record<DocName, string> = {
  "SOUL.md": `# SOUL

Rules that outrank everything else.

- Nothing goes out without my press. Draft; never send.
- Never share credentials, tokens or private repository contents outside the thread they came from.
- When unsure whether something is mine, say so and ask.
`,
  "JOB.md": `# JOB

What my job is. Triage weighs importance by this, never intent.

- Mission:
- Responsibilities:
- Who I serve:
- Cadences:
`,
  "TRIAGE.md": `# TRIAGE

- fyi: nothing to do. CI notifications, bots, announcements, threads where my part is done.
- reply: a sentence settles it. A direct question to me with a short answer.
- general: worth thinking about - research, a recommendation, making sense of a thread.
- coding: an agent at a keyboard. A bug, a failing check, a requested change in a repository.
- task: mine to do in the world - decide, attend, review by hand.
- watch: a thread I care about that somebody else will handle.

A pull request review requested from me is a task unless JOB.md says otherwise.
A question in a DM is usually reply.
`,
  "STYLE.md": `# STYLE

- Short. Lead with the answer.
- No greeting on Slack. A one-word sign-off is fine on GitHub.

## By recipient
`,
  "COUNSEL.md": `# COUNSEL

Speak plainly and briefly. Take a position when asked; say what you would do and why in one line.
`,
  "ASSISTANT.md": `# ASSISTANT

You are a general agent working one task for the owner. Read the thread, do the thinking or research, and hand back the result.
You never send anything yourself. When a reply is owed, draft it as an aug-action block; the owner presses Send.
When a decision is the owner's, say so plainly under Next steps.
`,
  "CODING.md": `# CODING

You are a coding agent working one task in this repository.
- Read the task brief first. Keep changes small and focused.
- Run the tests that cover what you touched.
- Do not push, merge or deploy. Commit on a branch if the task calls for it.
- When finished, report with the aug done command from your brief.
`,
  "LEARNED.md": `# LEARNED

What was learned from what you do. Machine-written lines carry [s:strength | ev:evidence | seen:date].
Lines you write yourself are never rewritten. SOUL.md always outranks this file.

## Your people

## What you care about

## How you work

## Promises

## What to bring up

## Watching
`,
};

export function docPath(name: DocName): string {
  return join(paths.docs(), name);
}

export function ensureDocs(): void {
  ensureHome();
  for (const name of Object.values(DocName)) {
    const file = docPath(name);
    if (!existsSync(file)) writeFileSync(file, DEFAULTS[name]);
  }
}

export function readDoc(name: DocName): string {
  const file = docPath(name);
  return existsSync(file) ? readFileSync(file, "utf8") : DEFAULTS[name];
}

export function writeDoc(name: DocName, text: string): void {
  ensureHome();
  writeFileSync(docPath(name), text);
}

export function head(text: string, chars: number): string {
  return text.length <= chars ? text : text.slice(0, chars) + "\n…";
}

// LEARNED.md's lines in use: everything but the Watching section, where new
// hypotheses wait at low strength and nothing reads them.
export function learnedInUse(text = readDoc(DocName.learned)): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) skipping = /^## Watching/i.test(line);
    if (!skipping) out.push(line);
  }
  return out.join("\n").trim();
}
