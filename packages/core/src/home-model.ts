// Which model answers a Home turn. Cache writes are most of what the
// Assistant costs, and a cheaper model writes the same context for a
// fraction of it, so a turn that is one short move or lookup runs on
// config.brain.assistantSimpleModel (off when empty) and everything else on
// assistantModel. The prompt cache is per model: a resumed session keeps
// the model it started on, and only a turn that needs the full model leaves
// a session on the simple one for a new session that reads the talk back
// (docs/assistant-lifecycle.md).

import { REF_WORD } from "./brand";
import { lastDenials } from "./capabilities";
import type { RikerConfig } from "./config";
import { mentionedProjects } from "./mentions";
import { TurnRole, type SessionRow, type TurnRow } from "./types";

// Longest owner line a simple turn may be.
export const SIMPLE_MAX_CHARS = 100;

const REF = new RegExp(`@?\\b${REF_WORD}-\\d{1,6}\\b`, "gi");

// Words that ask for judgment, planning or writing: the full model's work
// even in a short line.
const NEEDS_THOUGHT =
  /\b(plan|project|brief|goals?|why|how come|explain|review|draft|reply|write|design|think|should|could|would|compare|summari[sz]e|break (it )?down|idea|suggest|prioriti[sz]e|and then|also|after that)\b/;

const MOVE_VERB =
  "(?:start|stop|done|finish|close|pause|resume|reopen|later|win)";

const SIMPLE: readonly RegExp[] = [
  // start RIKER-0012, stop the agent on RIKER-0012, done RIKER-0012
  new RegExp(
    `^(?:mark |set )?${MOVE_VERB}(?: (?:the )?(?:agent|work|task) (?:on|for))? REF(?: (?:now|done|later|urgent))?$`,
  ),
  // mark RIKER-0012 done, RIKER-0012 is done
  /^(?:mark |set )?REF (?:is |as )?(?:done|finished|later|urgent)$/,
  // what is waiting, what's running, what needs me
  /^(?:what(?:'s| is| are)?|whats|show(?: me)?|list)(?: (?:is|are|me|my))? (?:still )?(?:waiting|open|running|working|blocked|due|urgent|in flight|tasks|work|on my plate|needs me|need me)(?: (?:on|for) me)?(?: now| today| right now)?$/,
  /^(?:status|what's up|whats up|what's new|whats new|anything new)$/,
  // show RIKER-0012, where is RIKER-0012 at
  /^(?:show(?: me)?|what's|whats|what is|where is|where's|status of|how is|how's) REF(?: at| doing| up to)?$/,
  /^REF$/,
  // make a task called Fix the flaky test
  /^(?:make|create|add|file|new)(?: me)?(?: a)?(?: new)? task(?: (?:called|titled|named))?(?::)? \S.{0,79}$/,
];

const POLITE =
  /^(?:please|pls|hey|ok|okay|can you|could you)\s+|\s+(?:please|pls|thanks|thank you)$/g;

// The owner's words since the last answer, when they are one short line
// that is a single move or lookup naming no project: what the simple model
// can do as well as the full one.
export function simpleAsk(turns: TurnRow[]): boolean {
  if (lastDenials(turns).length) {
    return false;
  }
  const last = turns.findLastIndex((t) => t.role === TurnRole.agent);
  const fresh = turns.slice(last + 1);
  if (fresh.length !== 1 || fresh[0].role !== TurnRole.you) {
    return false;
  }
  const said = fresh[0].body.trim();
  if (!said || said.length > SIMPLE_MAX_CHARS || said.includes("\n")) {
    return false;
  }
  if (mentionedProjects(said).length) {
    return false;
  }
  if ((said.match(REF) ?? []).length > 1) {
    return false;
  }
  const line = said
    .toLowerCase()
    .replace(/[.!?\s]+$/, "")
    .replace(POLITE, "")
    .replace(POLITE, "")
    .replace(REF, "REF")
    .replace(/\s+/g, " ");
  if (NEEDS_THOUGHT.test(line.replace(/\bREF\b/g, ""))) {
    return false;
  }
  return SIMPLE.some((re) => re.test(line));
}

export interface HomeModel {
  model: string;
  // Why the session it would resume is left behind, or null.
  leave: string | null;
  simple: boolean;
}

// `session` is the session the turn would resume, after leaveSession had
// its say; null when it starts a new one anyway.
export function homeModel(
  config: RikerConfig,
  turns: TurnRow[],
  session: SessionRow | null,
): HomeModel {
  const full = config.brain.assistantModel;
  const cheap = config.brain.assistantSimpleModel ?? "";
  const simple = cheap !== "" && simpleAsk(turns);
  const want = simple ? cheap : full;
  if (!session) {
    return { model: want, leave: null, simple };
  }
  const was = session.model ?? full;
  if (was === want) {
    return { model: want, leave: null, simple };
  }
  // A warm session on the full model answers a simple turn cheaper than a
  // new one would write its context on the simple model.
  if (simple) {
    return { model: was, leave: null, simple };
  }
  return { model: want, leave: `model ${was} to ${want}`, simple };
}
