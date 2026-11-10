// `/`: find any row on the rail, folded ones and For later included. Three
// kinds of words get their own reading, because they are how work is named
// out loud: a task number (AUG-0023, 23), a GitHub number (#123), and a
// person (@jane: whoever wrote on the thread in Slack or GitHub, or whom it
// waits on). Everything else matches the title first, then the content.

import { SECTION_TITLES, type RailItem, type RailSection } from "./rail";
import { taskRef } from "./store";
import { Channel, Kind, type MessageRow } from "./types";

interface Person {
  // null: a name typed by hand (waiting on), with no account behind it.
  channel: Channel | null;
  handle: string;
  name: string;
}

interface Content {
  text: string;
  why: string;
}

export interface SearchDoc {
  item: RailItem;
  section: string;
  // Rail order, for ties.
  order: number;
  taskId: number | null;
  title: string;
  // owner/repo#N for every GitHub thread it touches.
  numbers: { n: number; where: string }[];
  people: Person[];
  content: Content[];
}

export interface SearchHit {
  item: RailItem;
  section: string;
  title: string;
  // What matched, when it was not the title (a person, a PR, the summary).
  why: string | null;
}

const GITHUB_THREAD = /^github:([^#:]+)#(\d+)$/;
const GITHUB_URL = /github\.com\/([^/]+\/[^/]+)\/(?:pull|issues)\/(\d+)/;

function githubNumber(
  threadKey: string | null,
  url: string | null,
): { n: number; where: string } | null {
  const m = threadKey?.match(GITHUB_THREAD) ?? url?.match(GITHUB_URL);
  return m ? { n: Number(m[2]), where: `${m[1]}#${m[2]}` } : null;
}

function personOf(m: MessageRow): Person | null {
  if (m.from_me || m.channel === Channel.owner) return null;
  // GitHub's stand-in when the notification names nobody.
  if (m.channel === Channel.github && m.author === "github") return null;
  return {
    channel: m.channel,
    handle: m.author,
    name: m.author_name || m.author,
  };
}

function uniq<T>(list: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((t) => {
    const k = key(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function titleOf(item: RailItem): string {
  switch (item.type) {
    case "task":
      return item.task.kind === Kind.home ? "Home" : item.task.title;
    case "project":
      return item.project.name;
    case "idea":
      return item.idea.title;
    case "fyi":
      return `${item.message.author_name}: ${item.message.body.replace(/\s+/g, " ")}`;
  }
}

// messages: what is filed to each task on the rail, for its people and words.
export function searchIndex(
  sections: RailSection[],
  messages: Map<number, MessageRow[]>,
): SearchDoc[] {
  const docs: SearchDoc[] = [];
  for (const s of sections) {
    for (const item of s.items) {
      const base = {
        item,
        section: SECTION_TITLES[s.section],
        order: docs.length,
        title: titleOf(item),
      };
      switch (item.type) {
        case "task": {
          const t = item.task;
          const filed = messages.get(t.id) ?? [];
          const people = filed.map(personOf).filter((p): p is Person => !!p);
          if (t.waiting_on)
            people.push({
              channel: null,
              handle: t.waiting_on,
              name: t.waiting_on,
            });
          docs.push({
            ...base,
            taskId: t.id,
            numbers: uniq(
              [
                githubNumber(t.thread_key, t.url),
                ...filed.map((m) => githubNumber(m.thread_key, m.url)),
              ].filter((n): n is { n: number; where: string } => !!n),
              (n) => n.where,
            ),
            people: uniq(people, (p) => `${p.channel}:${p.handle}`),
            content: [
              { text: t.summary, why: "summary" },
              { text: t.agent_says ?? "", why: "agent says" },
              {
                text: [t.repo, t.branch].filter(Boolean).join(" "),
                why: "repo",
              },
              ...filed.map((m) => ({
                text: `${m.title} ${m.body}`,
                why: `${m.channel} message`,
              })),
            ].filter((c) => c.text),
          });
          break;
        }
        case "fyi": {
          const m = item.message;
          const who = personOf(m);
          const n = githubNumber(m.thread_key, m.url);
          docs.push({
            ...base,
            taskId: null,
            numbers: n ? [n] : [],
            people: who ? [who] : [],
            content: [
              { text: `${m.title} ${m.body}`, why: `${m.channel} message` },
            ],
          });
          break;
        }
        case "idea":
          docs.push({
            ...base,
            taskId: item.idea.task_id,
            numbers: [],
            people: [],
            content: [{ text: item.idea.body, why: "idea" }],
          });
          break;
        case "project":
          docs.push({
            ...base,
            taskId: null,
            numbers: [],
            people: [],
            content: [
              { text: item.project.tmux_session, why: "tmux session" },
              { text: item.repos.join(" "), why: "repo" },
            ],
          });
          break;
      }
    }
  }
  return docs;
}

// One word's best match on a row: lower is better, null is none.
interface Match {
  score: number;
  why: string | null;
}

// 0 begins the text, 1 begins a word in it, 2 is inside it.
function textScore(text: string, word: string): number | null {
  const t = text.toLowerCase();
  if (t.startsWith(word)) return 0;
  const at = t.indexOf(word);
  if (at === -1) return null;
  for (let i = at; i !== -1; i = t.indexOf(word, i + 1))
    if (!/[a-z0-9]/.test(t[i - 1])) return 1;
  return 2;
}

function personWhy(p: Person): string {
  if (p.channel === Channel.github) return `github @${p.handle}`;
  if (p.channel === Channel.slack) return `slack ${p.name}`;
  return `waiting on ${p.name}`;
}

function personMatch(doc: SearchDoc, word: string, base: number): Match | null {
  let best: Match | null = null;
  for (const p of doc.people) {
    const scores = [textScore(p.name, word), textScore(p.handle, word)].filter(
      (n): n is number => n !== null,
    );
    if (scores.length === 0) continue;
    const s = Math.min(...scores);
    if (!best || base + s < best.score)
      best = { score: base + s, why: personWhy(p) };
  }
  return best;
}

function better(a: Match | null, b: Match | null): Match | null {
  if (!a) return b;
  if (!b) return a;
  return b.score < a.score ? b : a;
}

function wordMatch(doc: SearchDoc, raw: string): Match | null {
  const word = raw.toLowerCase();

  // @someone: only people.
  if (word.startsWith("@")) {
    const who = word.slice(1);
    return who ? personMatch(doc, who, 0) : { score: 0, why: null };
  }

  // #123: a GitHub issue or PR first, a task number after.
  const hash = word.match(/^#(\d+)$/);
  if (hash) {
    const n = Number(hash[1]);
    const gh = doc.numbers.find((x) => x.n === n);
    if (gh) return { score: 0, why: gh.where };
    return doc.taskId === n ? { score: 1, why: null } : null;
  }

  // AUG-0023, aug23, 23: the task number. A bare number may also be a
  // GitHub number or just a number in the words.
  const ref = word.match(/^(aug-?)?0*(\d+)$/);
  let match: Match | null = null;
  if (ref) {
    const id = doc.taskId === null ? "" : String(doc.taskId);
    const want = ref[2] || "0";
    if (id === want) match = { score: 0, why: null };
    else if (id.startsWith(want)) match = { score: 3, why: null };
    if (ref[1]) return match;
    const gh = doc.numbers.find((x) => String(x.n) === want);
    if (gh) match = better(match, { score: 1, why: gh.where });
  }

  const title = textScore(doc.title, word);
  if (title !== null) match = better(match, { score: title, why: null });
  match = better(match, personMatch(doc, word, 1));
  if (
    doc.item.type === "task" &&
    taskRef(doc.item.task.id).toLowerCase().includes(word)
  )
    match = better(match, { score: 2, why: null });
  for (const n of doc.numbers)
    if (n.where.toLowerCase().includes(word))
      match = better(match, { score: 3, why: n.where });
  for (const c of doc.content) {
    const s = textScore(c.text, word);
    if (s !== null) match = better(match, { score: 4 + s, why: c.why });
  }
  return match;
}

// Every word must match somewhere. Best total first, rail order on ties; no
// words lists the rail as it stands.
export function search(
  docs: SearchDoc[],
  query: string,
  limit = 50,
): SearchHit[] {
  const words = query.trim().split(/\s+/).filter(Boolean);
  const scored: { doc: SearchDoc; score: number; why: string[] }[] = [];
  for (const doc of docs) {
    let score = 0;
    const why: string[] = [];
    let all = true;
    for (const w of words) {
      const m = wordMatch(doc, w);
      if (!m) {
        all = false;
        break;
      }
      score += m.score;
      if (m.why && !why.includes(m.why)) why.push(m.why);
    }
    if (all) scored.push({ doc, score, why });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.doc.order - b.doc.order)
    .slice(0, limit)
    .map(({ doc, why }) => ({
      item: doc.item,
      section: doc.section,
      title: doc.title,
      why: why.length ? why.join(" · ") : null,
    }));
}
