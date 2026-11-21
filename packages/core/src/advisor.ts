// The Advisor: the brain on the clock. It reads your open work and what you
// have been doing and leaves at most a few ideas in the Inbox (the Board's
// tab) - what is late, what was not followed up. It never acts; an idea
// becomes work only when you approve it there.

import { createHash } from "node:crypto";
import { think } from "./brain";
import type { RikerConfig } from "./config";
import { docsBlock } from "./prompts";
import { isSlipped } from "./rail";
import { capReached } from "./spend";
import * as store from "./store";
import { Kind, SpendRole, TaskStatus } from "./types";

const IDEAS_SCHEMA = {
  type: "object",
  properties: {
    ideas: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "short, like a task title" },
          body: {
            type: "string",
            description:
              "two sentences: what you noticed and what you would do",
          },
          task: {
            type: "string",
            description: "the RIKER-#### it is about, or empty",
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
    (t) =>
      t.kind !== Kind.system &&
      (t.status === TaskStatus.open || t.status === TaskStatus.later),
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

const LAST_RUN = "advisor.lastRun";
// The hash of the work picture the model last read.
const LAST_PICTURE = "advisor.lastPicture";

export interface AdvisorRun {
  added: number;
  // Why no model was asked, when none was.
  skipped?: string;
}

// Unchanged work gets the same ideas back, so the model is asked only when
// the picture moved (or the owner asked for a run: force).
export async function runAdvisor(
  config: RikerConfig,
  at = new Date(),
  force = false,
): Promise<AdvisorRun> {
  const picture = workPicture(at);
  const hash = createHash("sha256").update(picture).digest("hex");
  if (!force && hash === store.kvGet(LAST_PICTURE)) {
    store.kvSet(LAST_RUN, at.toISOString());
    return { added: 0, skipped: "work unchanged" };
  }
  if (!force && capReached(config, at)) {
    // Not marked run: the next tick after the cap lifts asks.
    return { added: 0, skipped: "daily spend cap reached" };
  }
  const existing = store.openIdeas().map((i) => i.title.toLowerCase());
  const result = await think({
    prompt: `${picture}\n\nIdeas already in the Inbox:\n${existing.join("\n") || "(none)"}\n\nToday is ${at.toISOString().slice(0, 10)}.`,
    system: [
      "You are the Advisor in Riker, the owner's work manager. Look at the work and say what is late, slipped, not followed up, or worth bringing up - at most three ideas, none repeating one already in the Inbox. Fewer is better; zero is fine.",
      docsBlock(config, { persona: true, job: true, learned: true }),
    ].join("\n\n"),
    schema: IDEAS_SCHEMA,
    model: config.brain.assistantModel,
    spend: { role: SpendRole.advisor },
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
  store.kvSet(LAST_RUN, at.toISOString());
  store.kvSet(LAST_PICTURE, hash);
  return { added };
}
