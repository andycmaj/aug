// One tick of the generator: read its PRs, plan, act, and keep what it must
// remember (when it last opened one, whom it asks next, where it is in the
// donor's history, the bugs it planted) in a state file beside its config.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Ask, DEFAULT_LIMITS, nextAsk, plan, type GenPr, type Limits, type Move } from "./plan";
import type { Change, GenTarget } from "./target";

export interface GenState {
  lastOpened: string | null;
  nextAsk: Ask;
  // Where the donor's history is read from next.
  cursor: number;
  // PR number -> when it last answered a comment review.
  replied: Record<string, string>;
  // What --plant put in, for checking a guide's findings against.
  planted: { pr: number; url: string; path: string; line: number; what: string; at: string }[];
  log: { at: string; line: string }[];
}

export const EMPTY_STATE: GenState = {
  lastOpened: null,
  nextAsk: Ask.me,
  cursor: 0,
  replied: {},
  planted: [],
  log: [],
};

export function loadGenState(file: string): GenState {
  if (!existsSync(file)) return structuredClone(EMPTY_STATE);
  return { ...structuredClone(EMPTY_STATE), ...(JSON.parse(readFileSync(file, "utf8")) as Partial<GenState>) };
}

export function saveGenState(file: string, state: GenState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...state, log: state.log.slice(-200) }, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

// Where a new PR's change comes from. `planted` says where a --plant change
// hid its bug.
export interface Changes {
  next(state: GenState): Promise<{ change: Change; planted?: { path: string; line: number; what: string } } | null>;
}

const REPLIES = [
  "Thanks, good catches. Addressed in the latest push; could you take another look?",
  "Fixed what you pointed out, and tidied the rest while I was there. Another look?",
];
const ANSWERS = [
  "Thanks for the notes. Answered inline; happy to change anything you feel strongly about.",
  "Good questions. I've replied on each; nothing blocking from my side.",
];

export interface TickResult {
  moves: Move[];
  said: string[];
}

// Moves the plan made, or the ones asked for (`gen once`).
export async function tick(
  target: GenTarget,
  state: GenState,
  changes: Changes,
  opts: { now?: Date; limits?: Limits; moves?: Move[] } = {},
): Promise<TickResult> {
  const now = opts.now ?? new Date();
  const prs: GenPr[] = (await target.list()).map((p) => ({ ...p, repliedAt: state.replied[p.number] ?? null }));
  const moves =
    opts.moves ??
    plan(prs, { now, lastOpened: state.lastOpened, nextAsk: state.nextAsk, hasTeam: target.hasTeam }, opts.limits ?? DEFAULT_LIMITS);
  const said: string[] = [];
  const say = (line: string) => {
    said.push(line);
    state.log.push({ at: now.toISOString(), line });
  };
  for (const move of moves) {
    try {
      switch (move.type) {
        case "open": {
          const next = await changes.next(state);
          if (!next) {
            say("nothing left to open a PR from");
            break;
          }
          const ask = target.hasTeam ? move.ask : Ask.me;
          const opened = await target.open(next.change, ask);
          state.lastOpened = now.toISOString();
          state.nextAsk = nextAsk(ask);
          if (next.planted)
            state.planted.push({ pr: opened.number, url: opened.url, ...next.planted, at: now.toISOString() });
          say(`opened #${opened.number} (${next.change.source}), asking ${ask === Ask.team ? "the team" : "you"}: ${opened.url}`);
          break;
        }
        case "follow-up": {
          const next = await changes.next(state);
          const change = next?.change ?? {
            title: "Address review",
            body: "",
            files: [{ path: `riker-gen/followups/${move.pr}.md`, content: `Addressed review at ${now.toISOString()}\n` }],
            source: "a note",
          };
          await target.followUp(move.pr, { ...change, title: `Address review: ${change.title}` }, REPLIES[move.pr % REPLIES.length]!);
          say(`#${move.pr}: pushed a follow-up (${change.source}) and asked you again`);
          break;
        }
        case "reply":
          await target.reply(move.pr, ANSWERS[move.pr % ANSWERS.length]!);
          state.replied[move.pr] = now.toISOString();
          say(`#${move.pr}: answered your comments`);
          break;
        case "merge":
          await target.merge(move.pr);
          say(`#${move.pr}: merged after your approval`);
          break;
        case "close":
          await target.close(move.pr);
          say(`#${move.pr}: closed, untouched for a week`);
          break;
      }
    } catch (error) {
      say(`${move.type}${"pr" in move ? ` #${move.pr}` : ""} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { moves, said };
}
