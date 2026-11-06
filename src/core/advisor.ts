// The Advisor: the brain on the clock. It reads your open work and what you
// have been doing and leaves at most a few ideas on the rail - what is late,
// what was not followed up. It never acts; an idea becomes work only when you
// make it a task.

import { think } from "./brain";
import { loadConfig } from "./config";
import { DocName, head, learnedInUse, readDoc } from "./docs";
import { isSlipped } from "./rail";
import * as store from "./store";
import { TaskStatus } from "./types";

const IDEAS_SCHEMA = {
  type: "object",
  properties: {
    ideas: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "short, like a rail row" },
          body: {
            type: "string",
            description:
              "two sentences: what you noticed and what you would do",
          },
          task: {
            type: "string",
            description: "the AUG-#### it is about, or empty",
          },
        },
        required: ["title", "body"],
      },
    },
  },
  required: ["ideas"],
} as const;

interface IdeasAnswer {
  ideas: { title: string; body: string; task?: string }[];
}

export const ADVISOR_EVERY_MS = 3 * 3600 * 1000;

export function advisorDue(lastRun: string | null, at: Date): boolean {
  return !lastRun || at.getTime() - Date.parse(lastRun) >= ADVISOR_EVERY_MS;
}

export function workPicture(at: Date): string {
  const tasks = store.listTasks();
  const lines: string[] = [];
  for (const t of tasks.filter(
    (t) => t.status === TaskStatus.open || t.status === TaskStatus.later,
  )) {
    const messages = store.messagesForTask(t.id);
    const heard = [...messages].reverse().find((m) => !m.from_me)?.received_at;
    const days = Math.floor(
      (at.getTime() - Date.parse(t.created_at)) / 86400000,
    );
    lines.push(
      `${store.taskRef(t.id)} [${t.kind}, ${t.priority}, open ${days}d, agent ${t.agent_state}${t.waiting_on ? `, waiting on ${t.waiting_on}` : ""}${isSlipped(t, heard, at) ? ", SLIPPED" : ""}] ${t.title}`,
    );
  }
  const closed = tasks
    .filter(
      (t) =>
        t.status === TaskStatus.done &&
        t.closed_at &&
        at.getTime() - Date.parse(t.closed_at) < 7 * 86400000,
    )
    .map((t) => `${store.taskRef(t.id)} closed by ${t.closed_by}: ${t.title}`);
  return [
    `Open work (${lines.length}):`,
    ...lines,
    "",
    `Closed this week (${closed.length}):`,
    ...closed,
  ].join("\n");
}

export async function runAdvisor(at = new Date()): Promise<number> {
  const existing = store.openIdeas().map((i) => i.title.toLowerCase());
  const result = await think({
    prompt: `${workPicture(at)}\n\nIdeas already on the rail:\n${existing.join("\n") || "(none)"}\n\nToday is ${at.toISOString().slice(0, 10)}.`,
    system: [
      "You are the Advisor in aug, the owner's work manager. Look at the work and say what is late, slipped, not followed up, or worth bringing up - at most three ideas, none repeating one already on the rail. Fewer is better; zero is fine.",
      readDoc(DocName.counsel),
      "## JOB.md",
      head(readDoc(DocName.job), 2500),
      "## LEARNED.md",
      learnedInUse(),
    ].join("\n\n"),
    schema: IDEAS_SCHEMA as unknown as Record<string, unknown>,
    model: loadConfig().brain.assistantModel,
  });
  const answer = result.structured as IdeasAnswer | null;
  let added = 0;
  for (const idea of answer?.ideas ?? []) {
    if (existing.includes(idea.title.toLowerCase())) continue;
    const taskId = idea.task ? store.parseTaskRef(idea.task) : null;
    store.addIdea(
      idea.title,
      idea.body,
      taskId && store.getTask(taskId) ? taskId : null,
    );
    added++;
  }
  store.kvSet("advisor.lastRun", at.toISOString());
  return added;
}
