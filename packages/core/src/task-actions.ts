// Task actions: a skill run on one task at the owner's word (docs/
// task-actions-design.md). The recipe is a skill; what Riker adds is which
// rows it applies to, how it runs and where its answer goes. Built-ins are
// registered here and their skills ship in Riker's own plugin (core's
// plugin/, written under RIKER_HOME at start); config.json `actions`
// changes one field by field, turns one off (false) or registers another.
//
// An action is not the task's agent: it never touches agent_state, and its
// answer is a turn of its own (TurnRole.action), so nothing that reads the
// agent's turns (resume, denials, the latest answer) mistakes it for one.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import guideSkill from "@riker/code-review-plannotator/SKILL.md" with { type: "text" };
import quizSkill from "../plugin/skills/quiz/SKILL.md" with { type: "text" };
import summarizeSkill from "../plugin/skills/summarize/SKILL.md" with { type: "text" };
import { claudeDir, declaredRules, pluginSkillFiles } from "./capabilities";
import type { RikerConfig } from "./config";
import { envName, LEGACY, PLUGIN } from "./brand";
import { logger } from "./log";
import { paths } from "./paths";
import { taskPr, taskPrStatus } from "./pr";
import * as store from "./store";
import { messageMeta } from "./meta";
import { Kind, type MessageRow, type TaskRow } from "./types";

const log = logger("task-actions");

export const ActionVia = {
  // Headless claude -p with the task's context; touches nothing else.
  headless: "headless",
  // Headless on a fork of the task's agent session: it sees what the agent
  // saw and cannot disturb it. Headless when there is no session.
  fork: "fork",
  // The task's own agent is told to run it, as if the owner typed it.
  agent: "agent",
  // Interactive claude in a split of the agent's window, or on the Canvas
  // when it has none: for a skill that talks with the owner (a quiz).
  pane: "pane",
} as const;
export type ActionVia = (typeof ActionVia)[keyof typeof ActionVia];

export const ActionOutput = {
  // The answer is a turn on the task.
  turn: "turn",
  // The answer is also a file under What it made.
  file: "file",
  // The skill does its own output (a pane the owner talks in).
  none: "none",
  // The answer is Plannotator guide JSON: saved into Plannotator, opened in
  // `plannotator review`, its findings listed on the turn (@riker/code-review-plannotator).
  guide: "guide",
} as const;
export type ActionOutput = (typeof ActionOutput)[keyof typeof ActionOutput];

export const ActionNeed = {
  worktree: "worktree",
  session: "session",
  pr: "pr",
} as const;
export type ActionNeed = (typeof ActionNeed)[keyof typeof ActionNeed];

// What runs an action without a key press (docs/task-actions-design.md,
// Triggers). `triaged`: triage made a task or added a message to one.
// The rest come from task_events, so a change in any process is heard:
// `ready` (the agent said its work is done), `merged`, `done`.
export const ActionEvent = {
  triaged: "triaged",
  ready: "ready",
  merged: "merged",
  done: "done",
} as const;
export type ActionEvent = (typeof ActionEvent)[keyof typeof ActionEvent];

// Plain rules, no model: every field given must match. author, title and
// body are case-blind regexes, as in triage.noise; title is the task's.
export interface ActionTrigger {
  event: ActionEvent;
  kind?: Kind;
  channel?: "github" | "slack";
  githubReason?: string[];
  author?: string;
  title?: string;
  body?: string;
  // The task's project, by name.
  project?: string;
}

export interface ActionSpec {
  name: string;
  // The picker's label.
  title: string;
  // "plugin:name" (Riker's own plugin is "Riker") or a bare skill name.
  skill: string;
  // Passed after the skill: {ref} {title} {worktree} {branch} {base} {pr}.
  args?: string;
  via: ActionVia;
  // A capabilities.* entry loaded for this run (a plugin, commands).
  capability?: string;
  // Rows it applies to; default every kind of work.
  kinds?: Kind[];
  needs?: ActionNeed[];
  output: ActionOutput;
  // A key of its own on the rail and table (read at start).
  key?: string;
  model?: string;
  on?: ActionTrigger[];
}

export type ActionConfig = Partial<Omit<ActionSpec, "name">> | false;

const WORK_KINDS: Kind[] = [Kind.general, Kind.coding, Kind.reply, Kind.task];

export const BUILTIN_ACTIONS: Record<string, Omit<ActionSpec, "name">> = {
  summarize: {
    title: "Summarize the work so far",
    skill: "riker:summarize",
    args: "task {ref} ({title}); checkout {worktree}; base {base}",
    via: ActionVia.fork,
    output: ActionOutput.turn,
  },
  guide: {
    title: "Guided review, with review notes",
    skill: "riker:guide",
    args: "task {ref} ({title}); base {base}; pull request {pr}",
    via: ActionVia.fork,
    kinds: [Kind.coding],
    needs: [ActionNeed.worktree],
    output: ActionOutput.guide,
  },
  quiz: {
    title: "Quiz me on the change",
    skill: "riker:quiz",
    // No {title}: it can come from Slack or GitHub, and this one runs
    // interactive claude with the owner's own settings.
    args: "task {ref}; base {base}; 5 questions",
    via: ActionVia.pane,
    kinds: [Kind.coding],
    needs: [ActionNeed.worktree],
    output: ActionOutput.none,
  },
};

// The skills of Riker's own plugin, by name, as shipped.
const RIKER_SKILLS: Record<string, string> = {
  summarize: summarizeSkill,
  guide: guideSkill,
  quiz: quizSkill,
};

export const RIKER_PLUGIN = PLUGIN;

// A config written before the rename names aug's plugin (aug:summarize): the
// same skills are Riker's now.
export function currentSkill(skill: string): string {
  const prefix = `${LEGACY.plugin}:`;
  return skill.startsWith(prefix)
    ? `${RIKER_PLUGIN}:${skill.slice(prefix.length)}`
    : skill;
}

export function rikerPluginDir(): string {
  return join(paths.home(), "plugin");
}

// Riker's plugin under RIKER_HOME, rewritten when a shipped skill changed. Its
// own home, so no install step: headless runs load it with --plugin-dir.
export function ensureRikerPlugin(dir = rikerPluginDir()): string {
  const manifest = join(dir, ".claude-plugin", "plugin.json");
  const want = JSON.stringify(
    {
      name: RIKER_PLUGIN,
      version: "1.0.0",
      description: "Riker's task actions (summarize, ...), as skills.",
    },
    null,
    2,
  );
  writeIfChanged(manifest, `${want}\n`);
  for (const [name, text] of Object.entries(RIKER_SKILLS)) {
    writeIfChanged(join(dir, "skills", name, "SKILL.md"), text);
  }
  return dir;
}

function writeIfChanged(file: string, text: string): void {
  try {
    if (existsSync(file) && readFileSync(file, "utf8") === text) {
      return;
    }
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  } catch (err) {
    log.warn("could not write Riker's plugin", { file, err });
  }
}

// Built-ins, then config's changes and additions. An entry without a skill
// or a via is left out (and logged), never guessed.
export function registeredActions(
  config: Pick<RikerConfig, "actions">,
): ActionSpec[] {
  const out: ActionSpec[] = [];
  const names = new Set([
    ...Object.keys(BUILTIN_ACTIONS),
    ...Object.keys(config.actions ?? {}),
  ]);
  for (const name of names) {
    const override = config.actions?.[name];
    if (override === false) {
      continue;
    }
    const merged = { ...BUILTIN_ACTIONS[name], ...override };
    if (!merged.skill || !merged.via || !isVia(merged.via)) {
      log.warn("action left out: it needs a skill and a via", { name });
      continue;
    }
    out.push({
      name,
      title: merged.title ?? name,
      skill: currentSkill(merged.skill),
      args: merged.args,
      via: merged.via,
      capability: merged.capability,
      kinds: merged.kinds,
      needs: merged.needs,
      output: merged.output ?? ActionOutput.turn,
      key: merged.key,
      model: merged.model,
      on: triggers(name, merged.on),
    });
  }
  return out;
}

// A trigger with an unknown event is left out (and logged), never guessed.
function triggers(name: string, on: unknown): ActionTrigger[] | undefined {
  if (!Array.isArray(on)) {
    return undefined;
  }
  const events = Object.values(ActionEvent) as string[];
  return on.filter((t): t is ActionTrigger => {
    const ok =
      typeof t === "object" &&
      t !== null &&
      events.includes((t as ActionTrigger).event);
    if (!ok) {
      log.warn("action trigger left out: unknown event", { name, trigger: t });
    }
    return ok;
  });
}

function isVia(v: string): v is ActionVia {
  return (Object.values(ActionVia) as string[]).includes(v);
}

export function actionNamed(
  config: RikerConfig,
  name: string,
): ActionSpec | undefined {
  return registeredActions(config).find((a) => a.name === name);
}

// Why an action cannot run on this task now, or null when it can.
export function whyNot(spec: ActionSpec, task: TaskRow): string | null {
  return why(spec, task, false);
}

// Why an action is not offered on this task, or null when it is: as whyNot,
// except that a worktree it lacks counts as met when the task has a repo to
// make one in (makesCheckout), so a review that arrived from GitHub offers
// its guide before any agent has started.
export function whyNotOffered(spec: ActionSpec, task: TaskRow): string | null {
  return why(spec, task, true);
}

// The action needs a worktree the task has not got (or has lost), and its
// repo can make one: the owner's run makes it first (desk.prepareAction),
// with no agent started.
export function makesCheckout(spec: ActionSpec, task: TaskRow): boolean {
  return (
    (spec.needs ?? []).includes(ActionNeed.worktree) &&
    task.kind === Kind.coding &&
    !!task.repo &&
    !hasWorktree(task)
  );
}

function hasWorktree(task: TaskRow): boolean {
  return !!task.worktree && existsSync(task.worktree);
}

function why(spec: ActionSpec, task: TaskRow, offered: boolean): string | null {
  const kinds = spec.kinds ?? WORK_KINDS;
  if (!kinds.includes(task.kind)) {
    return `${spec.name} is for ${kinds.join(" or ")} tasks`;
  }
  const making = offered && makesCheckout(spec, task);
  for (const need of spec.needs ?? []) {
    if (need === ActionNeed.worktree && making) {
      continue;
    }
    if (need === ActionNeed.worktree && !task.worktree) {
      return `${spec.name} needs a worktree (start the agent first)`;
    }
    // Checked before the run, not after it has spent its tokens.
    if (
      need === ActionNeed.worktree &&
      task.worktree &&
      !existsSync(task.worktree)
    ) {
      return `${spec.name} needs a worktree, and ${task.worktree} is gone`;
    }
    if (need === ActionNeed.session && !store.latestSession(task.id)) {
      return `${spec.name} needs an agent session (start the agent first)`;
    }
    if (need === ActionNeed.pr && !taskPr(task)) {
      return `${spec.name} needs a pull request on the task`;
    }
  }
  return null;
}

// The actions an event runs on this task: a trigger of theirs matches,
// and they apply to it. A pane action needs the owner at the keyboard, so
// nothing runs one by itself.
export function triggeredBy(
  config: RikerConfig,
  event: ActionEvent,
  task: TaskRow,
  message?: MessageRow | null,
): ActionSpec[] {
  return registeredActions(config).filter(
    (spec) =>
      spec.via !== ActionVia.pane &&
      (spec.on ?? []).some(
        (t) => t.event === event && triggerMatches(t, task, message ?? null),
      ) &&
      whyNot(spec, task) === null,
  );
}

function triggerMatches(
  t: ActionTrigger,
  task: TaskRow,
  message: MessageRow | null,
): boolean {
  if (t.kind && t.kind !== task.kind) {
    return false;
  }
  if (t.channel && t.channel !== (message?.channel ?? task.channel)) {
    return false;
  }
  if (t.githubReason) {
    const meta = message ? messageMeta(message) : null;
    const reason = meta?.channel === "github" ? meta.reason : null;
    if (!reason || !t.githubReason.includes(reason)) {
      return false;
    }
  }
  if (!regexMatch(t.author, message?.author ?? message?.author_name)) {
    return false;
  }
  if (!regexMatch(t.title, task.title)) {
    return false;
  }
  if (!regexMatch(t.body, message?.body)) {
    return false;
  }
  if (t.project) {
    const project = task.project_id ? store.getProject(task.project_id) : null;
    if (project?.name.toLowerCase() !== t.project.toLowerCase()) {
      return false;
    }
  }
  return true;
}

// A pattern that does not compile never matches.
function regexMatch(
  pattern: string | undefined,
  value: string | null | undefined,
): boolean {
  if (!pattern) {
    return true;
  }
  try {
    return new RegExp(pattern, "i").test(value ?? "");
  } catch {
    return false;
  }
}

// The actions that ask for a key of their own (bound at start).
export function keyedActions(
  config: RikerConfig,
): { name: string; key: string; title: string }[] {
  return registeredActions(config).flatMap((a) =>
    a.key ? [{ name: a.name, key: a.key, title: a.title }] : [],
  );
}

// The actions the picker offers for a task: the ones it can run now, and
// the ones it can once their worktree is made.
export function actionsFor(config: RikerConfig, task: TaskRow): ActionSpec[] {
  return registeredActions(config).filter(
    (a) => whyNotOffered(a, task) === null,
  );
}

// What a task without a PR is taken against; the skills fall back to master
// when there is no main.
export const ACTION_BASE = "main";

// The branch a task's change is taken against: its PR's base, as the last
// read of it said (another PR's branch when it is stacked), else main. A
// read that failed keeps the base the one before it said; a PR never read,
// or a row about a PR the task no longer points at, says nothing.
export function actionBase(task: TaskRow): string {
  return taskPrStatus(task)?.status?.base || ACTION_BASE;
}

export function prUrl(task: TaskRow): string | null {
  const pr = taskPr(task);
  return pr ? `https://github.com/${pr.repo}/pull/${pr.number}` : null;
}

// The args with the task filled in; a value it lacks reads "none".
export function fillArgs(template: string, task: TaskRow): string {
  const values: Record<string, string> = {
    ref: store.taskRef(task.id),
    title: task.title,
    worktree: task.worktree ?? "none",
    branch: task.branch ?? "none",
    base: actionBase(task),
    pr: prUrl(task) ?? "none",
  };
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? values[key]! : whole,
  );
}

// What the prompt says: the skill as a slash command, then its args. A
// wrapped user skill is invoked by its wrapper's name (`as`).
export function invocation(
  spec: ActionSpec,
  task: TaskRow,
  as: string = spec.skill,
): string {
  const args = spec.args ? fillArgs(spec.args, task) : "";
  return `/${as}${args ? ` ${args}` : ""}`;
}

// Where a headless run loads a skill from, and the name it is invoked by:
// Riker's own plugin, the plugin the action's capability grants, or a bare
// user skill (~/.claude/skills/<name>) wrapped in a plugin of its own, since
// headless claude skips the user's settings. `wrapped` says the skill's
// allowed-tools were not vetted by a capability.
export interface SkillSource {
  dir: string;
  as: string;
  wrapped: boolean;
}

export function skillSource(
  spec: ActionSpec,
  capabilityDirs: string[],
): SkillSource | null {
  const [plugin, name] = spec.skill.includes(":")
    ? (spec.skill.split(":", 2) as [string, string])
    : [null, spec.skill];
  if (plugin === RIKER_PLUGIN) {
    const dir = ensureRikerPlugin();
    return existsSync(join(dir, "skills", name))
      ? { dir, as: spec.skill, wrapped: false }
      : null;
  }
  if (!plugin) {
    const dir = wrapUserSkill(name);
    return dir ? { dir, as: `${WRAP_PLUGIN}:${name}`, wrapped: true } : null;
  }
  const dir = capabilityDirs.find((d) =>
    pluginSkillFiles(d).some(
      (f) => f.includes(`/skills/${name}/`) || f.endsWith(`/${name}.md`),
    ),
  );
  return dir ? { dir, as: spec.skill, wrapped: false } : null;
}

export const WRAP_PLUGIN = "riker-user";

export function userSkillDir(name: string): string {
  return join(claudeDir(), "skills", name);
}

// A plugin folder holding one user skill (linked, so an edit to the skill
// applies), under RIKER_HOME. Made once and kept while its link still points
// at the skill, so two runs at once never pull it from under each other.
export function wrapUserSkill(name: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) {
    return null;
  }
  const source = userSkillDir(name);
  if (!existsSync(join(source, "SKILL.md"))) {
    return null;
  }
  const dir = join(paths.home(), "wrapped", name);
  const link = join(dir, "skills", name);
  try {
    const target = realpathSync(source);
    writeIfChanged(
      join(dir, ".claude-plugin", "plugin.json"),
      `${JSON.stringify({ name: WRAP_PLUGIN, version: "1.0.0", description: `Your ${name} skill, for Riker's headless runs.` }, null, 2)}\n`,
    );
    if (linkTarget(link) !== target) {
      rmSync(link, { recursive: true, force: true });
      mkdirSync(join(dir, "skills"), { recursive: true });
      symlinkSync(target, link);
    }
    return dir;
  } catch (err) {
    log.warn("could not wrap a user skill", { name, err });
    return null;
  }
}

function linkTarget(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

// The interactive claude a pane action runs: the skill as its first prompt,
// with Riker's plugin (or the capability's) loaded; a bare user skill needs
// nothing, since interactive claude loads the user's settings. RIKER_TASK_ID
// without a session id keeps Riker's hooks off it: it is not the task's agent.
export function paneCommand(
  spec: ActionSpec,
  task: TaskRow,
  capabilityDirs: string[],
): { argv: string[]; env: Record<string, string> } | { error: string } {
  const plugin = spec.skill.includes(":") ? spec.skill.split(":", 1)[0] : null;
  let dirs: string[] = [];
  if (plugin) {
    const source = skillSource(spec, capabilityDirs);
    // A plugin the user installed loads with their settings anyway.
    if (source) {
      dirs = [source.dir];
    } else if (plugin === RIKER_PLUGIN) {
      return { error: `skill ${spec.skill} not found in Riker's plugin` };
    }
  } else if (!existsSync(join(userSkillDir(spec.skill), "SKILL.md"))) {
    return {
      error: `skill ${spec.skill} not found in ${userSkillDir(spec.skill)}`,
    };
  }
  const env = { [envName("TASK_ID")]: String(task.id) };
  return {
    argv: [
      "env",
      ...Object.entries(env).map(([k, v]) => `${k}=${v}`),
      "claude",
      ...(spec.model ? ["--model", spec.model] : []),
      ...dirs.flatMap((d) => ["--plugin-dir", d]),
      invocation(spec, task),
    ],
    env,
  };
}

// The rules Riker's own skills declare: trusted, since Riker wrote them.
export function rikerSkillRules(spec: ActionSpec): string[] {
  const [plugin, name] = spec.skill.split(":", 2);
  if (plugin !== RIKER_PLUGIN || !name) {
    return [];
  }
  const text = RIKER_SKILLS[name];
  return text ? (declaredRules(text) ?? []) : [];
}
