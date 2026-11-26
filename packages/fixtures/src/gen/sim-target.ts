// The generator on the offline sim: every move is a sim event on its state
// file, so the running sim hears it as it hears `bun run sim:do`. The sim
// makes each PR's diff from its own checkout, so a change's files are not
// used here, only its words.

import { applyToFile } from "../sim/events";
import { loadState, PullState as SimPullState, SIM_TEAM } from "../sim/github";
import { Ask, PrState, Verdict, type GenPr } from "./plan";
import type { Change, GenTarget, Opened } from "./target";

export const GEN_AUTHOR = "riker-gen";

const STATE: Record<string, PrState> = {
  [SimPullState.open]: PrState.open,
  [SimPullState.merged]: PrState.merged,
  [SimPullState.closed]: PrState.closed,
};

export function simTarget(file: string): GenTarget {
  const event = (e: Parameters<typeof applyToFile>[1]) => applyToFile(file, e);
  return {
    name: "sim",
    hasTeam: true,
    async list() {
      const s = loadState(file);
      return s.pulls
        .filter((p) => p.author === GEN_AUTHOR)
        .map((p): GenPr => {
          const mine = p.reviews.filter((r) => r.user === s.me).at(-1);
          return {
            number: p.number,
            url: `https://github.com/${s.repo}/pull/${p.number}`,
            state: STATE[p.state] ?? PrState.open,
            updatedAt: p.updatedAt,
            pushedAt: p.headCommittedAt,
            mine: mine ? { verdict: mine.state as Verdict, at: mine.at } : null,
            repliedAt: null,
          };
        });
    },
    async open(change: Change, ask: Ask): Promise<Opened> {
      const done = event({
        type: "pr-open",
        by: GEN_AUTHOR,
        title: change.title,
        body: change.body,
        ...(ask === Ask.team ? { team: SIM_TEAM } : {}),
      });
      const p = done.opened!;
      return {
        number: p.number,
        url: `https://github.com/${loadState(file).repo}/pull/${p.number}`,
      };
    },
    async followUp(pr, _change, reply) {
      event({ type: "push", pr, by: GEN_AUTHOR });
      event({ type: "comment", pr, by: GEN_AUTHOR, body: reply });
      event({ type: "rerequest", pr, by: GEN_AUTHOR });
    },
    async reply(pr, body) {
      event({ type: "comment", pr, by: GEN_AUTHOR, body });
    },
    async tag(pr, body) {
      event({ type: "mention", pr, by: GEN_AUTHOR, body });
    },
    async rerequest(pr) {
      event({ type: "rerequest", pr, by: GEN_AUTHOR });
    },
    async merge(pr) {
      event({ type: "merge", pr, by: GEN_AUTHOR });
    },
    async close(pr) {
      event({ type: "close", pr, by: GEN_AUTHOR });
    },
  };
}
