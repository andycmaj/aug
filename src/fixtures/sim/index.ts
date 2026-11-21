// `bun run sim`: the real aug on a scratch home, polling a fake GitHub
// (./github.ts) instead of gh. Triage, PR status, the rail, `aug-tools
// feedback` and nudges all run unchanged; `bun run sim:do` from another
// terminal (or a scenario) makes things happen on it. Never a real GitHub
// call: the api, the PR batch and Send are all the sim's.

import { watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setBrain, type BrainCall, type BrainResult } from "../../core/brain";
import { DEFAULT_CONFIG, fixedConfig } from "../../core/config";
import { openDb, useDb } from "../../core/db";
import { ensureDocs } from "../../core/docs";
import { Engine } from "../../core/engine";
import { configureLog, logger } from "../../core/log";
import { setMux, TmuxMux } from "../../core/mux";
import { setSender } from "../../core/outbound";
import { taskPr } from "../../core/pr";
import { paths } from "../../core/paths";
import * as store from "../../core/store";
import { Kind, type TaskRow } from "../../core/types";
import { demoBrain, demoHome } from "../demo";
import { makeCheckout, repoRoot, worktreeFor } from "./checkout";
import { applyEvent, playScenario, SCENARIOS } from "./events";
import { linkOpened, POINTER } from "./link";
import {
  emptyState,
  loadState,
  saveState,
  simApi,
  simPrFetch,
  SIM_REPO,
  statePath,
  type SimState,
} from "./github";

const log = logger("sim");

export const SimBrain = { fake: "fake", haiku: "haiku" } as const;
export type SimBrain = (typeof SimBrain)[keyof typeof SimBrain];

export interface SimOptions {
  brain: SimBrain;
  scenario?: string;
}

function seed(file: string): SimState {
  const source = repoRoot(dirname(fileURLToPath(import.meta.url)));
  const checkout = makeCheckout(source, paths.home());
  const work = store.createTask({
    title: "Simulated work on the aug checkout",
    summary:
      "A coding task on a scratch clone of aug (no remote: nothing pushes). Its branch is a few real commits ahead of main; `bun run sim:do pr-open --mine` opens its PR.",
    kind: Kind.coding,
    repo: SIM_REPO,
    branch: checkout.work.branch,
    channel: "github",
    triageReason: "seeded by the sim",
  });
  store.updateTask(work.id, { worktree: checkout.work.path });
  const s = emptyState({
    checkout: checkout.path,
    base: checkout.base,
    commits: checkout.commits,
    work: { taskId: work.id, ...checkout.work },
  });
  saveState(file, s);
  return s;
}

// The demo's canned brain, but triage names a task after what it is about
// rather than "A demo ask".
async function simBrain(call: BrainCall): Promise<BrainResult> {
  const result = await demoBrain(call);
  const where = call.prompt.match(/^Where: (.+)$/m)?.[1];
  const props = call.schema?.properties ?? {};
  if (!("verdict" in props) || !where || typeof result.structured !== "object")
    return result;
  const title = where
    .replace(/^\S+ (PR|issue): /, "")
    .replace(/ \([^)]*\)$/, "");
  return { ...result, structured: { ...result.structured, title } };
}

// A task about a sim PR starts in a worktree on that PR's branch, so an
// agent (or a task action) has a real diff in front of it.
function simCwd(task: TaskRow, file: string): string | null {
  if (task.worktree) return task.worktree;
  const pr = taskPr(task);
  const s = loadState(file);
  const pull =
    pr?.repo === s.repo ? s.pulls.find((p) => p.number === pr.number) : null;
  if (!pull || !s.checkout) return null;
  const path = worktreeFor(s.checkout, paths.home(), pull.head);
  store.updateTask(task.id, { worktree: path });
  return path;
}

export function installSim(opts: SimOptions): {
  engine: Engine;
  started: () => void;
} {
  if (opts.scenario && !SCENARIOS[opts.scenario])
    throw new Error(
      `no scenario "${opts.scenario}" (one of ${Object.keys(SCENARIOS).join(", ")})`,
    );
  process.env.AUG_HOME = demoHome(process.env, "aug-sim-");
  useDb(openDb());
  ensureDocs();
  const file = statePath(paths.home());
  // The onboarding interview is not what the sim is for.
  store.kvSet("onboard.offered", new Date().toISOString());
  const state = loadState(file).checkout ? loadState(file) : seed(file);
  writeFileSync(POINTER, `${paths.home()}\n`);

  const haiku = opts.brain === SimBrain.haiku;
  const config = fixedConfig({
    ...DEFAULT_CONFIG,
    github: {
      ...DEFAULT_CONFIG.github,
      enabled: true,
      pollSeconds: 10,
      repos: { [SIM_REPO]: state.checkout ?? "" },
    },
    slack: { ...DEFAULT_CONFIG.slack, enabled: false },
    brain: haiku
      ? {
          triageModel: "haiku",
          agentModel: "haiku",
          assistantModel: "haiku",
          slackModel: "haiku",
        }
      : DEFAULT_CONFIG.brain,
    spend: haiku ? { capEnabled: true, dailyUsd: 2 } : DEFAULT_CONFIG.spend,
    autostart: false,
    tmuxSocket: "aug-sim",
    log: { enabled: true, level: "info" },
  });
  configureLog(() => config.get().log);
  setMux(new TmuxMux(config.get().tmuxSocket));
  if (!haiku) setBrain(simBrain);
  // Send lands on the sim's GitHub as the owner's own doing.
  setSender(async (action) => {
    if (action.type === "slack_reply")
      return "the sim has no Slack: nothing was sent";
    const done = (() => {
      const s = loadState(file);
      const pr = action.number;
      const said = [
        applyEvent(s, { type: "comment", pr, by: s.me, body: action.body })
          .said,
      ];
      if (action.close === "approve")
        said.push(
          applyEvent(s, {
            type: "review",
            pr,
            by: s.me,
            verdict: "approve",
            comments: 0,
            body: action.body,
          }).said,
        );
      if (action.close === "merge")
        said.push(applyEvent(s, { type: "merge", pr, by: s.me }).said);
      saveState(file, s);
      return said.join("; ");
    })();
    return `sim: ${done}`;
  });
  const fake = fileURLToPath(new URL("../fake-claude.ts", import.meta.url));
  const engine = new Engine({
    config,
    noWorktrees: true,
    github: { api: simApi(file), prs: simPrFetch(file) },
    launchOverride: (task, launch) => {
      const cwd = simCwd(task, file) ?? launch.cwd;
      const argv = haiku
        ? [launch.argv[0], "--model", "haiku", ...launch.argv.slice(1)]
        : [process.execPath, fake, task.title];
      return { ...launch, cwd, argv };
    },
  });

  const started = () => {
    // A write to the state file is heard now, not on the next poll.
    let timer: ReturnType<typeof setTimeout> | null = null;
    watch(dirname(file), () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void engine.pollGithub(true), 300);
    });
    if (opts.scenario)
      void playScenario(opts.scenario, file, {
        onApplied: (done) => {
          log.info("scenario", { said: done.said });
          linkOpened(loadState(file), done);
        },
      }).catch((err) => log.error("scenario failed", { err }));
  };
  return { engine, started };
}
