// A project's brief, goals and docs as one Markdown file the owner edits in
// $EDITOR. Goals are a checklist keyed by their ref, so a retitled line stays
// the same goal and the tasks pointing at it keep pointing; a line without a
// ref is a new goal, and a goal whose line is gone is dropped (never deleted).

import * as store from "./store";
import { GoalStatus, type ProjectRow } from "./types";

const GOALS = "## Goals";
const DOCS = "## Docs";

const MARK: Record<GoalStatus, string> = {
  [GoalStatus.open]: " ",
  [GoalStatus.met]: "x",
  [GoalStatus.dropped]: "-",
};

export function renderProjectDoc(p: ProjectRow): string {
  const goals = store
    .goalsForProject(p.id)
    .filter((g) => g.status !== GoalStatus.dropped);
  const links = store.linksForProject(p.id);
  return [
    `# ${p.name}`,
    "<!-- What every task in this project reads. The brief goes under this line.",
    "     Goals: [x] met, [-] dropped; a line without a G ref is a new goal.",
    "     Docs: one URL a line, with what it is in front. -->",
    "",
    p.brief,
    "",
    GOALS,
    ...goals.map((g) => `- [${MARK[g.status]}] ${store.goalRef(g.id)} ${g.title}`),
    "",
    DOCS,
    ...links.map((l) => `- ${l.title ? `${l.title} ` : ""}${l.url}`),
    "",
  ].join("\n");
}

export interface ParsedGoal {
  id: number | null;
  title: string;
  status: GoalStatus;
}

export interface ParsedDoc {
  url: string;
  title: string | null;
}

export interface ParsedProject {
  brief: string;
  goals: ParsedGoal[];
  docs: ParsedDoc[];
}

const GOAL_LINE = /^[-*]\s*\[([ xX-])\]\s*(?:(G\d+)\b\s*)?(.*)$/;
const DOC_LINE = /^[-*]\s*(?:(.*?)\s+)?<?(https?:\/\/[^\s>]+)>?$/;

export function parseProjectDoc(text: string): ParsedProject {
  const brief: string[] = [];
  const goals: ParsedGoal[] = [];
  const docs: ParsedDoc[] = [];
  let part: "brief" | "goals" | "docs" = "brief";
  const body = text.replace(/<!--[\s\S]*?-->/g, "");
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const heading = line.toLowerCase();
    if (heading === GOALS.toLowerCase()) part = "goals";
    else if (heading === DOCS.toLowerCase()) part = "docs";
    else if (part === "brief") {
      if (!(brief.length === 0 && /^# /.test(line))) brief.push(raw);
    } else if (part === "goals") {
      const m = line.match(GOAL_LINE);
      if (!m || !m[3].trim()) continue;
      const status =
        m[1] === "-" ? GoalStatus.dropped : m[1] === " " ? GoalStatus.open : GoalStatus.met;
      goals.push({
        id: m[2] ? store.parseGoalRef(m[2]) : null,
        title: m[3].trim(),
        status,
      });
    } else {
      const m = line.match(DOC_LINE);
      if (m) docs.push({ url: m[2], title: m[1]?.trim() || null });
    }
  }
  return { brief: brief.join("\n").trim(), goals, docs };
}

// Writes what changed and says it in words for a toast.
export function applyProjectDoc(projectId: number, text: string, by: string): string {
  const project = store.getProject(projectId);
  if (!project) return "";
  const next = parseProjectDoc(text);
  const said: string[] = [];
  return store.batch(() => {
    if (next.brief !== project.brief) {
      store.updateProject(projectId, { brief: next.brief });
      said.push("brief rewritten");
    }
    const had = store.goalsForProject(projectId);
    const kept = new Set<number>();
    let added = 0;
    let changed = 0;
    for (const g of next.goals) {
      const old = g.id !== null ? had.find((h) => h.id === g.id) : undefined;
      if (!old) {
        const made = store.addGoal(projectId, g.title);
        if (g.status !== GoalStatus.open) store.updateGoal(made.id, { status: g.status });
        added++;
        continue;
      }
      kept.add(old.id);
      if (old.title === g.title && old.status === g.status) continue;
      store.updateGoal(old.id, {
        title: old.title === g.title ? undefined : g.title,
        status: old.status === g.status ? undefined : g.status,
      });
      changed++;
    }
    let dropped = 0;
    for (const old of had)
      if (!kept.has(old.id) && old.status !== GoalStatus.dropped) {
        store.updateGoal(old.id, { status: GoalStatus.dropped });
        dropped++;
      }
    if (added) said.push(`${added} goal${added === 1 ? "" : "s"} added`);
    if (changed) said.push(`${changed} goal${changed === 1 ? "" : "s"} changed`);
    if (dropped) said.push(`${dropped} goal${dropped === 1 ? "" : "s"} dropped`);

    const links = store.linksForProject(projectId);
    const urls = new Set(next.docs.map((d) => d.url));
    let docs = 0;
    for (const l of links)
      if (!urls.has(l.url)) {
        store.removeProjectLink(projectId, l.url);
        docs++;
      }
    for (const d of next.docs) {
      const old = links.find((l) => l.url === d.url);
      if (old && old.title === d.title) continue;
      if (old && d.title === null) {
        // COALESCE keeps an old title; a doc line without one clears it.
        store.removeProjectLink(projectId, d.url);
      }
      store.addProjectLink(projectId, d.url, d.title, by);
      docs++;
    }
    if (docs) said.push("docs updated");
    return said.length ? `${project.name}: ${said.join(", ")}` : "";
  });
}
