// The Documents view (the Board's Docs tab): every link and doc Riker
// holds, from wherever it is kept, one row per address with all its owners.
// Built from what is stored, never by fetching a page: a link can point at
// a private doc, and its title is only what was given when it was attached.

import { statSync } from "node:fs";
import { basename } from "node:path";
import { DOC_PURPOSE, docPath, DocName } from "./docs";
import { parsePrUrl } from "./feedback";
import { parseFiles } from "./files";
import { linkTarget, type LinkTarget } from "./links";
import { prUrl } from "./pr";
import { taskRef } from "./rows";
import type { DocumentSources } from "./store";

export const DocKind = {
  pr: "pr",
  issue: "issue",
  doc: "doc",
  thread: "thread",
  file: "file",
  other: "other",
} as const;
export type DocKind = (typeof DocKind)[keyof typeof DocKind];

export const DOC_KINDS: DocKind[] = Object.values(DocKind);

export const KIND_WORDS: Record<DocKind, string> = {
  pr: "PR",
  issue: "issue",
  doc: "doc",
  thread: "thread",
  file: "file",
  other: "other",
};

// Where an owner keeps it. Only a link someone attached can be taken off
// here; the rest are what Riker saw (a task's thread, a PR its branch
// opened, a file the agent made, a URL in a message or note).
export const DocSource = {
  link: "link",
  projectLink: "project link",
  thread: "thread",
  pr: "PR",
  made: "made",
  message: "message",
  note: "note",
  brain: "brain doc",
} as const;
export type DocSource = (typeof DocSource)[keyof typeof DocSource];

export interface DocOwner {
  source: DocSource;
  taskId: number | null;
  // A project link's project, else its task's.
  projectId: number | null;
  // The link as stored: what unlink matches.
  stored: string;
  title: string | null;
  by: string | null;
  at: string;
  // What it was attached for, when Riker knows more than the title.
  note: string | null;
}

export interface DocRow {
  key: string;
  url: string;
  title: string;
  kind: DocKind;
  host: string;
  // The newest owner's: when it last came in.
  at: string;
  owners: DocOwner[];
  target: LinkTarget;
  // Lowercased title, address, kind and owners, for search.
  words: string;
}

export function removable(owner: DocOwner): boolean {
  return owner.source === DocSource.link || owner.source === DocSource.projectLink;
}

// http(s) and file: links, wherever they sit in text. Slack writes
// <url|label>, Markdown (label)[url]: stop at either.
const URL_IN_TEXT = /\b(?:https?|file):\/\/[^\s<>()[\]"'`|]+/gi;

export function urlsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(URL_IN_TEXT)) {
    const url = m[0].replace(/[.,;:!?*_~]+$/, "");
    if (linkTarget(url)) out.add(url);
  }
  return [...out];
}

// One address however it was written: a scheme or host in capitals, a
// trailing slash, a PR's /files tab are the same doc.
export function docKey(target: LinkTarget): string {
  if (target.type === "file") return `file:${target.path}`;
  const pr = parsePrUrl(target.url);
  if (pr) return prUrl(pr.repo, pr.number);
  try {
    const u = new URL(target.url);
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : "";
    return `${u.protocol}//${u.host}${path}${u.search}${u.hash}`;
  } catch {
    return target.url;
  }
}

const DOC_HOSTS = [
  "notion.so",
  "notion.site",
  "docs.google.com",
  "drive.google.com",
  "claude.ai",
  "gist.github.com",
  "coda.io",
  "quip.com",
  "hackmd.io",
  "figma.com",
  "paper.dropbox.com",
];

function hostOf(target: LinkTarget): string {
  if (target.type === "file") return "local";
  try {
    return new URL(target.url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function kindOf(target: LinkTarget): DocKind {
  if (target.type === "file") return DocKind.file;
  const host = hostOf(target);
  let path = "";
  try {
    path = new URL(target.url).pathname;
  } catch {
    return DocKind.other;
  }
  if (host === "github.com") {
    if (/^\/[^/]+\/[^/]+\/pull\/\d+/.test(path)) return DocKind.pr;
    if (/^\/[^/]+\/[^/]+\/issues\/\d+/.test(path)) return DocKind.issue;
    if (/^\/[^/]+\/[^/]+\/discussions\/\d+/.test(path)) return DocKind.thread;
    if (/^\/[^/]+\/[^/]+\/(blob|tree|wiki)\//.test(path)) return DocKind.doc;
  }
  if (host.endsWith("slack.com") && path.startsWith("/archives/")) return DocKind.thread;
  if (host === "linear.app" && path.includes("/issue/")) return DocKind.issue;
  if (host.endsWith("atlassian.net")) {
    if (path.startsWith("/browse/")) return DocKind.issue;
    if (path.startsWith("/wiki/")) return DocKind.doc;
  }
  if (DOC_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return DocKind.doc;
  return DocKind.other;
}

// A name for a link nobody titled: a PR or issue by its number, a file by
// its name, else the address without its scheme.
function derivedTitle(target: LinkTarget, kind: DocKind): string {
  if (target.type === "file") return basename(target.path);
  const m = target.url.match(/github\.com\/([^/]+\/[^/]+)\/(?:pull|issues|discussions)\/(\d+)/i);
  if (m && (kind === DocKind.pr || kind === DocKind.issue || kind === DocKind.thread))
    return `${m[1]}#${m[2]}`;
  if (kind === DocKind.thread && hostOf(target).endsWith("slack.com")) return "Slack thread";
  return target.url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "");
}

const THREAD = /^github:([^/#]+\/[^/#]+)#(\d+)$/;

function mtimeIso(path: string): string | null {
  try {
    return statSync(path).mtime.toISOString();
  } catch {
    return null;
  }
}

// Every source's owners of every link, before folding by address.
function ownersOf(src: DocumentSources): DocOwner[] {
  const projectOf = new Map(src.tasks.map((t) => [t.id, t.project_id]));
  const out: DocOwner[] = [];
  // A task the sources leave out is Home: the Assistant's scratch.
  const add = (o: Omit<DocOwner, "projectId"> & { projectId?: number | null }) => {
    if (o.taskId !== null && !projectOf.has(o.taskId)) return;
    out.push({ ...o, projectId: o.projectId ?? (o.taskId ? (projectOf.get(o.taskId) ?? null) : null) });
  };

  for (const l of src.taskLinks)
    add({ source: DocSource.link, taskId: l.task_id, stored: l.url, title: l.title, by: l.added_by, at: l.created_at, note: null });
  for (const l of src.projectLinks)
    add({
      source: DocSource.projectLink,
      taskId: null,
      projectId: l.project_id,
      stored: l.url,
      title: l.title,
      by: l.added_by,
      at: l.created_at,
      note: null,
    });
  for (const t of src.tasks)
    if (t.url)
      add({ source: DocSource.thread, taskId: t.id, stored: t.url, title: null, by: null, at: t.created_at, note: "where the task came from" });
  for (const th of src.threads) {
    const m = th.thread_key.match(THREAD);
    if (!m) continue;
    add({
      source: DocSource.pr,
      taskId: th.task_id,
      stored: prUrl(m[1], Number(m[2])),
      title: null,
      by: null,
      at: th.linked_at,
      note: "its pull request",
    });
  }
  for (const turn of src.made)
    for (const f of parseFiles(turn.files))
      add({ source: DocSource.made, taskId: turn.task_id, stored: f.path, title: f.name, by: "agent", at: turn.started_at, note: "a file the agent made" });
  for (const n of src.notes)
    for (const url of urlsIn(n.body))
      add({ source: DocSource.note, taskId: n.task_id, stored: url, title: null, by: n.author, at: n.created_at, note: "in a handoff note" });
  for (const m of src.messages)
    for (const url of urlsIn(m.body))
      add({ source: DocSource.message, taskId: m.task_id, stored: url, title: null, by: m.author_name, at: m.received_at, note: "in a message" });
  return out;
}

// The brain docs under RIKER_HOME/docs: Riker's own, owned by no task.
function brainOwners(): DocOwner[] {
  const out: DocOwner[] = [];
  for (const name of Object.values(DocName)) {
    const path = docPath(name);
    const at = mtimeIso(path);
    if (!at) continue;
    out.push({
      source: DocSource.brain,
      taskId: null,
      projectId: null,
      stored: path,
      title: name,
      by: null,
      at,
      note: DOC_PURPOSE[name],
    });
  }
  return out;
}

export function buildDocuments(src: DocumentSources, extra: DocOwner[] = []): DocRow[] {
  const projectName = new Map(src.projects.map((p) => [p.id, p.name]));
  const taskTitle = new Map(src.tasks.map((t) => [t.id, t.title]));
  const rows = new Map<string, DocRow>();
  for (const owner of [...ownersOf(src), ...extra]) {
    const target = linkTarget(owner.stored);
    if (!target) continue;
    const key = docKey(target);
    let row = rows.get(key);
    if (!row) {
      const kind = kindOf(target);
      row = {
        key,
        url: target.type === "file" ? target.path : target.url,
        title: "",
        kind,
        host: hostOf(target),
        at: owner.at,
        owners: [],
        target,
        words: "",
      };
      rows.set(key, row);
    }
    // The same task twice (its thread and a link to it) is one owner, the
    // one someone attached: that is what can be taken off.
    const twin = row.owners.findIndex((o) => o.taskId === owner.taskId && o.projectId === owner.projectId && owner.taskId !== null);
    if (twin >= 0) {
      const had = row.owners[twin];
      if (removable(owner) && !removable(had)) row.owners[twin] = { ...owner, note: owner.note ?? had.note };
      else if (!had.title && owner.title) row.owners[twin] = { ...had, title: owner.title };
    } else row.owners.push(owner);
    if (owner.at > row.at) row.at = owner.at;
  }
  for (const row of rows.values()) {
    row.owners.sort((a, b) => b.at.localeCompare(a.at));
    row.title = row.owners.find((o) => o.title)?.title ?? derivedTitle(row.target, row.kind);
    row.words = [
      row.title,
      row.url,
      row.kind,
      KIND_WORDS[row.kind],
      row.host,
      ...row.owners.flatMap((o) => [
        o.taskId ? taskRef(o.taskId) : "",
        o.taskId ? (taskTitle.get(o.taskId) ?? "") : "",
        o.projectId ? (projectName.get(o.projectId) ?? "") : "",
        o.source,
        o.title ?? "",
      ]),
    ]
      .join(" ")
      .toLowerCase();
  }
  return [...rows.values()].sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key));
}

export function documents(src: DocumentSources): DocRow[] {
  return buildDocuments(src, brainOwners());
}

// ── filters, search and grouping ──────────────────────────────────────────

// A project filter: every row, a project's, or rows no project owns.
export type ProjectFilter = number | "none" | null;

export function inKind(row: DocRow, kind: DocKind | null): boolean {
  return kind === null || row.kind === kind;
}

export function inProject(row: DocRow, project: ProjectFilter): boolean {
  if (project === null) return true;
  if (project === "none") return row.owners.every((o) => o.projectId === null);
  return row.owners.some((o) => o.projectId === project);
}

// Every word must appear somewhere: "riker spec" finds a spec on Riker.
export function matchesDoc(row: DocRow, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return words.every((w) => row.words.includes(w));
}

export function nextKind(kind: DocKind | null): DocKind | null {
  if (kind === null) return DOC_KINDS[0];
  const i = DOC_KINDS.indexOf(kind);
  return i === DOC_KINDS.length - 1 ? null : DOC_KINDS[i + 1];
}

// The projects any row belongs to, in the order filtering cycles them,
// then "none" when some row has no project.
export function projectChoices(rows: DocRow[]): ProjectFilter[] {
  const ids: number[] = [];
  let none = false;
  for (const row of rows) {
    if (row.owners.every((o) => o.projectId === null)) none = true;
    for (const o of row.owners) if (o.projectId !== null && !ids.includes(o.projectId)) ids.push(o.projectId);
  }
  return [null, ...ids.sort((a, b) => a - b), ...(none ? (["none"] as const) : [])];
}

export function nextProject(current: ProjectFilter, choices: ProjectFilter[]): ProjectFilter {
  const i = choices.indexOf(current);
  return choices[(i + 1) % choices.length] ?? null;
}

// The project a row sits under when grouped: its newest owner's.
export function groupOf(row: DocRow): number | null {
  return row.owners.find((o) => o.projectId !== null)?.projectId ?? null;
}
