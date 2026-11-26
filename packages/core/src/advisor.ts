// The Advisor: the brain on the clock. It reads your open work and what you
// have been doing and leaves at most a few ideas in the Inbox (the Board's
// tab) - what is late, what was not followed up. It never acts; an idea
// becomes work only when you approve it there.

import { createHash } from "node:crypto";
import { think } from "./brain";
import type { RikerConfig } from "./config";
import { logger } from "./log";
import { docsBlock } from "./prompts";
import { isSlipped } from "./rail";
import { capReached } from "./spend";
import * as store from "./store";
import { IdeaStatus, Kind, SpendRole, TaskStatus, type IdeaRow } from "./types";

const log = logger("advisor");

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

// How far back the Advisor remembers what it said and what the owner did
// with it, so an idea does not come back under new words.
export const PAST_IDEAS_DAYS = 30;

// Every idea still open, and every one made in the window whatever became of
// it.
export function pastIdeas(at: Date): IdeaRow[] {
  const since = new Date(
    at.getTime() - PAST_IDEAS_DAYS * 86400000,
  ).toISOString();
  const byId = new Map<number, IdeaRow>();
  for (const i of [...store.openIdeas(), ...store.ideasSince(since)]) {
    byId.set(i.id, i);
  }
  return [...byId.values()].sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id,
  );
}

function outcome(i: IdeaRow): string {
  switch (i.status) {
    case IdeaStatus.dismissed:
      return "dismissed";
    case IdeaStatus.tasked:
      return `approved${i.made_task_id ? ` as ${store.taskRef(i.made_task_id)}` : ""}`;
    default:
      return "open in the Inbox";
  }
}

// What the prompt lists: ideas on no task or on a task still open. One about
// a closed task is not in the work the model reads, so it costs tokens for
// nothing; the refusal (repeatsPastIdea) still reads every idea.
export function promptIdeas(past: IdeaRow[]): IdeaRow[] {
  return past.filter((i) => {
    if (!i.task_id) {
      return true;
    }
    const status = store.getTask(i.task_id)?.status;
    return status === TaskStatus.open || status === TaskStatus.later;
  });
}

export function pastIdeasBlock(past: IdeaRow[]): string {
  if (past.length === 0) {
    return "(none)";
  }
  return past
    .map(
      (i) =>
        `- [${outcome(i)}, ${i.created_at.slice(0, 10)}] ${i.title}${i.task_id ? ` (about ${store.taskRef(i.task_id)})` : ""}`,
    )
    .join("\n");
}

const sameTitle = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

// Why a new idea is refused, or null: it repeats one already said by title,
// or it is about a task whose idea the owner dismissed in the window. The
// model is told both; this holds when it rewords one anyway.
export function repeatsPastIdea(
  idea: { title: string; taskId: number | null },
  past: IdeaRow[],
): string | null {
  const same = past.find((p) => sameTitle(p.title, idea.title));
  if (same) {
    return `repeats idea #${same.id} (${outcome(same)})`;
  }
  if (idea.taskId) {
    const dismissed = past.find(
      (p) => p.status === IdeaStatus.dismissed && p.task_id === idea.taskId,
    );
    if (dismissed) {
      return `${store.taskRef(idea.taskId)}'s idea #${dismissed.id} was dismissed`;
    }
  }
  return null;
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
  const past = pastIdeas(at);
  const result = await think({
    prompt: `${picture}\n\nIdeas from the last ${PAST_IDEAS_DAYS} days (and any still open) about open work, with what the owner did with each:\n${pastIdeasBlock(promptIdeas(past))}\n\nToday is ${at.toISOString().slice(0, 10)}.`,
    system: [
      `You are the Advisor in Riker, the owner's work manager. Look at the work and say what is late, slipped, not followed up, or worth bringing up - at most three ideas. Never repeat an idea listed as already said, under any words: one still open is already in the Inbox, one approved is already a task, and one dismissed means the owner does not want it (leave its task alone unless something new happened to it). Fewer is better; zero is fine.`,
      docsBlock(config, { persona: true, job: true, learned: true }),
    ].join("\n\n"),
    schema: IDEAS_SCHEMA,
    model: config.brain.assistantModel,
    spend: { role: SpendRole.advisor },
  });
  const answer = result.structured as IdeasAnswer | null;
  let added = 0;
  for (const idea of answer?.ideas ?? []) {
    const ref = idea.task ? store.parseTaskRef(idea.task) : null;
    const taskId = ref && store.getTask(ref) ? ref : null;
    const why = repeatsPastIdea({ title: idea.title, taskId }, past);
    if (why) {
      log.info("advisor refused an idea", { title: idea.title, why });
      continue;
    }
    past.push(store.addIdea(idea.title, idea.body, taskId));
    added++;
  }
  store.kvSet(LAST_RUN, at.toISOString());
  store.kvSet(LAST_PICTURE, hash);
  return { added };
}
