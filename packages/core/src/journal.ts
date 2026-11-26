// The project journal (docs/session-digests-design.md): a plain text file
// per project under Riker's home, newest first, one entry per finished
// session and one line per other task event. The engine is its only
// writer. The file is the owner's too: Riker writes only between its own
// markers and never rewrites an entry it already wrote.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { RikerConfig } from "./config";
import {
  digestLinks,
  digestWanted,
  journalSwitch,
  lines,
  storySwitch,
} from "./digests";
import { watchSession } from "./digest-watcher";
import { EndReason } from "./lifecycle";
import { logger } from "./log";
import { paths } from "./paths";
import { mergeText } from "./proposals";
import { storyFromDigest } from "./story";
import * as store from "./store";
import {
  DigestBy,
  TaskEventKind,
  TaskStatus,
  type DigestRow,
  type ProjectRow,
  type TaskEventRow,
  type TaskRow,
} from "./types";

const log = logger("journal");

export const MARK = {
  statusBegin: "<!-- riker:status -->",
  statusEnd: "<!-- /riker:status -->",
  begin: "<!-- riker:journal -->",
  end: "<!-- /riker:journal -->",
  entry: (month: string) => `<!-- riker:entry ${month} -->`,
} as const;

const ENTRY_LINE = /^<!-- riker:entry (\d{4}-\d{2}) -->$/;

export const JOURNAL_LINK_TITLE = "Journal";

// ── where ───────────────────────────────────────────────────────────────

export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

// A project's folder: its journal now, its tasks' documents later
// (tasks/<REF>/ beside it). Kept by id once made, so a rename does not
// strand the file.
export function projectDir(project: ProjectRow): string {
  const key = `journal.dir.${project.id}`;
  const known = store.kvGet(key);
  if (known) {
    return known;
  }
  const dir = join(paths.home(), "projects", slug(project.name));
  store.kvSet(key, dir);
  return dir;
}

export function journalFile(project: ProjectRow): string {
  return join(projectDir(project), "journal.md");
}

export function archiveFile(project: ProjectRow, month: string): string {
  return join(projectDir(project), "journal", `${month}.md`);
}

// ── what it says ────────────────────────────────────────────────────────

// Local time, as the owner reads a clock.
export function stamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function monthOf(iso: string): string {
  return stamp(iso).slice(0, 7);
}

const OUTCOME_WORDS: Record<string, string> = {
  ready: "ready for review",
  blocked: "blocked",
  waiting: "waiting on the owner",
  stopped: "stopped before it finished",
};

function list(label: string, field: string): string | null {
  const items = lines(field);
  if (!items.length) {
    return null;
  }
  if (items.length === 1 && label !== "Learned" && label !== "Next") {
    return `${label}: ${items[0]}`;
  }
  return `${label}:\n${items.map((i) => `- ${i}`).join("\n")}`;
}

export function renderEntry(task: TaskRow, d: DigestRow): string {
  const links = digestLinks(d);
  const linkParts = [
    links.pr ? `PR ${links.pr}` : null,
    links.branch ? `branch ${links.branch}` : null,
    ...(links.docs ?? []).map(
      (l) => `doc ${l.title ? `${l.title} ` : ""}${l.url}`,
    ),
  ].filter(Boolean);
  const parts = [
    `${stamp(d.at)}  ${store.taskRef(task.id)}  ${task.title}  (${d.by === "agent" ? "agent" : "written up by the watcher"})\nOutcome: ${OUTCOME_WORDS[d.outcome] ?? d.outcome}`,
    list("Did", d.did),
    list("Decisions", d.decisions),
    list("Learned", d.learned),
    list("Blocked", d.blocked),
    list("Questions", d.questions),
    list("Next", d.next),
    linkParts.length ? `Links: ${linkParts.join(", ")}` : null,
  ];
  return parts.filter(Boolean).join("\n\n");
}

const EVENT_WORDS: Partial<Record<TaskEventKind, (e: TaskEventRow) => string>> =
  {
    [TaskEventKind.created]: () => "made",
    [TaskEventKind.done]: (e) =>
      e.detail ? `done (closed by ${e.detail})` : "done",
    [TaskEventKind.dropped]: () => "dropped",
    [TaskEventKind.later]: () => "put away for later",
    [TaskEventKind.reopened]: () => "reopened",
    [TaskEventKind.merged]: () => "merged",
    [TaskEventKind.unmerged]: () => "merge undone",
    [TaskEventKind.finished]: (e) =>
      `agent finished${e.detail ? `: ${e.detail}` : ""}`,
    [TaskEventKind.ended]: () => "session ended",
  };

export function renderLine(
  task: TaskRow,
  e: TaskEventRow,
  words?: string,
): string {
  const said = words ?? EVENT_WORDS[e.kind]?.(e) ?? e.kind;
  return `${stamp(e.at)}  ${store.taskRef(task.id)}  ${said}  (${task.title})`;
}

// One line per open task in the project: where its latest digest left it.
export function statusLines(project: ProjectRow): string[] {
  const open = store
    .listTasks()
    .filter((t) => t.project_id === project.id && t.status === TaskStatus.open);
  return open.map((t) => {
    const d = store.latestDigest(t.id);
    const ref = store.taskRef(t.id);
    if (!d) {
      return `${ref}  ${t.title}: no session written up yet`;
    }
    const next = lines(d.next)[0];
    return `${ref}  ${t.title}: ${OUTCOME_WORDS[d.outcome] ?? d.outcome}${next ? `; next: ${next}` : ""}`;
  });
}

// The project's standing, as its manager or the owner last wrote it: first
// in the status block, one line.
export function standingLine(project: ProjectRow): string[] {
  const text = lines(project.standing).join("; ");
  return text
    ? [
        `Standing (${stamp(project.standing_at ?? project.updated_at)}): ${text}`,
      ]
    : [];
}

// ── placing it in the file ──────────────────────────────────────────────

function between(
  text: string,
  begin: string,
  end: string,
): { start: number; stop: number } | null {
  const a = text.indexOf(begin);
  if (a < 0) {
    return null;
  }
  const b = text.indexOf(end, a + begin.length);
  if (b < 0) {
    return null;
  }
  return { start: a + begin.length, stop: b };
}

export interface Placed {
  text: string;
  // Entries of earlier months taken out of the block, by month, newest first.
  rolled: Map<string, string[]>;
  // The markers were gone and were put back.
  remarked: boolean;
}

// Split a journal block into its entries, each with its month; text before
// the first entry marker (the owner's) stays first.
function entriesOf(block: string): {
  lead: string;
  entries: { month: string; text: string }[];
} {
  const entries: { month: string; text: string }[] = [];
  const leadLines: string[] = [];
  let cur: { month: string; lines: string[] } | null = null;
  for (const line of block.split("\n")) {
    const m = line.trim().match(ENTRY_LINE);
    if (m) {
      if (cur) {
        entries.push({ month: cur.month, text: cur.lines.join("\n") });
      }
      cur = { month: m[1], lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    } else {
      leadLines.push(line);
    }
  }
  if (cur) {
    entries.push({ month: cur.month, text: cur.lines.join("\n") });
  }
  return { lead: leadLines.join("\n"), entries };
}

function tidy(text: string): string {
  return text.replace(/^\n+|\n+$/g, "");
}

function joinBlock(lead: string, entries: string[]): string {
  const body = [tidy(lead), ...entries.map(tidy)].filter(Boolean).join("\n\n");
  return body ? `\n${body}\n` : "\n";
}

// The file with one more entry, the status block rewritten, and earlier
// months rolled out. Text outside the markers is left as it was.
export function placeEntry(
  file: string,
  opts: {
    title: string;
    entry: string;
    month: string;
    status: string[] | null;
  },
): Placed {
  let text = file;
  let remarked = false;
  if (!between(text, MARK.begin, MARK.end)) {
    remarked = file.trim().length > 0;
    const head = file.trim() ? "" : `${opts.title}\n\n`;
    const status = opts.status
      ? `${MARK.statusBegin}\n${MARK.statusEnd}\n\n`
      : "";
    text = `${head}${status}${MARK.begin}\n${MARK.end}\n${file.trim() ? `\n${file}` : ""}`;
  }
  if (opts.status) {
    let s = between(text, MARK.statusBegin, MARK.statusEnd);
    if (!s) {
      const at = text.indexOf(MARK.begin);
      text = `${text.slice(0, at)}${MARK.statusBegin}\n${MARK.statusEnd}\n\n${text.slice(at)}`;
      s = between(text, MARK.statusBegin, MARK.statusEnd)!;
    }
    const body = opts.status.length
      ? `\nNow:\n${opts.status.map((l) => `- ${l}`).join("\n")}\n`
      : "\n";
    text = `${text.slice(0, s.start)}${body}${text.slice(s.stop)}`;
  }
  const j = between(text, MARK.begin, MARK.end)!;
  const { lead, entries } = entriesOf(text.slice(j.start, j.stop));
  const rolled = new Map<string, string[]>();
  const kept: string[] = [];
  for (const e of entries) {
    if (e.month === opts.month) {
      kept.push(e.text);
    } else {
      rolled.set(e.month, [...(rolled.get(e.month) ?? []), e.text]);
    }
  }
  const fresh = `${MARK.entry(opts.month)}\n${opts.entry}`;
  text = `${text.slice(0, j.start)}${joinBlock(lead, [fresh, ...kept])}${text.slice(j.stop)}`;
  return { text, rolled, remarked };
}

// Entries rolled out of the journal, laid on top of a month's file.
export function placeRolled(
  file: string,
  title: string,
  entries: string[],
): string {
  let text = file;
  if (!between(text, MARK.begin, MARK.end)) {
    text = `${file.trim() ? `${file.trimEnd()}\n\n` : `${title}\n\n`}${MARK.begin}\n${MARK.end}\n`;
  }
  const j = between(text, MARK.begin, MARK.end)!;
  const { lead, entries: had } = entriesOf(text.slice(j.start, j.stop));
  return `${text.slice(0, j.start)}${joinBlock(lead, [...entries, ...had.map((e) => e.text)])}${text.slice(j.stop)}`;
}

// ── writing ─────────────────────────────────────────────────────────────

function readOr(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

// Whole file or nothing: an editor never sees half a write.
function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.riker-tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
}

// The journal is a doc of its project, so every brief there names it.
function register(project: ProjectRow, file: string): void {
  const url = `file://${file}`;
  if (store.linksForProject(project.id).some((l) => l.url === url)) {
    return;
  }
  store.addProjectLink(project.id, url, JOURNAL_LINK_TITLE, "riker");
}

export function writeJournal(
  project: ProjectRow,
  entry: string,
  at: string,
): string {
  const file = journalFile(project);
  const month = monthOf(at);
  const placed = placeEntry(readOr(file), {
    title: `${project.name}: journal`,
    entry,
    month,
    status: [
      ...standingLine(store.getProject(project.id) ?? project),
      ...statusLines(project),
    ],
  });
  for (const [m, entries] of placed.rolled) {
    const archive = archiveFile(project, m);
    writeAtomic(
      archive,
      placeRolled(readOr(archive), `${project.name}: journal, ${m}`, entries),
    );
  }
  writeAtomic(file, placed.text);
  if (placed.remarked) {
    log.info("journal markers were gone; put back at the top", {
      project: project.id,
    });
  }
  register(project, file);
  return file;
}

// ── the engine's part ───────────────────────────────────────────────────

const CURSOR = "journal.events";

// A finished session's digest: the one `done` wrote just before the event.
function digestFor(task: TaskRow, e: TaskEventRow): DigestRow | null {
  const d = store.latestDigest(task.id);
  if (!d) {
    return null;
  }
  const gap = Date.parse(e.at) - Date.parse(d.at);
  return gap >= -1000 && gap < 60_000 ? d : null;
}

// The agent wrote this run of the session up with done (its entry is the
// `finished` one). A resumed session keeps its id, so only a digest since
// the session last ended counts.
function doneSince(sessionId: string, e: TaskEventRow): boolean {
  const before = store.sessionEndedBefore(sessionId, e.id)?.at ?? "";
  return store
    .digestsForSession(sessionId)
    .some((d) => d.by === DigestBy.agent && d.at > before);
}

// What one event adds: an entry, a line, or nothing.
async function heard(config: RikerConfig, e: TaskEventRow): Promise<void> {
  const task = store.getTask(e.task_id);
  if (!task) {
    return;
  }
  const project = task.project_id ? store.getProject(task.project_id) : null;
  const journal = journalSwitch(config, project).on && project !== null;

  if (e.kind === TaskEventKind.ended) {
    const session = e.detail ? store.getSession(e.detail) : null;
    if (!session || session.end_reason === EndReason.restart) {
      return;
    }
    if (doneSince(session.id, e)) {
      return;
    }
    if (!digestWanted(config, task)) {
      return;
    }
    const watched = await watchSession(config, task, session);
    if (watched.digest && storySwitch(config, task).on) {
      storyFromDigest(watched.digest);
    }
    if (!journal || !project) {
      return;
    }
    writeJournal(
      project,
      watched.digest
        ? renderEntry(task, watched.digest)
        : renderLine(task, e, `session ended; ${watched.why}`),
      e.at,
    );
    return;
  }
  if (!journal || !project) {
    return;
  }
  if (e.kind === TaskEventKind.finished) {
    const d = digestFor(task, e);
    writeJournal(project, d ? renderEntry(task, d) : renderLine(task, e), e.at);
    return;
  }
  if (EVENT_WORDS[e.kind]) {
    writeJournal(project, renderLine(task, e), e.at);
  }
}

let running = false;

// Task events since the last look. The first look starts at the newest
// event: history writes nothing. One at a time, in order; a watcher call
// in the middle holds the rest until it is back.
export async function journalTick(config: RikerConfig): Promise<number> {
  if (running) {
    return 0;
  }
  running = true;
  try {
    const cursor = store.kvGet(CURSOR);
    if (cursor === null) {
      store.kvSet(CURSOR, String(store.lastTaskEventId()));
      return 0;
    }
    const events = store.taskEventsAfter(Number(cursor));
    for (const e of events) {
      try {
        await heard(config, e);
      } catch (err) {
        log.error("journal event failed", {
          event: e.id,
          task: e.task_id,
          err: err instanceof Error ? err.name : "error",
        });
      }
      store.kvSet(CURSOR, String(e.id));
    }
    return events.length;
  } finally {
    running = false;
  }
}

export function journalExists(project: ProjectRow): boolean {
  return existsSync(journalFile(project));
}

// ── reading it ──────────────────────────────────────────────────────────

const STAMPED = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}  /;

// The file as markdown for V's reader. It is written as plain lines, which
// markdown would run together: the markers go, the title and the status
// block become headings, a session's first line a heading of its own and
// an event's line a list item. Text the owner wrote passes through.
export function journalMarkdown(file: string): string {
  const src = file.split("\n").filter((l) => !/^\s*<!--.*-->\s*$/.test(l));
  const out: string[] = [];
  const nextText = (i: number) => src.slice(i + 1).find((l) => l.trim()) ?? "";
  src.forEach((line, i) => {
    if (line === "Now:") {
      out.push("## Now");
    } else if (STAMPED.test(line)) {
      out.push(
        nextText(i).startsWith("Outcome:") ? `### ${line}` : `- ${line}`,
      );
    } else if (
      !out.some((l) => l.trim()) &&
      line.trim() &&
      !line.startsWith("#")
    ) {
      out.push(`# ${line}`);
    } else {
      out.push(line);
    }
  });
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The journal's file and what it says now, or null before its first entry.
export function readJournal(
  project: ProjectRow,
): { file: string; text: string } | null {
  const file = journalFile(project);
  if (!existsSync(file)) {
    return null;
  }
  return { file, text: readOr(file) };
}

export const JournalSave = {
  unchanged: "unchanged",
  saved: "saved",
  // The engine wrote while the owner edited; both kept.
  merged: "merged",
  // Both touched the same lines: nothing written.
  conflict: "conflict",
} as const;
export type JournalSave = (typeof JournalSave)[keyof typeof JournalSave];

// The owner's edit, made on a copy of the file as it was at `base`. The
// engine may have written an entry since; saving the copy whole would drop
// it, so the edit goes over the file as it is now (git merge-file).
export function saveJournalEdit(
  project: ProjectRow,
  base: string,
  edited: string,
): JournalSave {
  if (edited === base) {
    return JournalSave.unchanged;
  }
  const file = journalFile(project);
  const now = readOr(file);
  const merged = mergeText(edited, base, now);
  if (merged === null) {
    return JournalSave.conflict;
  }
  writeAtomic(file, merged);
  return now === base ? JournalSave.saved : JournalSave.merged;
}
