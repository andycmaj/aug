// Task actions: a skill run on one task at the owner's word (docs/
// task-actions-design.md). The recipe is a skill; what aug adds is which
// rows it applies to, how it runs and where its answer goes. Built-ins are
// registered here and their skills ship in aug's own plugin (contrib/
// aug-plugin, written under AUG_HOME at start); config.json `actions`
// changes one field by field, turns one off (false) or registers another.
//
// An action is not the task's agent: it never touches agent_state, and its
// answer is a turn of its own (TurnRole.action), so nothing that reads the
// agent's turns (resume, denials, the latest answer) mistakes it for one.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import summarizeSkill from "../../contrib/aug-plugin/skills/summarize/SKILL.md" with { type: "text" };
import { declaredRules, pluginSkillFiles } from "./capabilities";
import type { AugConfig } from "./config";
import { logger } from "./log";
import { paths } from "./paths";
import { taskPr } from "./pr";
import * as store from "./store";
import { Kind, type TaskRow } from "./types";

const log = logger("task-actions");

export const ActionVia = {
  // Headless claude -p with the task's context; touches nothing else.
  headless: "headless",
  // Headless on a fork of the task's agent session: it sees what the agent
  // saw and cannot disturb it. Headless when there is no session.
  fork: "fork",
  // The task's own agent is told to run it, as if the owner typed it.
  agent: "agent",
  // Interactive claude in a split of the agent's window (not built yet).
  pane: "pane",
} as const;
export type ActionVia = (typeof ActionVia)[keyof typeof ActionVia];

export const ActionOutput = {
  // The answer is a turn on the task.
  turn: "turn",
  // The answer is also a file under What it made.
  file: "file",
  // The skill does its own output (opens a viewer, links a guide).
  none: "none",
} as const;
export type ActionOutput = (typeof ActionOutput)[keyof typeof ActionOutput];

export const ActionNeed = {
  worktree: "worktree",
  session: "session",
  pr: "pr",
} as const;
export type ActionNeed = (typeof ActionNeed)[keyof typeof ActionNeed];

export interface ActionSpec {
  name: string;
  // The picker's label.
  title: string;
  // "plugin:name" (aug's own plugin is "aug") or a bare skill name.
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
}

export type ActionConfig = Partial<Omit<ActionSpec, "name">> | false;

const WORK_KINDS: Kind[] = [Kind.general, Kind.coding, Kind.reply, Kind.task];

export const BUILTIN_ACTIONS: Record<string, Omit<ActionSpec, "name">> = {
  summarize: {
    title: "Summarize the work so far",
    skill: "aug:summarize",
    args: "task {ref} ({title}); checkout {worktree}; base {base}",
    via: ActionVia.fork,
    output: ActionOutput.turn,
  },
};

// The skills of aug's own plugin, by name, as shipped.
const AUG_SKILLS: Record<string, string> = {
  summarize: summarizeSkill,
};

export const AUG_PLUGIN = "aug";

export function augPluginDir(): string {
  return join(paths.home(), "plugin");
}

// aug's plugin under AUG_HOME, rewritten when a shipped skill changed. Its
// own home, so no install step: headless runs load it with --plugin-dir.
export function ensureAugPlugin(dir = augPluginDir()): string {
  const manifest = join(dir, ".claude-plugin", "plugin.json");
  const want = JSON.stringify(
    {
      name: AUG_PLUGIN,
      version: "1.0.0",
      description: "aug's task actions (summarize, ...), as skills.",
    },
    null,
    2,
  );
  writeIfChanged(manifest, `${want}\n`);
  for (const [name, text] of Object.entries(AUG_SKILLS))
    writeIfChanged(join(dir, "skills", name, "SKILL.md"), text);
  return dir;
}

function writeIfChanged(file: string, text: string): void {
  try {
    if (existsSync(file) && readFileSync(file, "utf8") === text) return;
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  } catch (err) {
    log.warn("could not write aug's plugin", { file, err });
  }
}

// Built-ins, then config's changes and additions. An entry without a skill
// or a via is left out (and logged), never guessed.
export function registeredActions(config: AugConfig): ActionSpec[] {
  const out: ActionSpec[] = [];
  const names = new Set([
    ...Object.keys(BUILTIN_ACTIONS),
    ...Object.keys(config.actions ?? {}),
  ]);
  for (const name of names) {
    const override = config.actions?.[name];
    if (override === false) continue;
    const merged = { ...BUILTIN_ACTIONS[name], ...override };
    if (!merged.skill || !merged.via || !isVia(merged.via)) {
      log.warn("action left out: it needs a skill and a via", { name });
      continue;
    }
    out.push({
      name,
      title: merged.title ?? name,
      skill: merged.skill,
      args: merged.args,
      via: merged.via,
      capability: merged.capability,
      kinds: merged.kinds,
      needs: merged.needs,
      output: merged.output ?? ActionOutput.turn,
      key: merged.key,
      model: merged.model,
    });
  }
  return out;
}

function isVia(v: string): v is ActionVia {
  return (Object.values(ActionVia) as string[]).includes(v);
}

export function actionNamed(
  config: AugConfig,
  name: string,
): ActionSpec | undefined {
  return registeredActions(config).find((a) => a.name === name);
}

// Why an action cannot run on this task, or null when it can.
export function whyNot(spec: ActionSpec, task: TaskRow): string | null {
  const kinds = spec.kinds ?? WORK_KINDS;
  if (!kinds.includes(task.kind))
    return `${spec.name} is for ${kinds.join(" or ")} tasks`;
  for (const need of spec.needs ?? []) {
    if (need === ActionNeed.worktree && !task.worktree)
      return `${spec.name} needs a worktree (start the agent first)`;
    if (need === ActionNeed.session && !store.latestSession(task.id))
      return `${spec.name} needs an agent session (start the agent first)`;
    if (need === ActionNeed.pr && !taskPr(task))
      return `${spec.name} needs a pull request on the task`;
  }
  if (spec.via === ActionVia.pane) return `${spec.name} runs in a pane, which is not built yet`;
  return null;
}

// The actions the picker offers for a task.
export function actionsFor(config: AugConfig, task: TaskRow): ActionSpec[] {
  return registeredActions(config).filter((a) => whyNot(a, task) === null);
}

// A task does not record what it branched from; the skills fall back to
// master when there is no main.
const BASE = "main";

// The args with the task filled in; a value it lacks reads "none".
export function fillArgs(template: string, task: TaskRow): string {
  const pr = taskPr(task);
  const values: Record<string, string> = {
    ref: store.taskRef(task.id),
    title: task.title,
    worktree: task.worktree ?? "none",
    branch: task.branch ?? "none",
    base: BASE,
    pr: pr ? `https://github.com/${pr.repo}/pull/${pr.number}` : "none",
  };
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? values[key]! : whole,
  );
}

// What the prompt says: the skill as a slash command, then its args.
export function invocation(spec: ActionSpec, task: TaskRow): string {
  const args = spec.args ? fillArgs(spec.args, task) : "";
  return `/${spec.skill}${args ? ` ${args}` : ""}`;
}

// The plugin folder a skill comes from, when aug can load it headless: its
// own plugin, or the plugin the action's capability grants.
export function skillPlugin(
  spec: ActionSpec,
  capabilityDirs: string[],
): string | null {
  const [plugin, name] = spec.skill.includes(":")
    ? (spec.skill.split(":", 2) as [string, string])
    : [null, spec.skill];
  if (plugin === AUG_PLUGIN) {
    const dir = ensureAugPlugin();
    return existsSync(join(dir, "skills", name)) ? dir : null;
  }
  if (!plugin) return null;
  return (
    capabilityDirs.find((dir) =>
      pluginSkillFiles(dir).some((f) => f.includes(`/skills/${name}/`) || f.endsWith(`/${name}.md`)),
    ) ?? null
  );
}

// The rules aug's own skills declare: trusted, since aug wrote them.
export function augSkillRules(spec: ActionSpec): string[] {
  const [plugin, name] = spec.skill.split(":", 2);
  if (plugin !== AUG_PLUGIN || !name) return [];
  const text = AUG_SKILLS[name];
  return text ? (declaredRules(text) ?? []) : [];
}
