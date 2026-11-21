// `bun run sim:do <event>`: make something happen on the running sim's
// GitHub from another terminal. It writes the sim's state file; the sim
// hears the write and polls (ctrl+r does too). Plain TS, no Solid.

import { existsSync, readFileSync } from "node:fs";
import { defineCommand, runMain } from "citty";
import { openDb, useDb } from "../../core/db";
import {
  applyToFile,
  playScenario,
  SCENARIOS,
  Verdict,
  type Applied,
  type SimEvent,
} from "./events";
import { loadState, statePath } from "./github";
import { linkOpened, POINTER } from "./link";

function simHome(named?: string): string {
  const home =
    named ||
    process.env.AUG_SIM_HOME ||
    (existsSync(POINTER) ? readFileSync(POINTER, "utf8").trim() : "");
  if (!home || !existsSync(statePath(home))) {
    console.error(
      "sim:do: no sim running (start one with bun run sim, or pass --home)",
    );
    process.exit(2);
  }
  return home;
}

const common = {
  home: {
    type: "string",
    description: "the sim's AUG_HOME (default: the one running now)",
  },
  pr: {
    type: "string",
    description: "PR number (default: the newest open one)",
  },
  by: {
    type: "string",
    description: "who does it (a GitHub login; you is the owner)",
  },
} as const;

function apply(args: { home?: string }, event: SimEvent): void {
  const home = simHome(args.home);
  const file = statePath(home);
  const done = applyToFile(file, event);
  report(home, file, done);
}

// The owner's PR is the work task's, as `aug-tools pr` links it.
function report(home: string, file: string, done: Applied): void {
  if (done.opened) {
    process.env.AUG_HOME = home;
    useDb(openDb());
    linkOpened(loadState(file), done);
  }
  console.log(done.said);
}

const pr = (v: string | undefined) => (v ? Number(v) : undefined);

const prOpen = defineCommand({
  meta: {
    name: "pr-open",
    description:
      "open a PR: by a reviewer asking yours, or --mine from the work task",
  },
  args: {
    home: common.home,
    by: common.by,
    title: { type: "string", description: "its title" },
    mine: {
      type: "boolean",
      description: "your own PR, from the sim's work task branch",
    },
    reviewer: {
      type: "string",
      description: "whose review it asks (default: you, or alice for --mine)",
    },
  },
  run({ args }) {
    apply(args, {
      type: "pr-open",
      by: args.by,
      title: args.title,
      mine: args.mine,
      reviewer: args.reviewer,
    });
  },
});

const said = (type: "comment" | "mention") =>
  defineCommand({
    meta: {
      name: type,
      description:
        type === "comment" ? "comment on a PR" : "comment on a PR tagging you",
    },
    args: { ...common, body: { type: "string", description: "what it says" } },
    run({ args }) {
      apply(args, { type, pr: pr(args.pr), by: args.by, body: args.body });
    },
  });

const review = defineCommand({
  meta: {
    name: "review",
    description: "review a PR, with line comments on files of its diff",
  },
  args: {
    ...common,
    verdict: {
      type: "string",
      default: "comment",
      description: "approve | changes | comment",
    },
    comments: {
      type: "string",
      description: "how many line comments (default 2, 0 for approve)",
    },
    body: { type: "string", description: "the review's summary" },
  },
  run({ args }) {
    const verdict = args.verdict as Verdict;
    if (!Object.values(Verdict).includes(verdict)) {
      console.error(
        `sim:do review: --verdict is approve, changes or comment, not ${args.verdict}`,
      );
      process.exit(2);
    }
    const comments =
      args.comments === undefined ? undefined : Number(args.comments);
    apply(args, {
      type: "review",
      pr: pr(args.pr),
      by: args.by,
      verdict,
      comments,
      body: args.body,
    });
  },
});

const ci = defineCommand({
  meta: {
    name: "ci",
    description: "set a PR's checks: ci fail | ci pass | ci pending",
  },
  args: {
    home: common.home,
    pr: common.pr,
    result: { type: "positional", required: true },
  },
  run({ args }) {
    const result = String(args.result);
    if (result !== "fail" && result !== "pass" && result !== "pending") {
      console.error(`sim:do ci: fail, pass or pending, not ${result}`);
      process.exit(2);
    }
    apply(args, { type: "ci", pr: pr(args.pr), result });
  },
});

const push = defineCommand({
  meta: {
    name: "push",
    description: "push to a PR: a new head commit, checks running again",
  },
  args: { home: common.home, pr: common.pr, by: common.by },
  run({ args }) {
    apply(args, { type: "push", pr: pr(args.pr), by: args.by });
  },
});

const merge = defineCommand({
  meta: { name: "merge", description: "merge a PR" },
  args: { home: common.home, pr: common.pr, by: common.by },
  run({ args }) {
    apply(args, { type: "merge", pr: pr(args.pr), by: args.by });
  },
});

const play = defineCommand({
  meta: {
    name: "play",
    description: `play a scenario: ${Object.keys(SCENARIOS).join(", ")}`,
  },
  args: {
    home: common.home,
    scenario: { type: "positional", required: true },
    speed: {
      type: "string",
      default: "1",
      description: "multiply the waits (0.5 is twice as fast)",
    },
  },
  async run({ args }) {
    const home = simHome(args.home);
    const file = statePath(home);
    await playScenario(String(args.scenario), file, {
      speed: Number(args.speed),
      onApplied: (done) => report(home, file, done),
    });
  },
});

const state = defineCommand({
  meta: { name: "state", description: "print the sim's PRs and what happened" },
  args: { home: common.home },
  run({ args }) {
    const s = loadState(statePath(simHome(args.home)));
    for (const p of s.pulls)
      console.log(
        `#${p.number} ${p.state.toLowerCase()} by ${p.author} (${p.head}) ${p.title} · checks ${p.checks.map((c) => c.conclusion ?? c.status).join(",") || "none"} · reviews ${p.reviews.map((r) => `${r.user}:${r.state}`).join(",") || "none"}`,
      );
    for (const l of s.log.slice(-10))
      console.log(`${l.at.slice(11, 19)} ${l.line}`);
  },
});

await runMain(
  defineCommand({
    meta: {
      name: "sim:do",
      description: "make something happen on the sim's GitHub",
    },
    subCommands: {
      "pr-open": prOpen,
      comment: said("comment"),
      mention: said("mention"),
      review,
      ci,
      push,
      merge,
      play,
      state,
    },
  }),
);
