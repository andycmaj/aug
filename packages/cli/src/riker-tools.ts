#!/usr/bin/env bun
// What a coding agent (and the Claude Code hooks it fires) calls back into Riker
// with. Plain TypeScript: runs under bare `bun`, no Solid preload, so a hook
// costs a process start and one SQLite write.

import { defineCommand, runMain, type ArgsDef } from "citty";
import { envVar } from "@riker/core/brand";
import { adoptHook, paneEnv } from "@riker/core/adopt";
import {
  formatFeedback,
  linkPr,
  markFeedbackRead,
  unreadFeedback,
} from "@riker/core/feedback";
import { repeated } from "@riker/core/digests";
import { handleDone, handleHook, type HookEnv, type HookPayload } from "@riker/core/hooks";
import { loadConfig } from "@riker/core/config";
import { Drafts } from "@riker/core/outbound";
import { rikerPlugins } from "@riker/tui/plugins";
import { configureLog, logger } from "@riker/core/log";
import {
  findProject,
  findTasks,
  projectDetail,
  projectLine,
  statusLine,
  taskDetail,
  taskLine,
} from "@riker/core/lookup";
import { MOVES, waitForMove } from "@riker/core/moves";
import { mux, setMux, socketFromEnv, TmuxMux } from "@riker/core/mux";
import { runInPane } from "@riker/core/pane";
import { flushPerf, perfReport, perfText, startPerf, timing } from "@riker/core/perf";
import * as projects from "@riker/core/projects";
import { repoReport, reportText } from "@riker/core/repos";
import { reportLines, spendReport } from "@riker/core/spend";
import * as store from "@riker/core/store";
import { lastingEntry, setToolsEntry } from "@riker/core/self";
import { MoveStatus, NoteLabel } from "@riker/core/types";
import { defaultHome, homeUnmoved, legacyHome } from "@riker/core/paths";
import { fileURLToPath } from "node:url";

// Run on its own (hooks, agents), riker-tools is its own entry.
setToolsEntry(lastingEntry(fileURLToPath(import.meta.url)));

// Before riker first starts after the rename, ~/.aug is still aug's: writing
// would make an empty ~/.riker that the move then refuses to overwrite.
if (homeUnmoved()) {
  console.error(`riker-tools: ${legacyHome()} has not moved to ${defaultHome()} yet; start riker once to move it`);
  process.exit(1);
}

// A hook is one short process: config.json is read when a line is logged,
// not on every start.
configureLog(() => loadConfig().log);

// A hook's whole life, process start included, is what it costs the agent
// that waits on it: riker-tools.<command> (and the verb, for a move).
startPerf({ proc: "riker-tools" });
process.on("exit", () => {
  const [cmd, sub] = process.argv.slice(2);
  if (!cmd || cmd.startsWith("-")) return;
  const op = cmd === "move" && sub && !sub.startsWith("-") ? `${cmd}.${sub}` : cmd;
  timing(`riker-tools.${op}`, performance.now());
  flushPerf();
});

// Inside a pane, talk to the tmux server the pane lives on; without $TMUX,
// the one config names.
function usePaneServer(): void {
  setMux(new TmuxMux(socketFromEnv() ?? loadConfig().tmuxSocket));
}

// A riker-launched agent has its ids in env; a claude you started by hand in
// a project window is found through the window's tag.
async function env(): Promise<HookEnv> {
  const taskId = Number(envVar("TASK_ID"));
  const sessionId = envVar("SESSION_ID") ?? "";
  if (taskId && sessionId) return { taskId, sessionId };
  const pane = process.env.TMUX_PANE;
  if (pane) {
    usePaneServer();
    const found = await paneEnv(pane);
    if (found) return found;
  }
  console.error(
    "riker-tools: run this from a riker agent session (RIKER_TASK_ID is not set)",
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
  const asked = envVar("ASKED_BY");
  if (asked) return asked;
  const id = Number(envVar("TASK_ID"));
  return id ? `agent ${store.taskRef(id)}` : "you";
}

const hook = defineCommand({
  meta: { name: "hook", description: "Claude Code hook entry (internal)" },
  args: { event: { type: "positional", required: true } },
  async run({ args }) {
    const payload = await readPayload();
    const taskId = Number(envVar("TASK_ID"));
    const sessionId = envVar("SESSION_ID");
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
    if (!pane || envVar("TASK_ID")) return;
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
  meta: { name: "done", description: "Tell riker this task's work is finished" },
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
    // The session's digest (the project journal, the task's story). Each
    // may be given more than once, one item each.
    goal: { type: "string", description: "a goal of the task, as it stands now" },
    did: { type: "string", description: "what changed, result first (default: --summary)" },
    decision: { type: "string", description: "a choice made, and why" },
    learned: {
      type: "string",
      description: "a surprise, gotcha or thing to do differently; 'knowledge:<topic>: ...' also files it in Knowledge",
    },
    next: { type: "string", description: "a next step" },
    blocked: { type: "string", description: "what waits on whom" },
    question: { type: "string", description: "an open question for the owner" },
    outcome: { type: "string", description: "ready | blocked | waiting | stopped (default ready)" },
  },
  async run({ args, rawArgs }) {
    const close =
      args.close === "issue" ||
      args.close === "merge" ||
      args.close === "approve"
        ? args.close
        : undefined;
    const many = (name: string) => repeated(rawArgs, name);
    console.log(
      handleDone(
        await env(),
        {
          summary: args.summary,
          reply: args.reply,
          close,
          digest: {
            goal: many("goal"),
            did: many("did"),
            decision: many("decision"),
            learned: many("learned"),
            next: many("next"),
            blocked: many("blocked"),
            question: many("question"),
            outcome: typeof args.outcome === "string" ? args.outcome : undefined,
          },
        },
        Drafts.of(rikerPlugins()),
        loadConfig(),
      ),
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
    const taskId = Number(envVar("TASK_ID")) || null;
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
  args: { ref: { type: "positional", required: true, description: "RIKER-0012" } },
  run({ args }) {
    const id = store.parseTaskRef(String(args.ref));
    const row = id ? store.getTask(id) : null;
    if (!row) {
      console.error(`no task ${args.ref}`);
      process.exit(1);
    }
    console.log(taskDetail(row, 12, loadConfig()));
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

const reposList = defineCommand({
  meta: {
    name: "repos",
    description: "Repos Riker knows, where each is checked out and whether that checkout is good, and checkouts on disk it has no path for",
  },
  args: { scan: { type: "boolean", description: "look on disk again now" } },
  async run({ args }) {
    console.log(reportText(await repoReport(loadConfig(), Boolean(args.scan))));
  },
});

// Claude Code runs the status line command inside the agent's process, so
// it has the agent's env; a claude started by hand is found by its window's
// tag. Outside Riker it prints nothing, which hides a prompt module.
const statusline = defineCommand({
  meta: {
    name: "statusline",
    description: "Print this session's task (ref, title, priority) for a status line",
  },
  async run() {
    let taskId = Number(envVar("TASK_ID"));
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
    console.log(projectDetail(row, loadConfig()));
  },
});

// A diff viewer (revdiff) an agent opens goes here, so it shows in the task's
// own window instead of a window of its own.
const pane = defineCommand({
  meta: {
    name: "pane",
    description: "Run a command in a split of this tmux window: riker-tools pane [--zoom] [--wait] -- <command...>",
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
      console.error("riker-tools pane: not inside tmux (TMUX_PANE is not set)");
      process.exit(2);
    }
    if (argv.length === 0) {
      console.error("riker-tools pane: no command (riker-tools pane -- <command...>)");
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

// ── moves: asked here, made by the running Riker ───────────────────────────

function moveCommand(verb: string) {
  const spec = MOVES[verb];
  const args: ArgsDef = {};
  if (spec.task)
    args.task = { type: "positional", required: true, description: "RIKER-0012" };
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
    description: "Ask the running riker to make a move (done, remind, start...)",
  },
  subCommands: Object.fromEntries(
    Object.keys(MOVES).map((verb) => [verb, moveCommand(verb)]),
  ),
});

const perf = defineCommand({
  meta: {
    name: "perf",
    description: "Timings from real use: p50/p95/max per op and the slowest examples",
  },
  args: {
    hours: { type: "string", description: "Window, in hours back from now (default 24)" },
    op: { type: "string", description: "Only ops starting with this (mux., read., engine.)" },
    slowest: { type: "string", description: "How many slow examples to list (default 15)" },
  },
  run({ args }) {
    const hours = Number(args.hours ?? 24) || 24;
    const until = new Date();
    const since = new Date(until.getTime() - hours * 3600_000);
    console.log(
      perfText(
        perfReport({ since, until, op: args.op, slowest: Number(args.slowest ?? 15) || 15 }),
      ),
    );
  },
});

const spend = defineCommand({
  meta: {
    name: "spend",
    description: "What Riker's model calls cost: today by role and task, the last week, the daily cap",
  },
  run() {
    console.log(reportLines(spendReport(loadConfig())).join("\n"));
  },
});

const main = defineCommand({
  meta: { name: "riker-tools", description: "Riker's callback tools for agents" },
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
    repos: reposList,
    project: projectShow,
    statusline,
    pane,
    move,
    knowledge,
    perf,
    spend,
    // The old name: briefs and sessions from before the rename still call it.
    hub: knowledge,
  },
});

await runMain(main);
