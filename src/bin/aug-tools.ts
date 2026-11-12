#!/usr/bin/env bun
// What a coding agent (and the Claude Code hooks it fires) calls back into aug
// with. Plain TypeScript: runs under bare `bun`, no Solid preload, so a hook
// costs a process start and one SQLite write.

import { defineCommand, runMain, type ArgsDef } from "citty";
import { adoptHook, paneEnv } from "../core/adopt";
import {
  formatFeedback,
  linkPr,
  markFeedbackRead,
  unreadFeedback,
} from "../core/feedback";
import { handleDone, handleHook, type HookEnv, type HookPayload } from "../core/hooks";
import { logger } from "../core/log";
import {
  findProject,
  findTasks,
  projectDetail,
  projectLine,
  statusLine,
  taskDetail,
  taskLine,
} from "../core/lookup";
import { MOVES, waitForMove } from "../core/moves";
import { mux, setMux, socketFromEnv, TmuxMux } from "../core/mux";
import { runInPane } from "../core/pane";
import * as projects from "../core/projects";
import * as store from "../core/store";
import { MoveStatus, NoteLabel } from "../core/types";

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

// A hook must never break the agent's session: when tmux cannot say, the
// end stands.
async function endedElsewhere(sessionId: string): Promise<boolean> {
  const pane = process.env.TMUX_PANE;
  if (!pane) return false;
  usePaneServer();
  try {
    return await projects.endedElsewhere(sessionId, pane);
  } catch {
    return false;
  }
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
  if (process.env.AUG_ASKED_BY) return process.env.AUG_ASKED_BY;
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
    if (args.event === "end" && (await endedElsewhere(sessionId))) {
      logger("hook").debug("end from a window the session left", {
        task: taskId,
        session: sessionId,
      });
      return;
    }
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

const knowledgeAdd = defineCommand({
  meta: { name: "add", description: "Add a durable discovery to Knowledge" },
  args: {
    body: { type: "positional", required: true },
    topic: { type: "string", required: true },
    title: { type: "string", required: true },
  },
  run({ args }) {
    const row = store.addKnowledge(
      args.topic,
      args.title,
      String(args.body),
      author(),
    );
    console.log(`knowledge #${row.id} under ${row.topic}`);
  },
});

const knowledgeSearch = defineCommand({
  meta: { name: "search", description: "Search Knowledge" },
  args: { query: { type: "positional", required: true } },
  run({ args }) {
    const words = String(args.query).toLowerCase().split(/\s+/).filter(Boolean);
    const hits = store
      .listKnowledge()
      .filter((h) =>
        words.every((w) =>
          `${h.topic} ${h.title} ${h.body}`.toLowerCase().includes(w),
        ),
      );
    for (const h of hits)
      console.log(
        `#${h.id} [${h.topic}] ${h.title}\n  ${h.body.replace(/\n/g, "\n  ")}`,
      );
    if (hits.length === 0) console.log("nothing in Knowledge matches");
  },
});

const knowledgeList = defineCommand({
  meta: { name: "list", description: "List Knowledge topics and entries" },
  run() {
    for (const h of store.listKnowledge())
      console.log(`#${h.id} [${h.topic}] ${h.title} (${h.author})`);
  },
});

const knowledge = defineCommand({
  meta: { name: "knowledge", description: "What agents learned, by topic" },
  subCommands: {
    add: knowledgeAdd,
    search: knowledgeSearch,
    list: knowledgeList,
  },
});

// ── looking things up ────────────────────────────────────────────────────

const tasks = defineCommand({
  meta: { name: "tasks", description: "List open tasks (and For later)" },
  args: {
    query: { type: "positional", required: false, description: "words to match" },
    all: { type: "boolean", description: "include done and closed" },
    project: { type: "string", description: "only this project's tasks" },
  },
  run({ args }) {
    const found = findTasks({
      all: args.all,
      project: args.project,
      query: args.query ? String(args.query) : undefined,
    });
    for (const t of found) console.log(taskLine(t));
    if (found.length === 0) console.log("no tasks match");
  },
});

const task = defineCommand({
  meta: { name: "task", description: "Show one task and its recent chat" },
  args: { ref: { type: "positional", required: true, description: "AUG-0012" } },
  run({ args }) {
    const id = store.parseTaskRef(String(args.ref));
    const row = id ? store.getTask(id) : null;
    if (!row) {
      console.error(`no task ${args.ref}`);
      process.exit(1);
    }
    console.log(taskDetail(row));
  },
});

const projectsList = defineCommand({
  meta: { name: "projects", description: "List projects and their repos" },
  args: { all: { type: "boolean", description: "include archived" } },
  run({ args }) {
    const rows = store
      .listProjects()
      .filter((p) => args.all || p.status === "active");
    for (const p of rows) console.log(projectLine(p));
    if (rows.length === 0) console.log("no projects");
  },
});

// Claude Code runs the status line command inside the agent's process, so
// it has the agent's env; a claude started by hand is found by its window's
// tag. Outside aug it prints nothing, which hides a prompt module.
const statusline = defineCommand({
  meta: {
    name: "statusline",
    description: "Print this session's task (ref, title, priority) for a status line",
  },
  async run() {
    let taskId = Number(process.env.AUG_TASK_ID);
    const pane = process.env.TMUX_PANE;
    if (!taskId && pane) {
      usePaneServer();
      taskId = (await mux().paneInfo(pane).catch(() => null))?.taskId ?? 0;
    }
    const row = taskId ? store.getTask(taskId) : null;
    if (row) console.log(statusLine(row));
  },
});

const projectShow = defineCommand({
  meta: {
    name: "project",
    description: "Show one project: its brief, goals and progress, docs, open work",
  },
  args: { name: { type: "positional", required: true, description: "the project's name" } },
  run({ args }) {
    const row = findProject(String(args.name));
    if (!row) {
      console.error(`no project ${args.name}`);
      process.exit(1);
    }
    console.log(projectDetail(row));
  },
});

// A diff viewer (revdiff) an agent opens goes here, so it shows in the task's
// own window instead of a window of its own.
const pane = defineCommand({
  meta: {
    name: "pane",
    description: "Run a command in a split of this tmux window: aug-tools pane [--zoom] [--wait] -- <command...>",
  },
  args: {
    zoom: { type: "boolean", description: "fill the window until the command exits" },
    wait: { type: "boolean", description: "block until it exits, and exit with its code" },
    cwd: { type: "string", description: "start directory (default: here)" },
  },
  async run({ args }) {
    const argv = args._.map(String);
    const paneId = process.env.TMUX_PANE;
    if (!paneId) {
      console.error("aug-tools pane: not inside tmux (TMUX_PANE is not set)");
      process.exit(2);
    }
    if (argv.length === 0) {
      console.error("aug-tools pane: no command (aug-tools pane -- <command...>)");
      process.exit(2);
    }
    usePaneServer();
    const result = await runInPane({
      paneId,
      cwd: args.cwd ?? process.cwd(),
      argv,
      zoom: Boolean(args.zoom),
      wait: Boolean(args.wait),
    });
    if (result.exitCode === null) console.log(result.paneId);
    else process.exit(result.exitCode);
  },
});

// ── moves: asked here, made by the running aug ───────────────────────────

function moveCommand(verb: string) {
  const spec = MOVES[verb];
  const args: ArgsDef = {};
  if (spec.task)
    args.task = { type: "positional", required: true, description: "AUG-0012" };
  for (const [name, arg] of Object.entries(spec.args))
    args[name] =
      name === spec.positional
        ? { type: "positional", required: arg.required, description: arg.help }
        : { type: "string", required: arg.required, description: arg.help };
  return defineCommand({
    meta: { name: verb, description: spec.help },
    args,
    async run({ args: given }) {
      const values: Record<string, string> = {};
      for (const name of Object.keys(args)) {
        const value = given[name];
        if (value !== undefined && value !== "") values[name] = String(value);
      }
      const move = store.enqueueMove(verb, values, author());
      const row = await waitForMove(move.id);
      if (row.status === MoveStatus.done) console.log(row.result);
      else {
        console.error(row.result);
        process.exit(1);
      }
    },
  });
}

const move = defineCommand({
  meta: {
    name: "move",
    description: "Ask the running aug to make a move (done, remind, start...)",
  },
  subCommands: Object.fromEntries(
    Object.keys(MOVES).map((verb) => [verb, moveCommand(verb)]),
  ),
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
    tasks,
    task,
    projects: projectsList,
    project: projectShow,
    statusline,
    pane,
    move,
    knowledge,
    // The old name: briefs and sessions from before the rename still call it.
    hub: knowledge,
  },
});

await runMain(main);
