// The Assistant: the voice and the hands. It answers about the item on the
// table and moves things (done, remind, watch, start, redraft...) by naming a
// verb; the engine carries the verbs out. It never does the work and never
// sends: a Send is only ever the owner's press.

import { think } from "./brain";
import { loadConfig } from "./config";
import { DocName, head, learnedInUse, readDoc } from "./docs";
import { transcript } from "./agents";
import * as store from "./store";
import { TaskStatus } from "./types";

export const Verb = {
  done: "done",
  remind: "remind",
  watch: "watch",
  unwatch: "unwatch",
  start: "start",
  stop: "stop",
  redraft: "redraft",
  notATask: "not_a_task",
  open: "open",
  priority: "priority",
  remember: "remember",
  tell: "tell",
} as const;
export type Verb = (typeof Verb)[keyof typeof Verb];

export const VERB_HELP: Record<Verb, string> = {
  done: "Mark done the task",
  remind: "Remind me: arg = days from now (1 = tomorrow)",
  watch: "Watch it (not yours, kept open)",
  unwatch: "Stop watching",
  start: "Send the task to its agent",
  stop: "Stop the task's agent and save",
  redraft: "Ask the agent for a different draft: arg = what to change",
  not_a_task: "Not a task: drop it and teach triage",
  open: "Put the task on the table",
  priority: "Set priority: arg = urgent | important | regular",
  remember: "Write a line the owner said into LEARNED.md: arg = the line",
  tell: "Type a line into the task's chat for its agent: arg = the line",
};

const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string", description: "what you say to the owner, short" },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          verb: { type: "string", enum: Object.values(Verb) },
          task: {
            type: "string",
            description:
              "task ref like AUG-0012; empty means the task on the table",
          },
          arg: { type: "string" },
        },
        required: ["verb"],
      },
    },
  },
  required: ["reply", "actions"],
} as const;

export interface AssistantAction {
  verb: Verb;
  task?: string;
  arg?: string;
}

export interface AssistantAnswer {
  reply: string;
  actions: AssistantAction[];
}

export interface AssistantExchange {
  role: "you" | "aug";
  text: string;
}

export function railSummary(): string {
  return store
    .listTasks()
    .filter(
      (t) => t.status === TaskStatus.open || t.status === TaskStatus.later,
    )
    .slice(-40)
    .map(
      (t) =>
        `${store.taskRef(t.id)} [${t.kind}${t.watching ? ", watching" : ""}${t.status === "later" ? `, later until ${t.remind_at?.slice(0, 10)}` : ""}${t.priority !== "regular" ? `, ${t.priority}` : ""}, agent ${t.agent_state}] ${t.title}`,
    )
    .join("\n");
}

export async function ask(
  question: string,
  tableTaskId: number | null,
  history: AssistantExchange[],
): Promise<AssistantAnswer> {
  const task = tableTaskId ? store.getTask(tableTaskId) : null;
  const table = task
    ? [
        `On the table: ${store.taskRef(task.id)} "${task.title}" (${task.kind}, ${task.status}, agent ${task.agent_state})`,
        task.summary,
        transcript(store.turnsForTask(task.id).slice(-12)),
      ].join("\n")
    : "Nothing is on the table.";
  const verbs = Object.entries(VERB_HELP)
    .map(([verb, help]) => `- ${verb}: ${help}`)
    .join("\n");
  const result = await think({
    prompt: [
      table,
      "",
      "Open work:",
      railSummary() || "(none)",
      "",
      history.length
        ? `Earlier in this conversation:\n${history.map((h) => `${h.role}: ${h.text}`).join("\n")}`
        : "",
      `The owner says: ${question}`,
    ].join("\n"),
    system: [
      "You are the Assistant inside aug, the owner's work manager in a terminal. You answer about the work and move it with verbs. You never do the task's work yourself and you never send anything: sending is the owner's press.",
      `Verbs you may return:\n${verbs}`,
      "Only return a verb the owner asked for, in words or plainly. Return no verb for a question.",
      readDoc(DocName.counsel),
      "## SOUL.md",
      head(readDoc(DocName.soul), 3000),
      "## JOB.md",
      head(readDoc(DocName.job), 2000),
      "## LEARNED.md",
      learnedInUse(),
    ].join("\n\n"),
    schema: ANSWER_SCHEMA as unknown as Record<string, unknown>,
    model: loadConfig().brain.assistantModel,
  });
  const answer = result.structured as AssistantAnswer | null;
  return answer ?? { reply: result.text || "(no answer)", actions: [] };
}
