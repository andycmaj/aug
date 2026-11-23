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

function copyOf(v: StoryRow | null, taskId: number): Omit<StoryRow, "id" | "at" | "by"> {
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
export function pin(taskId: number, line: string, off = false): StoryRow | null {
  const text = line.trim();
  if (!text) return null;
  const cur = store.currentStory(taskId);
  const pinned = lines(cur?.pinned ?? "");
  const has = pinned.includes(text);
  if (off ? !has : has) return null;
  const next = off ? pinned.filter((p) => p !== text) : [...pinned, text];
  return store.addStory({ ...copyOf(cur, taskId), by: "owner", pinned: next.join("\n") });
}

// The version before the current one made current again, as a new row so
// the bad one stays in the history. Pins stay as they are now: undoing a
// rewrite never takes back what the owner wrote.
export function undoStory(taskId: number): StoryRow | null {
  const [cur, before] = store.storiesFor(taskId);
  if (!cur || !before) return null;
  return store.addStory({ ...copyOf(before, taskId), by: "undo", pinned: cur.pinned });
}

const SECTIONS: [keyof StoryRow, string][] = [
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
    if (!items.length) return [];
    return [`${label}:\n${items.map((i) => `- ${i}`).join("\n")}`];
  }).join("\n\n");
}

// The story as an agent's brief or riker-tools reads it, with when.
export function storyBlock(taskId: number): string | null {
  const v = store.currentStory(taskId);
  if (!v) return null;
  const text = storyText(v);
  if (!text) return null;
  return `Story so far (as of ${v.at.slice(0, 16).replace("T", " ")}, by ${v.by}):\n\n${text}`;
}
