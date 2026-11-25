// Every move the Assistant or an agent can make, in one registry. riker-tools
// reads it for its commands and help, the desk for its dispatch, which
// runs each on its desk. A move from
// another process goes through the `moves` table: riker-tools inserts it and
// waits, the desk claims it, runs it, and writes back one line of result.

import { readFileSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { NoiseRule } from "./config";
import type { Desk } from "./desk";
import { SwitchValue } from "./digests";
import { DocName, head } from "./docs";
import { docNamed, propose } from "./proposals";
import { logger } from "./log";
import {
  describeRule,
  parseAt,
  parseIn,
  parseTimerRef,
  TimerError,
  timerLine,
  timerRef,
} from "./timers";
import { findProject, projectLine } from "./lookup";
import { unmergedPr } from "./pr";
import { actionNamed, actionsFor, ActionVia } from "./task-actions";
import { mux } from "./mux";
import { docDraftsDir } from "./paths";
import * as repos from "./repos";
import * as store from "./store";
import { matchStray, strayLabel, strayRef, type Stray } from "./strays";
import {
  GoalStatus,
  Kind,
  MoveStatus,
  ProjectStatus,
  ProposalSource,
  TaskStatus,
  TurnRole,
  type GoalRow,
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
  // Acts on one task, named by the `task` arg (RIKER-0012).
  task: boolean;
  // The arg riker-tools takes without a flag (after the task, when the move
  // has one).
  positional?: string;
  args: Record<string, MoveArg>;
  run(
    desk: Desk,
    task: TaskRow | null,
    args: Record<string, string>,
    // "you", "assistant", or "agent RIKER-0012".
    by: string,
  ): string | Promise<string>;
}

const PRIORITIES = ["urgent", "important", "regular"] as const;

function ref(task: TaskRow | null): string {
  return task ? store.taskRef(task.id) : "";
}

// Another task named in an argument (--on RIKER-0012).
function taskArg(value: string): number {
  const id = store.parseTaskRef(value);
  if (!id || !store.getTask(id)) throw new MoveError(`no task ${value}`);
  return id;
}

function remindDays(value: string): number {
  const days = Number(value);
  if (!Number.isFinite(days) || days < 1)
    throw new MoveError(`days must be a number from 1: got ${value}`);
  return days;
}

// A timer's words (a rule, a time) that do not parse are the caller's to fix.
function timerArg<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof TimerError) throw new MoveError(err.message);
    throw err;
  }
}

// Kinds a move may make or set; anything else is Riker's own.
const KINDS = [Kind.general, Kind.coding, Kind.reply, Kind.task] as const;

function kindNamed(name: string): Kind {
  const kind = KINDS.find((k) => k === name.trim());
  if (!kind)
    throw new MoveError(`kind must be ${KINDS.join(" | ")}: got ${name}`);
  return kind;
}

// A noise rule from a move's args. Each regex compiles before it is saved,
// so a typo is answered now rather than skipped at triage time.
function noiseRule(args: Record<string, string>): NoiseRule {
  const rule: NoiseRule = { reason: args.reason.trim() };
  for (const field of ["author", "title", "body"] as const) {
    const pattern = args[field]?.trim();
    if (!pattern) continue;
    try {
      new RegExp(pattern, "i");
    } catch {
      throw new MoveError(`--${field} is not a regex: ${pattern}`);
    }
    rule[field] = pattern;
  }
  const channel = args.channel?.trim();
  if (channel) {
    if (channel !== "github" && channel !== "slack")
      throw new MoveError(`channel must be github | slack: got ${channel}`);
    rule.channel = channel;
  }
  const reasons = (args.github_reason ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  if (reasons.length) rule.githubReason = reasons;
  if (!rule.author && !rule.title && !rule.body && !rule.githubReason)
    throw new MoveError(
      "noise needs a pattern: --author, --title, --body or --github_reason",
    );
  return rule;
}

// Text the Assistant wrote to a file: a doc for propose_doc, a brief. It
// cannot always ride on the Bash line: Claude Code denies a command with a
// line starting with # in a quoted argument, which is every Markdown
// heading. Only files in the docDrafts folder, so the move cannot be pointed
// at any file on disk.
function docDraftFile(given: string): string {
  const dir = docDraftsDir();
  let file: string;
  try {
    file = realpathSync(isAbsolute(given) ? given : join(dir, given));
  } catch {
    throw new MoveError(`no such file: ${given} (write it to ${dir} first)`);
  }
  const rel = relative(dir, file);
  if (!rel || rel.startsWith("..") || isAbsolute(rel))
    throw new MoveError(`the file must be in ${dir}: got ${given}`);
  return file;
}

// A brief given inline or as a draft file; null when neither was. The file
// goes once the move has made it (drop), so a refused move keeps the draft
// to call again with. Line breaks are kept: they make a brief readable
// (BRIEF_STYLE).
function briefText(
  args: Record<string, string>,
  inline: string,
): { text: string | null; drop(): void } {
  const given = args[inline]?.trim() ? args[inline] : null;
  if (given !== null && args.file?.trim())
    throw new MoveError(`give --${inline} or --file, not both`);
  if (!args.file?.trim()) return { text: given, drop() {} };
  const file = docDraftFile(args.file.trim());
  const text = readFileSync(file, "utf8");
  if (!text.trim()) throw new MoveError("the brief file is empty");
  return { text, drop: () => rmSync(file, { force: true }) };
}

// How the Assistant writes a brief. Whitespace over symbols: a newline
// costs what a space does, a Markdown marker is a token more. Only in the
// Assistant's prompt, which makes most briefs: in a coding brief it would
// ride every request of every session.
export const BRIEF_STYLE =
  "Write a brief as short plain paragraphs, a blank line between, each under its label on its own line: What to change, Where, Why, Constraints, Related, Owner's words (skip empty ones). No bullets, bold, tables, headings or (1) markers.";

// A name that matches no project says which ones there are, so the caller
// can pick one or ask the owner whether to make it.
function switchValue(v: string | undefined): SwitchValue {
  const known = Object.values(SwitchValue) as string[];
  const to = v?.trim().toLowerCase() ?? "";
  if (!known.includes(to)) throw new MoveError(`say on, off or default, not ${v ?? "nothing"}`);
  return to as SwitchValue;
}

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

// A goal by its ref (G3), in the project when one is named.
function goalNamed(ref: string, project?: ProjectRow | null): GoalRow {
  const id = store.parseGoalRef(ref);
  const goal = id ? store.getGoal(id) : null;
  if (goal && (!project || goal.project_id === project.id)) return goal;
  const where = project ?? (goal ? store.getProject(goal.project_id) : null);
  const goals = where ? store.goalsForProject(where.id) : [];
  throw new MoveError(
    `no goal ${ref}${project ? ` in ${project.name}` : ""}.${goals.length ? ` Goals: ${goals.map((g) => `${store.goalRef(g.id)} ${g.title}`).join("; ")}.` : ""}`,
  );
}

const GOAL_STATUSES = [GoalStatus.open, GoalStatus.met, GoalStatus.dropped] as const;

function checkRepo(repo: string): string {
  try {
    return repos.checkRepo(repo);
  } catch (err) {
    throw new MoveError(err instanceof Error ? err.message : String(err));
  }
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

// --path, --clone, --rename and --anyway answer "needs path". --path never
// moves a repo whose checkout is still good: a path an agent passes may be
// its own worktree, which goes.
async function answerPath(desk: Desk, repo: string, args: Record<string, string>): Promise<void> {
  try {
    if (args.rename) {
      desk.renameRepo(repo, args.rename);
      return;
    }
    if (args.clone === "yes") {
      if (repos.checkMapped(desk.config(), repo)) await desk.cloneRepo(repo);
      return;
    }
    if (args.path && repos.checkMapped(desk.config(), repo)) desk.mapRepo(repo, args.path);
    const path = repos.repoPath(desk.config(), repo);
    if (args.anyway === "yes" && path) desk.allowMismatch(repo, path);
  } catch (err) {
    throw new MoveError(err instanceof Error ? err.message : String(err));
  }
}

function pathWords(need: repos.PathNeed): string {
  const { repo, problem } = need;
  const found = need.candidates.map(
    (c) => `${repos.tildePath(c.path)}${c.guess ? " (folder name only, no GitHub remote)" : ""}`,
  );
  const fix = repos.problemFix(problem);
  const options = [
    problem.kind === "mismatch" &&
      `--rename ${problem.remotes[0]} to call the repo that everywhere, or --anyway yes to use it as is`,
    fix && `--path ${repos.tildePath(fix)}`,
    `--path /path/to/checkout`,
    `--clone yes (to ${repos.tildePath(need.clone)})`,
    `--scratch yes`,
  ].filter(Boolean);
  return [
    `needs path: ${repos.describeProblem(repo, problem)}.`,
    found.length ? `Found on disk: ${found.join(", ")}.` : "",
    `Ask the owner, then pass --repo ${repo} with ${options.join("; ")}.`,
  ]
    .filter(Boolean)
    .join(" ");
}

// A start that would open a dialog in the TUI answers in words: the caller
// asks the owner and calls again with what they said. The branch question
// is the TUI's; a move takes the suggested one.
async function start(
  desk: Desk,
  task: TaskRow,
  args: Record<string, string>,
): Promise<string> {
  if (args.repo) desk.setTaskRepo(task.id, checkRepo(args.repo));
  const repo = store.getTask(task.id)?.repo ?? null;
  if (repo) await answerPath(desk, repo, args);
  const opts = {
    note: args.note || undefined,
    branch: args.branch?.trim() || undefined,
    noWorktree: args.scratch === "yes",
  };
  let result = await desk.startAgent(task.id, opts);
  if (result.type === "needs" && result.need.what === "branch")
    result = await desk.startAgent(task.id, { ...opts, branch: result.need.suggested });
  switch (result.type) {
    case "started":
      return result.project
        ? `started ${ref(task)}'s coding agent in project ${result.project.name}`
        : `started ${ref(task)}'s agent`;
    case "queued":
      return `${ref(task)} is ${result.reason}: it starts by itself when one finishes`;
    case "needs":
      switch (result.need.what) {
        case "repo":
          throw new MoveError(
            `needs repo: which repo is ${ref(task)} in? ${result.need.choices.length ? `Known: ${result.need.choices.join(", ")}. ` : ""}Pass --repo owner/repo, or --scratch yes for a scratch folder.`,
          );
        case "path":
          throw new MoveError(pathWords(result.need));
        case "branch":
          throw new MoveError(`needs branch: pass --branch`);
      }
    // falls through: the switch above always throws
    case "failed":
      throw new MoveError(`could not start ${ref(task)}: ${result.error}`);
  }
}

export const MOVES: Record<string, MoveSpec> = {
  done: {
    help: "Mark the task done",
    task: true,
    args: {},
    // The owner's d asks first when the PR is not merged; the Assistant
    // moves on the owner's words, so it closes and says so for them to hear.
    async run(desk, task) {
      const unmerged = unmergedPr(task!);
      const r = await desk.close(task!.id);
      const warnings = [...(unmerged ? [`${unmerged}; reopen undoes it`] : []), ...r.warnings];
      return warnings.length
        ? `${ref(task)} marked done; ${warnings.join("; ")}`
        : `${ref(task)} marked done`;
    },
  },
  remind: {
    help: "Put the task away until a day: days from now (1 = tomorrow)",
    task: true,
    args: { days: { help: "days from now", required: true } },
    run(desk, task, args) {
      const at = desk.remind(task!.id, remindDays(args.days));
      return `${ref(task)} back on ${at.slice(0, 10)}`;
    },
  },
  followup: {
    help: "Wake the task's agent at a time, once, with what to do then (check a PR again tomorrow and report)",
    task: true,
    args: {
      in: { help: "how long from now: 30m, 3h, 1d, 2w" },
      at: { help: "or when: an ISO date and time (2026-11-24T09:00)" },
      note: { help: "what to do when it comes due", required: true },
    },
    run(desk, task, args) {
      if (!args.in?.trim() === !args.at?.trim())
        throw new MoveError("followup needs --in or --at, not both");
      const at = timerArg(() =>
        args.in?.trim() ? parseIn(args.in, new Date()) : parseAt(args.at!, new Date()),
      );
      const timer = desk.followup(task!.id, at, args.note);
      return `${timerRef(timer.id)}: ${ref(task)} ${timerLine(timer, new Date())}`;
    },
  },
  schedule: {
    help: "Wake a task on a rule, every time it comes round: daily, weekdays or day names, and a time (\"weekdays 09:00\", \"mon,thu 14:30\"). --task puts it on a task; --brief makes a task for it",
    task: false,
    positional: "rule",
    args: {
      rule: { help: "days and a local time: daily 7am, weekdays 09:00, mon,thu 14:30", required: true },
      task: { help: "the task it wakes (RIKER-0012)" },
      brief: { help: "or what to do each time: a new task is made for it" },
      title: { help: "with --brief: the new task's title" },
      project: { help: "with --brief: the project it belongs to" },
      note: { help: "what to do each time (default: the brief)" },
    },
    run(desk, _task, args, by) {
      if (!args.task?.trim() === !args.brief?.trim())
        throw new MoveError("schedule needs --task or --brief, not both");
      const rule = timerArg(() => describeRule(args.rule));
      let task = args.task?.trim() ? store.getTask(taskArg(args.task)) : null;
      if (task?.kind === Kind.home) throw new MoveError(`${args.task} is Home, not a task`);
      if (!task) {
        const brief = args.brief.trim();
        const project = args.project ? projectNamed(args.project) : null;
        task = store.batch(() => {
          const made = desk.newTask(args.title?.trim() || head(brief, 60), Kind.general, brief, {
            projectId: project?.id ?? null,
          });
          store.addTurn({ taskId: made.id, role: TurnRole.trigger, body: `Made by ${by} to run ${rule}` });
          return made;
        });
      }
      const timer = timerArg(() =>
        desk.schedule(task.id, args.rule, args.note?.trim() || (args.brief?.trim() ?? "")),
      );
      return `${timerRef(timer.id)}: ${ref(task)} ${timerLine(timer, new Date())}`;
    },
  },
  unschedule: {
    help: "Cancel the task's follow-ups and schedules, or one (--timer T3)",
    task: true,
    args: { timer: { help: "the one to cancel (T3); default all of them" } },
    run(desk, task, args) {
      const id = args.timer?.trim() ? parseTimerRef(args.timer) : undefined;
      if (id === null) throw new MoveError(`no timer ${args.timer}: timers are T3`);
      const gone = desk.unschedule(task!.id, id);
      if (gone.length === 0)
        throw new MoveError(
          `${ref(task)} has no ${id ? `timer ${timerRef(id)}` : "follow-ups or schedules"}`,
        );
      return `cancelled ${gone.map((t) => timerRef(t.id)).join(", ")} on ${ref(task)}`;
    },
  },
  watch: {
    help: "Watch the task: not the owner's, kept open",
    task: true,
    args: {},
    run(desk, task) {
      desk.watch(task!.id, true);
      return `watching ${ref(task)}`;
    },
  },
  unwatch: {
    help: "Stop watching: the task is the owner's again",
    task: true,
    args: {},
    run(desk, task) {
      desk.watch(task!.id, false);
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
      clone: { help: "coding: yes = gh repo clone it into the first repo root" },
      rename: { help: "coding: the repo's real owner/repo, when its checkout's remote names another" },
      anyway: { help: "coding: yes = use the checkout though its remote names another repo" },
      branch: { help: "coding: the branch (new, existing, or pr:N)" },
      scratch: { help: "coding: yes = a scratch folder, no worktree" },
    },
    run(desk, task, args) {
      return start(desk, task!, args);
    },
  },
  stop: {
    help: "Stop the task's agent and save",
    task: true,
    args: {},
    async run(desk, task) {
      await desk.stopAgent(task!.id);
      return `stopped ${ref(task)}'s agent`;
    },
  },
  redraft: {
    help: "Ask the task's agent for a different draft",
    task: true,
    args: { instruction: { help: "what to change", required: true } },
    run(desk, task, args) {
      desk.redraft(task!.id, args.instruction);
      return `asked for a redraft on ${ref(task)}`;
    },
  },
  ignore: {
    help: "Ignore: not work. Dropped (done if its agent worked on it); its messages filed as FYI. reopen undoes it",
    task: true,
    args: { why: { help: "why to ignore it, said on the task" } },
    async run(desk, task, args) {
      await desk.ignore(task!.id, args.why ?? "");
      return `${ref(task)}: ignored`;
    },
  },
  reopen: {
    help: "Open a done or dropped task again; its agent does not start",
    task: true,
    args: {},
    run(desk, task) {
      return desk.reopen(task!.id);
    },
  },
  noise: {
    help: "Teach triage a noise pattern: matching messages are filed as FYI with no model call",
    task: false,
    positional: "reason",
    args: {
      reason: {
        help: "why it is noise, as the owner reads it",
        required: true,
      },
      author: { help: "regex on the sender" },
      title: { help: "regex on the thread title" },
      body: { help: "regex on the message" },
      channel: { help: "github | slack" },
      github_reason: { help: "GitHub notification reasons, comma separated" },
    },
    run(desk, _task, args) {
      const rule = noiseRule(args);
      desk.addNoise(rule);
      const what = [
        rule.channel,
        rule.author && `from /${rule.author}/`,
        rule.title && `titled /${rule.title}/`,
        rule.body && `saying /${rule.body}/`,
        rule.githubReason && `GitHub ${rule.githubReason.join("/")}`,
      ]
        .filter(Boolean)
        .join(" ");
      return `triage files ${what} as FYI: ${rule.reason}`;
    },
  },
  priority: {
    help: "Set the task's priority",
    task: true,
    args: { level: { help: PRIORITIES.join(" | "), required: true } },
    run(desk, task, args) {
      const level = PRIORITIES.find((p) => p === args.level);
      if (!level)
        throw new MoveError(
          `level must be ${PRIORITIES.join(" | ")}: got ${args.level}`,
        );
      desk.setPriority(task!.id, level);
      return `${ref(task)} is ${level}`;
    },
  },
  tell: {
    help: "Type a line into the task's chat for its agent",
    task: true,
    args: { text: { help: "the line", required: true } },
    async run(desk, task, args) {
      return (await desk.say(task!.id, args.text))
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
      file: { help: "or the brief in a file you wrote in Riker's drafts/docs folder" },
      project: { help: "the project it belongs to" },
      repo: { help: "coding: owner/repo (default: the project's first repo)" },
      goal: { help: "the project goal it works toward (G3); puts it in that project" },
      from: {
        help: "the task this comes out of (RIKER-0012); it hears back. An agent's defaults to its own",
      },
      remind: { help: "put it away until then: days from now (1 = tomorrow)" },
    },
    run(desk, _task, args, by) {
      const remind = args.remind?.trim() ? remindDays(args.remind) : null;
      const kind = args.kind ? kindNamed(args.kind) : Kind.general;
      const named = args.project ? projectNamed(args.project) : null;
      const goal = args.goal?.trim() ? goalNamed(args.goal, named) : null;
      const project = named ?? (goal ? store.getProject(goal.project_id) : null);
      const repo = args.repo
        ? checkRepo(args.repo)
        : kind === Kind.coding && project
          ? (store.projectRepos(project)[0] ?? null)
          : null;
      const brief = briefText(args, "brief");
      const fromId = args.from ? store.parseTaskRef(args.from) : agentTask(by);
      const from = fromId ? store.getTask(fromId) : null;
      if (args.from && !from) throw new MoveError(`no task ${args.from}`);
      const task = store.batch(() => {
        const made = desk.newTask(args.title.trim(), kind, brief.text?.trim() ?? "", {
          projectId: project?.id ?? null,
          repo,
          fromTaskId: from?.id ?? null,
          goalId: goal?.id ?? null,
        });
        if (remind !== null) desk.remind(made.id, remind, by);
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
      brief.drop();
      // A task in a project with goals but naming none is said back, so the
      // caller can place it.
      const open = project && !goal
        ? store.goalsForProject(project.id).filter((g) => g.status === GoalStatus.open)
        : [];
      return [
        `${ref(task)} made (${kind}${project ? ` in project ${project.name}` : ""}${goal ? ` for ${store.goalRef(goal.id)}` : ""}${repo ? `, repo ${repo}` : ""})${remind !== null ? `, put away until ${store.getTask(task.id)?.remind_at?.slice(0, 10)}` : ""}`,
        open.length
          ? `It serves no goal; ${project!.name}'s are ${open.map((g) => `${store.goalRef(g.id)} ${g.title}`).join("; ")}. Set one with: goal ${ref(task)} <G>`
          : "",
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
    run(desk, task, args) {
      desk.retitle(task!.id, args.title);
      return `${ref(task)} is now: ${args.title.trim()}`;
    },
  },
  action: {
    help: "Run a task action (a skill on the task: summarize, guide, ...); its answer lands on the task. Without --name, lists the ones that apply",
    task: true,
    positional: "name",
    args: { name: { help: "the action's name" } },
    async run(desk, task, args) {
      const offered = actionsFor(desk.config(), task!);
      const name = args.name?.trim();
      if (!name)
        return offered.length
          ? `actions on ${ref(task)}: ${offered.map((a) => `${a.name} (${a.title})`).join("; ")}`
          : `no action applies to ${ref(task)}`;
      if (actionNamed(desk.config(), name)?.via === ActionVia.pane)
        throw new MoveError(`${name} needs the TUI: press . on ${ref(task)}`);
      const ready = await desk.prepareAction(task!.id, name);
      if (ready.type === "failed") throw new MoveError(ready.error);
      if (ready.type === "needs")
        throw new MoveError(
          `needs a path: ${ready.need.repo} has no checkout to make its worktree from (move repo ${ready.need.repo} --path <dir>, or --clone yes)`,
        );
      const started = desk.runAction(task!.id, name);
      if ("error" in started) throw new MoveError(started.error);
      // Not awaited: moves run one at a time, and an action takes minutes.
      void started.done.then(
        (r) => log.info("action from a move", { task: task!.id, name, ok: r.ok }),
        (err) => log.error("action from a move threw", { task: task!.id, name, err }),
      );
      return `started ${name} on ${ref(task)}: its answer lands in the task's chat when done (. on the task, Read, shows it over a live agent)`;
    },
  },
  brief: {
    help: "Rewrite the task's brief, before its agent starts (after, tell it)",
    task: true,
    args: {
      text: { help: "the whole new brief" },
      file: { help: "or the brief in a file you wrote in Riker's drafts/docs folder" },
    },
    run(desk, task, args) {
      if (!desk.briefEditable(task!.id))
        throw new MoveError(
          `${ref(task)}'s agent already started from its brief: tell it what changed instead`,
        );
      const brief = briefText(args, "text");
      if (brief.text === null) throw new MoveError("brief needs --text or --file");
      desk.editBrief(task!.id, brief.text);
      brief.drop();
      return `${ref(task)}'s brief rewritten`;
    },
  },
  kind: {
    help: "Change what kind of work the task is",
    task: true,
    args: { kind: { help: KINDS.join(" | "), required: true } },
    run(desk, task, args) {
      const kind = kindNamed(args.kind);
      desk.setKind(task!.id, kind);
      return `${ref(task)} is ${kind} work`;
    },
  },
  project: {
    help: "Move the task into a project (a running agent's window moves too)",
    task: true,
    args: { project: { help: "the project's name", required: true } },
    async run(desk, task, args) {
      const project = projectNamed(args.project);
      await desk.moveTask(task!.id, project.id);
      return `${ref(task)} is in project ${project.name}`;
    },
  },
  wait_on: {
    help: "Mark the task waiting on someone (empty: no longer waiting)",
    task: true,
    args: { who: { help: "who it waits on" } },
    run(desk, task, args) {
      desk.waitOn(task!.id, args.who ?? "");
      return args.who?.trim()
        ? `${ref(task)} waits on ${args.who.trim()}`
        : `${ref(task)} waits on nobody`;
    },
  },
  block_on: {
    help: "Mark the task blocked by another task; it hears when that one is done",
    task: true,
    args: { on: { help: "the task it waits for (RIKER-0000)", required: true } },
    run(desk, task, args, by) {
      try {
        return desk.blockOn(task!.id, taskArg(args.on), by);
      } catch (err) {
        if (err instanceof MoveError) throw err;
        throw new MoveError(err instanceof Error ? err.message : String(err));
      }
    },
  },
  unblock: {
    help: "No longer blocked by a task (no --on: by any)",
    task: true,
    args: { on: { help: "the task it waited for (RIKER-0000)" } },
    run(desk, task, args) {
      return desk.unblock(task!.id, args.on?.trim() ? taskArg(args.on) : undefined);
    },
  },
  win: {
    help: "Pin the task as one of today's Wins (at most 5); --off yes unpins it",
    task: true,
    args: { off: { help: "yes: unpin it" } },
    run(desk, task, args) {
      const said = desk.setWin(task!.id, args.off?.trim() !== "yes");
      if (!said.ok) throw new MoveError(said.text);
      return said.text;
    },
  },
  story: {
    help: "Turn the task's story (its state of play, kept from each finished session) on, off, or back to its project's default",
    task: true,
    positional: "to",
    args: { to: { help: "on | off | default", required: true } },
    run(desk, task, args) {
      return desk.setStory(task!.id, switchValue(args.to));
    },
  },
  pin: {
    help: "Pin a line (a goal, a next step) to the task's story: every later version keeps it; --off yes takes it off",
    task: true,
    positional: "line",
    args: {
      line: { help: "the line, as it should read", required: true },
      off: { help: "yes: take that line off" },
    },
    run(desk, task, args) {
      return desk.pinStory(task!.id, args.line, args.off?.trim() === "yes");
    },
  },
  story_undo: {
    help: "Make the story's version before the current one current again (a bad write-up); pins stay",
    task: true,
    args: {},
    run(desk, task) {
      return desk.undoStory(task!.id);
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
    run(desk, task, args, by) {
      const link = desk.link(
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
    run(desk, task, args) {
      const url = args.url.trim();
      if (!desk.unlink(task!.id, url)) {
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
    async run(desk, _task, args) {
      const taken = findProject(args.name);
      if (taken?.status === ProjectStatus.active)
        throw new MoveError(`there is already a project ${taken.name}`);
      const repo = args.repo ? checkRepo(args.repo) : null;
      const project = await desk.createProject(args.name.trim(), repo);
      return `made ${projectLine(project)}`;
    },
  },
  adopt: {
    help: "Make a claude started outside Riker (another tmux session, a terminal) a coding task in a project. Without --claude, lists them",
    task: false,
    positional: "claude",
    args: {
      claude: { help: "the stray: its id, tmux pane (%12), tmux session name or pid" },
      project: { help: "the project it joins", required: true },
    },
    async run(desk, _task, args) {
      const project = projectNamed(args.project);
      const strays = await desk.strays();
      if (!args.claude?.trim())
        return strays.length
          ? `strays: ${strays.map((s) => `${strayRef(s)} (${strayLabel(s)})`).join("; ")}. Pass --claude <id>.`
          : "no stray claudes running";
      let stray: Stray;
      try {
        stray = matchStray(strays, args.claude);
      } catch (err) {
        throw new MoveError(err instanceof Error ? err.message : String(err));
      }
      const task = await desk.adoptStray(stray, project.id);
      return stray.pane
        ? `adopted ${strayLabel(stray)} as ${ref(task)} in ${project.name}; its window moved into the project's session`
        : `adopted ${strayLabel(stray)} as ${ref(task)} in ${project.name}; quit that claude, then start ${ref(task)} to continue it in tmux`;
    },
  },
  project_repo: {
    help: "Add a repo to a project (its coding tasks default to the first), or take one out",
    task: false,
    positional: "project",
    args: {
      project: { help: "the project's name", required: true },
      repo: { help: "owner/repo", required: true },
      remove: { help: "yes = take it out of the project" },
    },
    async run(desk, _task, args) {
      const project = projectNamed(args.project);
      const repo = checkRepo(args.repo);
      if (args.remove === "yes") desk.removeProjectRepo(project.id, repo);
      else store.addProjectRepo(project.id, repo);
      const line = projectLine(store.getProject(project.id) ?? project);
      if (args.remove === "yes" || !repos.checkMapped(desk.config(), repo)) return line;
      const found = await repos.candidates(desk.config(), repo);
      return `${line}. ${repo} has no good checkout${found.length ? `; found at ${found.map((c) => repos.tildePath(c.path)).join(", ")} (map one with: repo ${repo} --path <it>)` : ` (map it with: repo ${repo} --path <checkout>, or --clone yes)`}`;
    },
  },
  repo: {
    help: "Where a repo is checked out: map a path, clone it, rename it, or forget it",
    task: false,
    positional: "repo",
    args: {
      repo: { help: "owner/repo", required: true },
      path: { help: "its checkout" },
      clone: { help: "yes = gh repo clone it (to --path, or the first repo root)" },
      rename: { help: "its new owner/repo, in config, projects and open tasks" },
      anyway: { help: "yes = use its checkout though the remote names another repo" },
      remove: { help: "yes = forget its path (the checkout stays on disk)" },
    },
    async run(desk, _task, args) {
      let repo = checkRepo(args.repo);
      try {
        if (args.remove === "yes") {
          desk.unmapRepo(repo);
          return `${repo}: path forgotten`;
        }
        if (args.rename) repo = desk.renameRepo(repo, args.rename);
        if (args.clone === "yes") await desk.cloneRepo(repo, args.path);
        else if (args.path) desk.mapRepo(repo, args.path);
        const path = repos.repoPath(desk.config(), repo);
        if (args.anyway === "yes" && path) desk.allowMismatch(repo, path);
      } catch (err) {
        throw new MoveError(err instanceof Error ? err.message : String(err));
      }
      const state = (await desk.repoReport()).repos.find((r) => r.repo === repo);
      return state ? repos.repoStateLine(state) : `${repo}: no path`;
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
    async run(desk, _task, args) {
      const project = projectNamed(args.project);
      const open = store
        .tasksForProject(project.id)
        .filter((t) => t.status === TaskStatus.open || t.status === TaskStatus.later);
      if (open.length && args.force !== "yes")
        throw new MoveError(
          `${project.name} has ${open.length} open task${open.length === 1 ? "" : "s"} (${open.map((t) => ref(t)).join(", ")}); archiving ends their agents. Ask the owner, then pass --force yes.`,
        );
      await desk.archiveProject(project.id);
      return `archived ${project.name}`;
    },
  },
  goal: {
    help: "Say which project goal the task works toward (empty: none)",
    task: true,
    positional: "goal",
    args: { goal: { help: "the goal's ref (G3), in the task's project" } },
    run(_engine, task, args) {
      if (!args.goal?.trim()) {
        store.updateTask(task!.id, { goal_id: null });
        return `${ref(task)} works toward no goal`;
      }
      const project = task!.project_id ? store.getProject(task!.project_id) : null;
      if (!project)
        throw new MoveError(`${ref(task)} is in no project: move it into one first`);
      const goal = goalNamed(args.goal, project);
      store.updateTask(task!.id, { goal_id: goal.id });
      return `${ref(task)} works toward ${store.goalRef(goal.id)}: ${goal.title}`;
    },
  },
  project_brief: {
    help: "Write a project's brief: what it is for. Every task in it reads it",
    task: false,
    positional: "project",
    args: {
      project: { help: "the project's name", required: true },
      text: { help: "the whole new brief", required: true },
    },
    run(_engine, _task, args) {
      const project = projectNamed(args.project);
      store.updateProject(project.id, { brief: args.text.trim() });
      return `${project.name}'s brief rewritten`;
    },
  },
  journal: {
    help: "Turn a project's journal (a file of its finished sessions and task events) on, off, or back to config's default; --stories sets its tasks' story default instead",
    task: false,
    positional: "project",
    args: {
      project: { help: "the project's name", required: true },
      to: { help: "on | off | default", required: true },
      stories: { help: "yes: set the default for its tasks' stories, not its journal" },
    },
    run(desk, _task, args) {
      const project = projectNamed(args.project);
      const which = args.stories?.trim() === "yes" ? "story" : "journal";
      return desk.setProjectSwitch(project.id, which, switchValue(args.to));
    },
  },
  project_link: {
    help: "Attach a doc to a project (a Notion page, a spec); its tasks see it",
    task: false,
    positional: "project",
    args: {
      project: { help: "the project's name", required: true },
      url: { help: "the http(s) URL", required: true },
      title: { help: "what it is, in a few words" },
    },
    run(_engine, _task, args, by) {
      const project = projectNamed(args.project);
      const link = store.addProjectLink(
        project.id,
        checkUrl(args.url),
        args.title?.trim() || null,
        by,
      );
      return `linked ${link.title ? `${link.title} (${link.url})` : link.url} to ${project.name}`;
    },
  },
  project_unlink: {
    help: "Take a doc off a project",
    task: false,
    positional: "project",
    args: {
      project: { help: "the project's name", required: true },
      url: { help: "the URL, as it was attached", required: true },
    },
    run(_engine, _task, args) {
      const project = projectNamed(args.project);
      const url = args.url.trim();
      if (!store.removeProjectLink(project.id, url)) {
        const links = store.linksForProject(project.id).map((l) => l.url);
        throw new MoveError(
          `${project.name} has no link ${url}${links.length ? `. Links: ${links.join(", ")}` : ""}`,
        );
      }
      return `unlinked ${url} from ${project.name}`;
    },
  },
  goal_new: {
    help: "Add a goal to a project: an outcome its tasks work toward",
    task: false,
    positional: "project",
    args: {
      project: { help: "the project's name", required: true },
      title: { help: "the outcome, in a line", required: true },
    },
    run(_engine, _task, args) {
      const project = projectNamed(args.project);
      const goal = store.addGoal(project.id, args.title.trim());
      return `${store.goalRef(goal.id)} added to ${project.name}: ${goal.title}`;
    },
  },
  goal_set: {
    help: "Mark a project goal met, dropped or open again, or retitle it",
    task: false,
    positional: "goal",
    args: {
      goal: { help: "the goal's ref (G3)", required: true },
      status: { help: GOAL_STATUSES.join(" | ") },
      title: { help: "a new title" },
    },
    run(_engine, _task, args) {
      const goal = goalNamed(args.goal);
      const status = args.status?.trim()
        ? GOAL_STATUSES.find((s) => s === args.status.trim())
        : undefined;
      if (args.status?.trim() && !status)
        throw new MoveError(
          `status must be ${GOAL_STATUSES.join(" | ")}: got ${args.status}`,
        );
      const title = args.title?.trim() || undefined;
      if (!status && !title) throw new MoveError("goal_set needs --status or --title");
      store.updateGoal(goal.id, { status, title });
      const now = store.getGoal(goal.id)!;
      return `${store.goalRef(now.id)} [${now.status}] ${now.title}`;
    },
  },
  onboard: {
    help: "Start the onboarding interview: a claude session on a System task asks about the owner and drafts PERSONA, JOB and STYLE there",
    task: false,
    args: {},
    run(desk) {
      return desk.onboard();
    },
  },
  propose_doc: {
    help: "Propose a whole new text for one of the owner's docs (PERSONA, JOB, STYLE). It waits on a System task until the owner accepts",
    task: false,
    args: {
      doc: { help: "PERSONA | JOB | STYLE", required: true },
      file: { help: "the file you wrote the whole doc to, in Riker's drafts/docs folder" },
      text: { help: "the whole doc inline (no Markdown headings: use --file)" },
      reason: { help: "one line: why" },
    },
    run(_desk, _task, args) {
      const doc = docNamed(args.doc);
      if (doc !== DocName.persona && doc !== DocName.job && doc !== DocName.style)
        throw new MoveError(`doc must be PERSONA | JOB | STYLE: got ${args.doc}`);
      if (!args.file?.trim() === !args.text?.trim())
        throw new MoveError("propose_doc needs --file or --text, not both");
      const file = args.file?.trim() ? docDraftFile(args.file.trim()) : null;
      const text = file ? readFileSync(file, "utf8") : args.text;
      if (!text.trim()) throw new MoveError("the doc is empty");
      const p = propose({
        doc,
        source: ProposalSource.onboard,
        proposed: text.trimEnd() + "\n",
        reason: args.reason ?? "",
      });
      if (file) rmSync(file, { force: true });
      return `${doc} proposed on ${store.taskRef(p.task_id)}: the owner reviews it there`;
    },
  },
  remember: {
    help: "Write a line the owner said into LEARNED.md",
    task: false,
    args: { line: { help: "the line", required: true } },
    run(desk, _task, args) {
      desk.remember(args.line);
      return "written to LEARNED.md";
    },
  },
};

// What a task's own agent may ask for: new tasks and projects, small edits
// (and links, follow-ups) to its own task and to tasks it made (new --from
// its task), and docs on a project. Starting, stopping and closing work,
// schedules, archiving a project and setting its brief and goals stay the
// owner's and the Assistant's.
export const AGENT_MOVES: ReadonlySet<string> = new Set([
  "new",
  "project_new",
  "retitle",
  "project",
  "wait_on",
  "block_on",
  "unblock",
  "priority",
  "remind",
  "followup",
  "unschedule",
  "link",
  "unlink",
  "goal",
  "project_link",
]);

// What the onboarding interview's agent (on a System task) may ask for.
const INTERVIEW_MOVES: ReadonlySet<string> = new Set(["propose_doc"]);

function agentTask(by: string): number | null {
  return by.startsWith("agent ") ? store.parseTaskRef(by.slice(6)) : null;
}

export interface MoveOutcome {
  ok: boolean;
  result: string;
}

export async function runMove(
  desk: Desk,
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
        result: args.task ? `no task ${args.task}` : `${verb} needs --task RIKER-0000`,
      };
    if (task.kind === Kind.home)
      return { ok: false, result: `${args.task} is Home, not a task` };
  }
  const own = agentTask(by);
  if (own !== null) {
    const allowed =
      store.getTask(own)?.kind === Kind.system ? INTERVIEW_MOVES : AGENT_MOVES;
    if (!allowed.has(verb))
      return { ok: false, result: `${verb} is the owner's move: say what you need under Next steps` };
    if (task && task.id !== own && task.from_task_id !== own)
      return {
        ok: false,
        result: `an agent changes only its own task (${store.taskRef(own)}) and tasks it made`,
      };
  }
  const missing = Object.entries(spec.args)
    .filter(([name, arg]) => arg.required && !args[name]?.trim())
    .map(([name]) => `--${name}`);
  if (missing.length)
    return { ok: false, result: `${verb} needs ${missing.join(", ")}` };
  // A plugin may hold it for the owner's own yes (from Slack, work is
  // started or ended only on a yes there).
  const held = desk.guardMove(verb, args, by);
  if (held !== null) return { ok: true, result: held };
  try {
    // Every move is kept for ctrl+z: one the desk did not record (a tell, a
    // goal, a repo) is kept as one it cannot undo.
    const { value, recorded } = await desk.undos.asMove(by, async () =>
      spec.run(desk, task, args, by),
    );
    if (!recorded)
      desk.undos.cannot(
        `${verb}${task ? ` ${ref(task)}` : ""}`,
        "it is not a move ctrl+z takes back",
        by,
      );
    return { ok: true, result: value };
  } catch (err) {
    if (err instanceof MoveError) return { ok: false, result: err.message };
    log.error("move failed", { verb, err });
    return {
      ok: false,
      result: `${verb} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// A move older than this was asked of a Riker that wasn't running: it fails
// rather than surprising the owner when Riker next starts.
export const MOVE_STALE_MS = 60_000;

export async function drainMoves(desk: Desk, at = Date.now()): Promise<number> {
  let ran = 0;
  for (const move of store.pendingMoves()) {
    if (at - Date.parse(move.created_at) > MOVE_STALE_MS) {
      store.abandonMove(move.id, "expired: riker was not running to make it");
      continue;
    }
    if (!store.claimMove(move.id)) continue;
    const args = JSON.parse(move.args) as Record<string, string>;
    const outcome = await runMove(desk, move.verb, args, move.asked_by);
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
  // How long a pending move may sit before giving up on Riker.
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
    // Losing the race to abandon means the engine claimed it just now: keep
    // waiting, and sleep like any other poll rather than spin.
    if (move.status === MoveStatus.pending && waited > pickupMs) {
      if (store.abandonMove(id, "riker did not pick it up: is riker running?"))
        return store.getMove(id)!;
    }
    if (waited > pickupMs + runMs)
      return { ...move, status: MoveStatus.failed, result: "still running: check riker" };
    await Bun.sleep(pollMs);
  }
}
