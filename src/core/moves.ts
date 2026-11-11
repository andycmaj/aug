// Every move the Assistant or an agent can make, in one registry. aug-tools
// reads it for its commands and help, the engine for its dispatch. A move from
// another process goes through the `moves` table: aug-tools inserts it and
// waits, the engine claims it, runs it, and writes back one line of result.

import type { Engine } from "./engine";
import { logger } from "./log";
import { findProject, projectLine } from "./lookup";
import { mux } from "./mux";
import * as projects from "./projects";
import * as store from "./store";
import {
  Kind,
  MoveStatus,
  ProjectStatus,
  SessionKind,
  TaskStatus,
  TurnRole,
  type MoveRow,
  type ProjectRow,
  type TaskRow,
} from "./types";

const log = logger("moves");

export class MoveError extends Error {}

export interface MoveArg {
  help: string;
  required?: boolean;
}

export interface MoveSpec {
  help: string;
  // Acts on one task, named by the `task` arg (AUG-0012).
  task: boolean;
  // The arg aug-tools takes without a flag (after the task, when the move
  // has one).
  positional?: string;
  args: Record<string, MoveArg>;
  run(
    engine: Engine,
    task: TaskRow | null,
    args: Record<string, string>,
    // "you", "assistant", or "agent AUG-0012".
    by: string,
  ): string | Promise<string>;
}

const PRIORITIES = ["urgent", "important", "regular"] as const;

function ref(task: TaskRow | null): string {
  return task ? store.taskRef(task.id) : "";
}

// Kinds a move may make or set; anything else is aug's own.
const KINDS = [Kind.general, Kind.coding, Kind.reply, Kind.task] as const;

function kindNamed(name: string): Kind {
  const kind = KINDS.find((k) => k === name.trim());
  if (!kind)
    throw new MoveError(`kind must be ${KINDS.join(" | ")}: got ${name}`);
  return kind;
}

// A name that matches no project says which ones there are, so the caller
// can pick one or ask the owner whether to make it.
function projectNamed(name: string): ProjectRow {
  const project = findProject(name);
  if (project?.status === ProjectStatus.active) return project;
  const active = store
    .listProjects()
    .filter((p) => p.status === ProjectStatus.active)
    .map((p) => p.name);
  throw new MoveError(
    `no project ${name}${project ? " (it is archived)" : ""}. ${active.length ? `Projects: ${active.join(", ")}.` : "There are no projects."} Make one with project_new.`,
  );
}

function checkRepo(repo: string): string {
  const clean = repo.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(clean))
    throw new MoveError(`${clean || "repo"} is not owner/repo`);
  return clean;
}

// The owner opens a link with the system opener, so only web addresses: a
// file: or app URL an agent attached would run something on a keypress.
function checkUrl(url: string): string {
  const clean = url.trim();
  const parsed = URL.canParse(clean) ? new URL(clean) : null;
  if (parsed?.protocol !== "http:" && parsed?.protocol !== "https:")
    throw new MoveError(`${clean || "url"} is not an http(s) URL`);
  return clean;
}

// A coding start that would open a dialog in the TUI answers in words: the
// caller asks the owner and calls again with what they said.
async function startCoding(
  engine: Engine,
  task: TaskRow,
  args: Record<string, string>,
): Promise<string> {
  if (args.repo) {
    try {
      engine.setTaskRepo(task.id, args.repo);
    } catch (err) {
      throw new MoveError(err instanceof Error ? err.message : String(err));
    }
  }
  // --path answers "needs path". It never moves a repo whose checkout is
  // still there: a path an agent passes may be its own worktree, which goes.
  if (args.repo && args.path) {
    const mapped = projects.repoPath(args.repo.trim());
    if (!mapped || !(await mux().isCheckout(mapped)))
      projects.mapRepo(args.repo.trim(), args.path);
  }
  task = store.getTask(task.id) ?? task;
  const prior = store.latestSession(task.id);
  const resume =
    prior?.kind === SessionKind.pty || prior?.kind === SessionKind.tmux
      ? prior.id
      : undefined;
  const scratch = args.scratch === "yes";
  if (engine.makesWorktrees && !resume && !scratch && !task.worktree) {
    if (!task.repo) {
      const choices = projects.repoChoices(task);
      throw new MoveError(
        `needs repo: which repo is ${ref(task)} in? ${choices.length ? `Known: ${choices.join(", ")}. ` : ""}Pass --repo owner/repo, or --scratch yes for a scratch folder.`,
      );
    }
    if (!projects.repoPath(task.repo))
      throw new MoveError(
        `needs path: where is ${task.repo} checked out? Pass --repo ${task.repo} --path /path/to/checkout, or --scratch yes.`,
      );
  }
  const result = await engine.startCoding(task.id, {
    note: args.note || undefined,
    branch: args.branch?.trim() || undefined,
    noWorktree: scratch,
    resume,
  });
  switch (result.type) {
    case "started":
      return `started ${ref(task)}'s coding agent in project ${result.project.name}`;
    case "needs-repo-path":
      throw new MoveError(
        `needs path: where is ${result.repo} checked out? Pass --repo ${result.repo} --path /path/to/checkout, or --scratch yes.`,
      );
    case "failed":
      throw new MoveError(`could not start ${ref(task)}: ${result.error}`);
  }
}

export const MOVES: Record<string, MoveSpec> = {
  done: {
    help: "Mark the task done",
    task: true,
    args: {},
    run(engine, task) {
      engine.markDone(task!.id);
      return `${ref(task)} marked done`;
    },
  },
  remind: {
    help: "Put the task away until a day: days from now (1 = tomorrow)",
    task: true,
    args: { days: { help: "days from now", required: true } },
    run(engine, task, args) {
      const days = Number(args.days);
      if (!Number.isFinite(days) || days < 1)
        throw new MoveError(`days must be a number from 1: got ${args.days}`);
      const at = engine.remind(task!.id, days);
      return `${ref(task)} back on ${at.slice(0, 10)}`;
    },
  },
  watch: {
    help: "Watch the task: not the owner's, kept open",
    task: true,
    args: {},
    run(engine, task) {
      engine.watch(task!.id, true);
      return `watching ${ref(task)}`;
    },
  },
  unwatch: {
    help: "Stop watching: the task is the owner's again",
    task: true,
    args: {},
    run(engine, task) {
      engine.watch(task!.id, false);
      return `${ref(task)} back in Tasks`;
    },
  },
  start: {
    help: "Start (or continue) the task's agent",
    task: true,
    args: {
      note: { help: "a note for the agent" },
      repo: { help: "coding: the owner/repo to work in" },
      path: { help: "coding: where that repo is checked out" },
      branch: { help: "coding: the branch (new, existing, or pr:N)" },
      scratch: { help: "coding: yes = a scratch folder, no worktree" },
    },
    run(engine, task, args) {
      if (task!.kind === Kind.coding) return startCoding(engine, task!, args);
      engine.startGeneral(task!.id, args.note || undefined);
      return `started ${ref(task)}'s agent`;
    },
  },
  stop: {
    help: "Stop the task's agent and save",
    task: true,
    args: {},
    run(engine, task) {
      engine.stopAgent(task!.id);
      return `stopped ${ref(task)}'s agent`;
    },
  },
  redraft: {
    help: "Ask the task's agent for a different draft",
    task: true,
    args: { instruction: { help: "what to change", required: true } },
    run(engine, task, args) {
      engine.redraft(task!.id, args.instruction);
      return `asked for a redraft on ${ref(task)}`;
    },
  },
  not_a_task: {
    help: "Not a task: drop it and teach triage",
    task: true,
    args: { why: { help: "why it is not a task" } },
    run(engine, task, args) {
      engine.notATask(task!.id, args.why ?? "");
      return `${ref(task)}: not a task`;
    },
  },
  priority: {
    help: "Set the task's priority",
    task: true,
    args: { level: { help: PRIORITIES.join(" | "), required: true } },
    run(engine, task, args) {
      const level = PRIORITIES.find((p) => p === args.level);
      if (!level)
        throw new MoveError(
          `level must be ${PRIORITIES.join(" | ")}: got ${args.level}`,
        );
      engine.setPriority(task!.id, level);
      return `${ref(task)} is ${level}`;
    },
  },
  tell: {
    help: "Type a line into the task's chat for its agent",
    task: true,
    args: { text: { help: "the line", required: true } },
    async run(engine, task, args) {
      return (await engine.say(task!.id, args.text))
        ? `told ${ref(task)}'s agent`
        : `${ref(task)}'s agent is not running: it hears this when it starts`;
    },
  },
  new: {
    help: "Make a task. Say what is to be done in brief; it is the new task's agent's starting point",
    task: false,
    positional: "title",
    args: {
      title: { help: "a short title", required: true },
      kind: { help: `${KINDS.join(" | ")} (default general)` },
      brief: { help: "what is to be done, with what the agent needs to know" },
      project: { help: "the project it belongs to" },
      repo: { help: "coding: owner/repo (default: the project's first repo)" },
      from: { help: "the task this comes out of (AUG-0012); it hears back" },
    },
    run(engine, _task, args, by) {
      const kind = args.kind ? kindNamed(args.kind) : Kind.general;
      const project = args.project ? projectNamed(args.project) : null;
      const repo = args.repo
        ? checkRepo(args.repo)
        : kind === Kind.coding && project
          ? (store.projectRepos(project)[0] ?? null)
          : null;
      const fromId = args.from ? store.parseTaskRef(args.from) : null;
      const from = fromId ? store.getTask(fromId) : null;
      if (args.from && !from) throw new MoveError(`no task ${args.from}`);
      const task = store.batch(() => {
        const made = engine.newTask(args.title.trim(), kind, args.brief?.trim() ?? "", {
          projectId: project?.id ?? null,
          repo,
          fromTaskId: from?.id ?? null,
        });
        store.addTurn({
          taskId: made.id,
          role: TurnRole.trigger,
          body: from
            ? `Made from ${ref(from)} by ${by}`
            : `Made by ${by}`,
        });
        if (from)
          store.addTurn({
            taskId: from.id,
            role: TurnRole.trigger,
            body: `${by} made ${ref(made)} (${kind}${project ? ` in ${project.name}` : ""}): ${made.title}`,
          });
        return made;
      });
      return [
        `${ref(task)} made (${kind}${project ? ` in project ${project.name}` : ""}${repo ? `, repo ${repo}` : ""})`,
        kind === Kind.coding ? `Start its agent with: start ${ref(task)}` : "",
      ]
        .filter(Boolean)
        .join(". ");
    },
  },
  retitle: {
    help: "Give the task a new title",
    task: true,
    args: { title: { help: "the new title", required: true } },
    run(_engine, task, args) {
      store.updateTask(task!.id, { title: args.title.trim() });
      return `${ref(task)} is now: ${args.title.trim()}`;
    },
  },
  brief: {
    help: "Rewrite the task's brief, before its agent starts (after, tell it)",
    task: true,
    args: { text: { help: "the whole new brief", required: true } },
    run(engine, task, args) {
      if (!engine.briefEditable(task!.id))
        throw new MoveError(
          `${ref(task)}'s agent already started from its brief: tell it what changed instead`,
        );
      engine.editBrief(task!.id, args.text);
      return `${ref(task)}'s brief rewritten`;
    },
  },
  kind: {
    help: "Change what kind of work the task is",
    task: true,
    args: { kind: { help: KINDS.join(" | "), required: true } },
    run(engine, task, args) {
      const kind = kindNamed(args.kind);
      engine.setKind(task!.id, kind);
      return `${ref(task)} is ${kind} work`;
    },
  },
  project: {
    help: "Move the task into a project (a running agent's window moves too)",
    task: true,
    args: { project: { help: "the project's name", required: true } },
    async run(engine, task, args) {
      const project = projectNamed(args.project);
      // A task that never started has no window to move or session to wake.
      if (store.latestSession(task!.id)?.kind === SessionKind.tmux)
        await engine.moveTask(task!.id, project.id);
      else store.updateTask(task!.id, { project_id: project.id });
      return `${ref(task)} is in project ${project.name}`;
    },
  },
  wait_on: {
    help: "Mark the task waiting on someone (empty: no longer waiting)",
    task: true,
    args: { who: { help: "who it waits on" } },
    run(engine, task, args) {
      engine.waitOn(task!.id, args.who ?? "");
      return args.who?.trim()
        ? `${ref(task)} waits on ${args.who.trim()}`
        : `${ref(task)} waits on nobody`;
    },
  },
  link: {
    help: "Attach a URL to the task (a doc, a Slack thread, a ticket elsewhere)",
    task: true,
    positional: "url",
    args: {
      url: { help: "the http(s) URL", required: true },
      title: { help: "what it is, in a few words" },
    },
    run(_engine, task, args, by) {
      const link = store.addTaskLink(
        task!.id,
        checkUrl(args.url),
        args.title?.trim() || null,
        by,
      );
      return `linked ${link.title ? `${link.title} (${link.url})` : link.url} to ${ref(task)}`;
    },
  },
  unlink: {
    help: "Take a URL off the task",
    task: true,
    positional: "url",
    args: { url: { help: "the URL, as it was attached", required: true } },
    run(_engine, task, args) {
      const url = args.url.trim();
      if (!store.removeTaskLink(task!.id, url)) {
        const links = store.linksForTask(task!.id).map((l) => l.url);
        throw new MoveError(
          `${ref(task)} has no link ${url}${links.length ? `. Links: ${links.join(", ")}` : ""}`,
        );
      }
      return `unlinked ${url} from ${ref(task)}`;
    },
  },
  project_new: {
    help: "Make a project: a tmux session its coding tasks run in",
    task: false,
    positional: "name",
    args: {
      name: { help: "the project's name", required: true },
      repo: { help: "owner/repo its coding tasks work in" },
    },
    async run(engine, _task, args) {
      const taken = findProject(args.name);
      if (taken?.status === ProjectStatus.active)
        throw new MoveError(`there is already a project ${taken.name}`);
      const repo = args.repo ? checkRepo(args.repo) : null;
      const project = await engine.createProject(args.name.trim(), repo);
      return `made ${projectLine(project)}`;
    },
  },
  project_repo: {
    help: "Add a repo to a project: its coding tasks default to the first",
    task: false,
    positional: "project",
    args: {
      project: { help: "the project's name", required: true },
      repo: { help: "owner/repo", required: true },
    },
    run(_engine, _task, args) {
      const project = projectNamed(args.project);
      store.addProjectRepo(project.id, checkRepo(args.repo));
      return projectLine(store.getProject(project.id) ?? project);
    },
  },
  project_archive: {
    help: "Archive a project: its tmux session and every agent in it end",
    task: false,
    positional: "project",
    args: {
      project: { help: "the project's name", required: true },
      force: { help: "yes = even with open tasks (ask the owner first)" },
    },
    async run(engine, _task, args) {
      const project = projectNamed(args.project);
      const open = store
        .tasksForProject(project.id)
        .filter((t) => t.status === TaskStatus.open || t.status === TaskStatus.later);
      if (open.length && args.force !== "yes")
        throw new MoveError(
          `${project.name} has ${open.length} open task${open.length === 1 ? "" : "s"} (${open.map((t) => ref(t)).join(", ")}); archiving ends their agents. Ask the owner, then pass --force yes.`,
        );
      await engine.archiveProject(project.id);
      return `archived ${project.name}`;
    },
  },
  remember: {
    help: "Write a line the owner said into LEARNED.md",
    task: false,
    args: { line: { help: "the line", required: true } },
    run(engine, _task, args) {
      engine.remember(args.line);
      return "written to LEARNED.md";
    },
  },
};

// What a task's own agent may ask for: new tasks and projects, and small edits
// (and links) to its own task. Starting, stopping and closing work (and archiving a
// project) stay the owner's and the Assistant's.
export const AGENT_MOVES: ReadonlySet<string> = new Set([
  "new",
  "project_new",
  "retitle",
  "project",
  "wait_on",
  "priority",
  "remind",
  "link",
  "unlink",
]);

function agentTask(by: string): number | null {
  return by.startsWith("agent ") ? store.parseTaskRef(by.slice(6)) : null;
}

export interface MoveOutcome {
  ok: boolean;
  result: string;
}

export async function runMove(
  engine: Engine,
  verb: string,
  args: Record<string, string>,
  by = "you",
): Promise<MoveOutcome> {
  const spec = MOVES[verb];
  if (!spec)
    return {
      ok: false,
      result: `no move ${verb}: moves are ${Object.keys(MOVES).join(", ")}`,
    };
  let task: TaskRow | null = null;
  if (spec.task) {
    const id = args.task ? store.parseTaskRef(args.task) : null;
    task = id ? store.getTask(id) : null;
    if (!task)
      return {
        ok: false,
        result: args.task ? `no task ${args.task}` : `${verb} needs --task AUG-0000`,
      };
    if (task.kind === Kind.home)
      return { ok: false, result: `${args.task} is Home, not a task` };
  }
  const own = agentTask(by);
  if (own !== null) {
    if (!AGENT_MOVES.has(verb))
      return { ok: false, result: `${verb} is the owner's move: say what you need under Next steps` };
    if (task && task.id !== own)
      return { ok: false, result: `an agent changes only its own task (${store.taskRef(own)})` };
  }
  const missing = Object.entries(spec.args)
    .filter(([name, arg]) => arg.required && !args[name]?.trim())
    .map(([name]) => `--${name}`);
  if (missing.length)
    return { ok: false, result: `${verb} needs ${missing.join(", ")}` };
  try {
    return { ok: true, result: await spec.run(engine, task, args, by) };
  } catch (err) {
    if (err instanceof MoveError) return { ok: false, result: err.message };
    log.error("move failed", { verb, err });
    return {
      ok: false,
      result: `${verb} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// A move older than this was asked of an aug that wasn't running: it fails
// rather than surprising the owner when aug next starts.
export const MOVE_STALE_MS = 60_000;

export async function drainMoves(engine: Engine, at = Date.now()): Promise<number> {
  let ran = 0;
  for (const move of store.pendingMoves()) {
    if (at - Date.parse(move.created_at) > MOVE_STALE_MS) {
      store.abandonMove(move.id, "expired: aug was not running to make it");
      continue;
    }
    if (!store.claimMove(move.id)) continue;
    const args = JSON.parse(move.args) as Record<string, string>;
    const outcome = await runMove(engine, move.verb, args, move.asked_by);
    log.info("move", {
      id: move.id,
      verb: move.verb,
      by: move.asked_by,
      ok: outcome.ok,
    });
    store.finishMove(move.id, outcome.ok, outcome.result);
    ran++;
  }
  return ran;
}

export interface WaitOptions {
  // How long a pending move may sit before giving up on aug.
  pickupMs?: number;
  // How long a claimed move may run (a coding start makes a worktree).
  runMs?: number;
  pollMs?: number;
}

export async function waitForMove(
  id: number,
  opts: WaitOptions = {},
): Promise<MoveRow> {
  const pickupMs = opts.pickupMs ?? 15_000;
  const runMs = opts.runMs ?? 180_000;
  const pollMs = opts.pollMs ?? 100;
  const start = Date.now();
  for (;;) {
    const move = store.getMove(id);
    if (!move) throw new Error(`move ${id} is gone`);
    if (move.status === MoveStatus.done || move.status === MoveStatus.failed)
      return move;
    const waited = Date.now() - start;
    if (move.status === MoveStatus.pending && waited > pickupMs) {
      if (store.abandonMove(id, "aug did not pick it up: is aug running?"))
        return store.getMove(id)!;
      continue;
    }
    if (waited > pickupMs + runMs)
      return { ...move, status: MoveStatus.failed, result: "still running: check aug" };
    await Bun.sleep(pollMs);
  }
}
