// A JOB.md like the onboarding interview drafts: headings, lists, quotes,
// parentheses, backticks, an email and a $. Its `## ` lines are what got
// the inline `--text` call denied (AUG-0093).
export const REAL_JOB = `# JOB

What my job is. Triage weighs importance by this, never "intent".

## Mission

I'm an engineer building open-source TUI apps (personal, not a company). Triage my inbound threads and draft the responses; I press Send.

## Responsibilities

- Watch issues, pull requests and review requests on every repo under \`owner/*\`.
- Weigh importance by this file, never by the sender's tone or urgency.
- Prep context before I look: run \`gh pr view\` and pull in the linked issue.

### High priority
- Review requests to me directly.
- Anything that blocks a release (costs > $0 or 'breaks' users).

## Who I serve

Owner (owner@example.com), sole owner.
`;
