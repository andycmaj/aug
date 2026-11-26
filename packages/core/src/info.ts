// What I shows: everything Riker knows about a rail item, as labeled rows
// under headings. Empty facts are left out, so a fresh to-do reads short.

import { existsSync } from "node:fs";
import { parseFiles } from "./files";
import { LANE_META, type Lane } from "./lanes";
import { paths } from "./paths";
import { ageLabel, type RailItem } from "./rail";
import { projectProgress } from "./lookup";
import type { RikerConfig } from "./config";
import {
  journalSwitch,
  lines,
  projectStoryDefault,
  storySwitch,
  switchWords,
} from "./digests";
import { journalExists, journalFile } from "./journal";
import * as store from "./store";
import { timerLine, timerRef } from "./timers";
import {
  GoalStatus,
  TimerKind,
  type ProjectRow,
  type StoryRow,
  type TaskRow,
} from "./types";

export interface InfoRow {
  label: string;
  value: string;
  // What enter opens: the links on a task and the thread it came from.
  open?: string;
}

export interface InfoSection {
  title: string;
  rows: InfoRow[];
}

function when(iso: string | null, now: Date): string | null {
  if (!iso) {
    return null;
  }
  const d = new Date(iso);
  const stamp = d.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  const age = ageLabel(iso, now);
  return `${stamp} (${age.startsWith("in ") ? age : `${age} ago`})`;
}

function section(
  title: string,
  pairs: [string, string | number | null | undefined][],
): InfoSection {
  return {
    title,
    rows: pairs
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([label, v]) =>
        label === "url"
          ? { label, value: String(v), open: String(v) }
          : { label, value: String(v) },
      ),
  };
}

// The task's story switch (J flips it) and its current version.
function storySection(
  config: RikerConfig,
  task: TaskRow,
  now: Date,
): InfoSection {
  const v = store.currentStory(task.id);
  const part = (
    key: keyof StoryRow,
    label: string,
  ): [string, string | null] => {
    const items = v ? lines(String(v[key] ?? "")) : [];
    return [label, items.length ? items.join("; ") : null];
  };
  return section("Story", [
    [
      "switch",
      `${switchWords("story", storySwitch(config, task))}; J flips it, V reads it`,
    ],
    ["as of", v ? `${when(v.at, now)} by ${v.by}` : null],
    part("pinned", "pinned"),
    part("goals", "goals"),
    part("now", "now"),
    part("decisions", "decisions"),
    part("blocked", "blocked"),
    part("next", "next"),
    part("questions", "questions"),
    ["versions", v ? store.storiesFor(task.id).length : null],
  ]);
}

// The project's journal switch (J flips it), its file and its tasks'
// story default.
function journalSection(config: RikerConfig, project: ProjectRow): InfoSection {
  const file = journalFile(project);
  const s = section("Journal", [
    [
      "switch",
      `${switchWords("journal", journalSwitch(config, project))}; J flips it, V reads it`,
    ],
    ["stories", switchWords("stories", projectStoryDefault(config, project))],
  ]);
  if (journalExists(project)) {
    s.rows.push({ label: "file", value: file, open: `file://${file}` });
  }
  return s;
}

function taskSections(task: TaskRow, lane: Lane, now: Date): InfoSection[] {
  const messages = store.messagesForTask(task.id);
  const turns = store.turnsForTask(task.id);
  const sessions = store.sessionsForTask(task.id);
  const files = new Set(
    turns.flatMap((t) => parseFiles(t.files).map((f) => f.path)),
  );
  const work = paths.work(task.id);
  const last = messages.at(-1);
  const latest = sessions[0];
  const goal = task.goal_id ? store.getGoal(task.goal_id) : null;

  return [
    section("Task", [
      ["ref", store.taskRef(task.id)],
      ["title", task.title],
      ["kind", task.kind],
      ["status", task.status],
      ["lane", LANE_META[lane].word],
      [
        "project",
        task.project_id ? store.getProject(task.project_id)?.name : null,
      ],
      [
        "goal",
        goal
          ? `${store.goalRef(goal.id)} ${goal.title} (${goal.status})`
          : null,
      ],
      [
        "priority",
        task.priority_pinned ? `${task.priority} (set by you)` : task.priority,
      ],
      ["watching", task.watching ? "yes" : null],
      ["waiting on", task.waiting_on],
      ["remind", when(task.remind_at, now)],
      ...store
        .timersForTask(task.id)
        .filter((t) => t.kind !== TimerKind.remind)
        .map((t): [string, string] => [timerRef(t.id), timerLine(t, now)]),
      ["created", when(task.created_at, now)],
      ["updated", when(task.updated_at, now)],
      [
        "closed",
        task.closed_at
          ? `${when(task.closed_at, now)} by ${task.closed_by ?? "?"}`
          : null,
      ],
    ]),
    section("Source", [
      ["channel", task.channel],
      ["repo", task.repo],
      ["url", task.url],
      ["thread", task.thread_key],
      ["triage", task.triage_reason],
      ["messages", messages.length || null],
      [
        "last heard",
        last ? `${last.author_name}, ${when(last.received_at, now)}` : null,
      ],
    ]),
    {
      title: "Links",
      rows: store
        .linksForTask(task.id)
        .map((l) => ({ label: l.title ?? "link", value: l.url, open: l.url })),
    },
    section("Agent", [
      ["state", task.agent_state === "none" ? null : task.agent_state],
      ["says", task.agent_says],
      ["queued", task.queue_reason],
      ["turns", turns.length || null],
      ["sessions", sessions.length || null],
      ["session", latest?.id],
      ["session kind", latest?.kind],
      ["cwd", latest?.cwd],
      ["last tool", latest?.last_tool],
      ["started", when(latest?.started_at ?? null, now)],
      ["ended", when(latest?.ended_at ?? null, now)],
      ["work dir", existsSync(work) ? work : null],
      ["files made", files.size || null],
    ]),
  ].filter((s) => s.rows.length > 0);
}

export function itemInfo(
  item: RailItem,
  now = new Date(),
  config?: RikerConfig,
): InfoSection[] {
  switch (item.type) {
    case "task": {
      const fresh = store.getTask(item.task.id) ?? item.task;
      const sections = taskSections(fresh, item.lane, now);
      return config
        ? [...sections, storySection(config, fresh, now)]
        : sections;
    }
    case "project": {
      const fresh = store.getProject(item.project.id) ?? item.project;
      const progress = projectProgress(fresh);
      return [
        section("Project", [
          ["name", item.project.name],
          ["id", String(item.project.id)],
          ["tmux session", item.project.tmux_session],
          ["repos", item.repos.join(", ") || null],
          ["open tasks", String(item.open)],
          ["working", item.working ? String(item.working) : null],
          [
            "solo",
            item.project.solo ? "yes: archived when its task is done" : null,
          ],
          ["goals", item.goals ? `${item.goalsMet}/${item.goals} met` : null],
          ["created", when(item.project.created_at, now)],
        ]),
        section("Brief", [["brief", fresh.brief || "none yet: e writes one"]]),
        {
          title: "Goals",
          rows: progress.goals
            .filter((g) => g.goal.status !== GoalStatus.dropped)
            .map((g) => ({
              label: `${store.goalRef(g.goal.id)} ${g.goal.status}`,
              value: `${g.goal.title} (${g.tasks.length ? `${g.done}/${g.tasks.length} tasks done` : "no tasks yet"})`,
            })),
        },
        {
          title: "Docs",
          rows: store.linksForProject(fresh.id).map((l) => ({
            label: l.title ?? "link",
            value: l.url,
            open: l.url,
          })),
        },
        ...(config ? [journalSection(config, fresh)] : []),
      ].filter((s) => s.rows.length > 0);
    }
  }
}

export function infoTitle(item: RailItem): string {
  if (item.type === "task") {
    return `${store.taskRef(item.task.id)} · ${item.task.title}`;
  }
  return `Project ${item.project.name}`;
}
