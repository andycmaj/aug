#!/usr/bin/env bun
// What a coding agent (and the Claude Code hooks it fires) calls back into aug
// with. Plain TypeScript: runs under bare `bun`, no Solid preload, so a hook
// costs a process start and one SQLite write.

import { defineCommand, runMain } from "citty";
import { adoptHook, paneEnv } from "../core/adopt";
import {
  formatFeedback,
  linkPr,
  markFeedbackRead,
  unreadFeedback,
} from "../core/feedback";
import { handleDone, handleHook, type HookEnv, type HookPayload } from "../core/hooks";
import { logger } from "../core/log";
import { setMux, socketFromEnv, TmuxMux } from "../core/mux";
import * as store from "../core/store";
import { NoteLabel } from "../core/types";

// Inside a pane, talk to the tmux server the pane lives on.
function usePaneServer(): void {
  const socket = socketFromEnv();
  if (socket) setMux(new TmuxMux(socket));
}

// An aug-launched agent has its ids in env; a claude you started by hand in
// a project window is found through the window's tag.
async function env(): Promise<HookEnv> {
  const taskId = Number(process.env.AUG_TASK_ID);
  const sessionId = process.env.AUG_SESSION_ID ?? "";
  if (taskId && sessionId) return { taskId, sessionId };
  const pane = process.env.TMUX_PANE;
  if (pane) {
    usePaneServer();
    const found = await paneEnv(pane);
    if (found) return found;
  }
  console.error(
    "aug-tools: run this from an aug agent session (AUG_TASK_ID is not set)",
  );
  process.exit(2);
}

async function readPayload(): Promise<HookPayload> {
  try {
    const text = await Bun.stdin.text();
    return text.trim() ? (JSON.parse(text) as HookPayload) : {};
  } catch {
    return {};
  }
}

function author(): string {
  const id = Number(process.env.AUG_TASK_ID);
  return id ? `agent ${store.taskRef(id)}` : "you";
}

const hook = defineCommand({
  meta: { name: "hook", description: "Claude Code hook entry (internal)" },
  args: { event: { type: "positional", required: true } },
  async run({ args }) {
    const payload = await readPayload();
    const taskId = Number(process.env.AUG_TASK_ID);
    const sessionId = process.env.AUG_SESSION_ID;
    // A hook must never break the agent's session: no task, nothing to do.
    if (!taskId || !sessionId) return;
    logger("hook").trace(String(args.event), {
      task: taskId,
      session: sessionId,
    });
    handleHook(String(args.event), payload, { taskId, sessionId });
  },
});

const adopt = defineCommand({
  meta: {
    name: "adopt-hook",
    description: "Claude Code hook for a claude started by hand (internal)",
  },
  args: { event: { type: "positional", required: true } },
  async run({ args }) {
    const payload = await readPayload();
    const pane = process.env.TMUX_PANE;
    if (!pane || process.env.AUG_TASK_ID) return;
    usePaneServer();
    try {
      await adoptHook(String(args.event), payload, pane);
    } catch (err) {
      // A hook must never break the session it rides on.
      logger("hook").warn("adopt failed", { event: String(args.event), err });
    }
  },
});

const done = defineCommand({
  meta: { name: "done", description: "Tell aug this task's work is finished" },
  args: {
    summary: {
      type: "string",
      required: true,
      description: "one line: what you did",
    },
    reply: {
      type: "string",
      description: "words to the person who asked (the owner sends it)",
    },
    close: {
      type: "string",
      description:
        "issue | merge | approve: the close-out riding with the reply",
    },
  },
  async run({ args }) {
    const close =
      args.close === "issue" ||
      args.close === "merge" ||
      args.close === "approve"
        ? args.close
        : undefined;
    console.log(
      handleDone(await env(), {
        summary: args.summary,
        reply: args.reply,
        close,
      }),
    );
  },
});

const pr = defineCommand({
  meta: {
    name: "pr",
    description: "Link a pull request to this task, so its reviews land here",
  },
  args: { url: { type: "positional", required: true } },
  async run({ args }) {
    const { taskId } = await env();
    const key = linkPr(taskId, String(args.url));
    if (!key) {
      console.error(`not a GitHub pull request URL: ${args.url}`);
      process.exit(2);
    }
    console.log(`linked ${key} to ${store.taskRef(taskId)}`);
  },
});

const feedback = defineCommand({
  meta: {
    name: "feedback",
    description: "Reviews, comments and CI on this task's threads since you last looked",
  },
  async run() {
    const { taskId } = await env();
    const messages = unreadFeedback(taskId);
    console.log(formatFeedback(messages));
    markFeedbackRead(taskId, messages);
  },
});

const labels = Object.values(NoteLabel) as string[];

const note = defineCommand({
  meta: {
    name: "note",
    description: "Leave a live handoff note for other agents",
  },
  args: {
    body: { type: "positional", required: true },
    label: { type: "string", default: "note", description: labels.join(" | ") },
  },
  run({ args }) {
    const label = (
      labels.includes(args.label) ? args.label : "note"
    ) as NoteLabel;
    const taskId = Number(process.env.AUG_TASK_ID) || null;
    store.addNote(author(), label, String(args.body), taskId);
    console.log("posted");
  },
});

const notes = defineCommand({
  meta: { name: "notes", description: "Read the live handoff board" },
  run() {
    const reader = author();
    for (const n of store.listNotes(30).reverse()) {
      console.log(
        `${n.created_at.slice(0, 16)} ${n.author} [${n.label}] ${n.body}`,
      );
    }
    store.markNotesRead(reader);
  },
});

const hubAdd = defineCommand({
  meta: { name: "add", description: "Add a durable discovery to the Hub" },
  args: {
    body: { type: "positional", required: true },
    topic: { type: "string", required: true },
    title: { type: "string", required: true },
  },
  run({ args }) {
    const row = store.addHub(
      args.topic,
      args.title,
      String(args.body),
      author(),
    );
    console.log(`hub #${row.id} under ${row.topic}`);
  },
});

const hubSearch = defineCommand({
  meta: { name: "search", description: "Search the Hub" },
  args: { query: { type: "positional", required: true } },
  run({ args }) {
    const words = String(args.query).toLowerCase().split(/\s+/).filter(Boolean);
    const hits = store
      .listHub()
      .filter((h) =>
        words.every((w) =>
          `${h.topic} ${h.title} ${h.body}`.toLowerCase().includes(w),
        ),
      );
    for (const h of hits)
      console.log(
        `#${h.id} [${h.topic}] ${h.title}\n  ${h.body.replace(/\n/g, "\n  ")}`,
      );
    if (hits.length === 0) console.log("nothing in the Hub matches");
  },
});

const hubList = defineCommand({
  meta: { name: "list", description: "List Hub topics and entries" },
  run() {
    for (const h of store.listHub())
      console.log(`#${h.id} [${h.topic}] ${h.title} (${h.author})`);
  },
});

const main = defineCommand({
  meta: { name: "aug-tools", description: "aug's callback tools for agents" },
  subCommands: {
    hook,
    "adopt-hook": adopt,
    done,
    pr,
    feedback,
    note,
    notes,
    hub: defineCommand({
      meta: {
        name: "hub",
        description: "The Hub: what agents learned, by topic",
      },
      subCommands: { add: hubAdd, search: hubSearch, list: hubList },
    }),
  },
});

await runMain(main);
