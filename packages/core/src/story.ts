// A task's story: its state of play, kept beside the owner's brief and
// never in it (docs/session-digests-design.md). One row per version; the
// newest is current, so a bad one is undone by making the one before it
// current again. The owner's pinned lines ride on every version.

import { lines } from "./digests";
import * as store from "./store";
import type { DigestRow, StoryRow } from "./types";

// A new version from a finished session's digest. Goals carry forward
// unless the digest sets them; the owner's pins always do.
export function storyFromDigest(digest: DigestRow): StoryRow {
  const prev = store.currentStory(digest.task_id);
  return store.addStory({
    task_id: digest.task_id,
    digest_id: digest.id,
    by: digest.by,
    goals: digest.goals || prev?.goals || "",
    now: digest.did,
    decisions: digest.decisions,
    blocked: digest.blocked,
    next: digest.next,
    questions: digest.questions,
    pinned: prev?.pinned ?? "",
  });
}

function copyOf(
  v: StoryRow | null,
  taskId: number,
): Omit<StoryRow, "id" | "at" | "by"> {
  return {
    task_id: taskId,
    digest_id: v?.digest_id ?? null,
    goals: v?.goals ?? "",
    now: v?.now ?? "",
    decisions: v?.decisions ?? "",
    blocked: v?.blocked ?? "",
    next: v?.next ?? "",
    questions: v?.questions ?? "",
    pinned: v?.pinned ?? "",
  };
}

// The owner pins a line (a goal, a next step), or takes one off. A pin is
// a new version, so it is history like any other.
export function pin(
  taskId: number,
  line: string,
  off = false,
): StoryRow | null {
  const text = line.trim();
  if (!text) {
    return null;
  }
  const cur = store.currentStory(taskId);
  const pinned = lines(cur?.pinned ?? "");
  const has = pinned.includes(text);
  if (off ? !has : has) {
    return null;
  }
  const next = off ? pinned.filter((p) => p !== text) : [...pinned, text];
  return store.addStory({
    ...copyOf(cur, taskId),
    by: "owner",
    pinned: next.join("\n"),
  });
}

// The version before the current one made current again, as a new row so
// the bad one stays in the history. Pins stay as they are now: undoing a
// rewrite never takes back what the owner wrote.
export function undoStory(taskId: number): StoryRow | null {
  const [cur, before] = store.storiesFor(taskId);
  if (!cur || !before) {
    return null;
  }
  return store.addStory({
    ...copyOf(before, taskId),
    by: "undo",
    pinned: cur.pinned,
  });
}

type StoryField =
  | "pinned"
  | "goals"
  | "now"
  | "decisions"
  | "blocked"
  | "next"
  | "questions";

const SECTIONS: [StoryField, string][] = [
  ["pinned", "Pinned by the owner"],
  ["goals", "Goals"],
  ["now", "Now"],
  ["decisions", "Decisions"],
  ["blocked", "Blocked or waiting"],
  ["next", "Next steps"],
  ["questions", "Open questions"],
];

// Plain text, blank lines between parts, empty parts left out.
export function storyText(v: StoryRow): string {
  return SECTIONS.flatMap(([key, label]) => {
    const items = lines(String(v[key] ?? ""));
    if (!items.length) {
      return [];
    }
    return [`${label}:\n${items.map((i) => `- ${i}`).join("\n")}`];
  }).join("\n\n");
}

// The story as an agent's brief or riker-tools reads it, with when.
export function storyBlock(taskId: number): string | null {
  const v = store.currentStory(taskId);
  if (!v) {
    return null;
  }
  const text = storyText(v);
  if (!text) {
    return null;
  }
  return `Story so far (as of ${v.at.slice(0, 16).replace("T", " ")}, by ${v.by}):\n\n${text}`;
}

// The story as markdown, a heading per part: what V reads. With all, the
// empty parts too, so the owner rewriting it in $EDITOR sees every heading.
export function storyMarkdown(v: StoryRow | null, all = false): string {
  return SECTIONS.flatMap(([key, label]) => {
    const items = lines(String(v?.[key] ?? ""));
    if (!items.length && !all) {
      return [];
    }
    return [
      items.length
        ? `## ${label}\n\n${items.map((i) => `- ${i}`).join("\n")}`
        : `## ${label}`,
    ];
  }).join("\n\n");
}

const LABEL_FIELD = new Map(
  SECTIONS.map(([key, label]) => [label.toLowerCase(), key]),
);

// storyMarkdown read back: each heading names a part, each line under it
// is one item ("- " optional). A line under no heading, or under a heading
// that is not a part, is refused rather than dropped.
export function parseStory(
  text: string,
): { fields: Record<StoryField, string> } | { error: string } {
  const items = new Map<StoryField, string[]>(
    SECTIONS.map(([key]) => [key, []]),
  );
  let cur: StoryField | null = null;
  const stray: string[] = [];
  const body = text.replace(/<!--[\s\S]*?-->/g, "");
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) {
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*?)\s*:?\s*$/);
    if (heading) {
      cur = LABEL_FIELD.get(heading[1].toLowerCase()) ?? null;
      if (!cur) {
        stray.push(line);
      }
      continue;
    }
    const item = line.replace(/^[-*+]\s+/, "").trim();
    if (!cur) {
      stray.push(line);
    } else if (item) {
      items.get(cur)!.push(item);
    }
  }
  if (stray.length) {
    return {
      error: `not a part of the story: ${stray[0]}${stray.length > 1 ? ` (and ${stray.length - 1} more)` : ""}; the parts are ${SECTIONS.map(([, l]) => l).join(", ")}`,
    };
  }
  const fields = Object.fromEntries(
    [...items].map(([k, v]) => [k, v.join("\n")]),
  ) as Record<StoryField, string>;
  return { fields };
}

// The owner's rewrite as a new version, so story_undo steps back from it.
// The same parts as now is no version at all.
export function editStory(
  taskId: number,
  text: string,
): { version: StoryRow | null } | { error: string } {
  const parsed = parseStory(text);
  if ("error" in parsed) {
    return parsed;
  }
  const cur = store.currentStory(taskId);
  const same = SECTIONS.every(
    ([key]) => lines(cur?.[key] ?? "").join("\n") === parsed.fields[key],
  );
  if (same) {
    return { version: null };
  }
  return {
    version: store.addStory({
      ...copyOf(cur, taskId),
      ...parsed.fields,
      by: "owner",
    }),
  };
}
