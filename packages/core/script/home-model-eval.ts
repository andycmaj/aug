// Real Home asks on two models, each on a new session in a scratch
// RIKER_HOME seeded the same way, to compare what they answer, what they
// did and what they cost before config.brain.assistantSimpleModel goes on by
// default (core/home-model.ts). Costs tokens: every ask is a real
// `claude -p` per model.
//
//   bun packages/core/script/home-model-eval.ts [--models haiku,sonnet] [--out file.json] [ask ...]
//
// Only the Assistant's calls reach claude; a move that would start a task's
// agent gets a canned answer.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { AgentPool } from "../src/agents";
import { claudeBrain, setBrain, type BrainResult } from "../src/brain";
import { DEFAULT_CONFIG, fixedConfig } from "../src/config";
import { openDb, useDb } from "../src/db";
import { ensureDocs } from "../src/docs";
import { Engine } from "../src/engine";
import { simpleAsk } from "../src/home-model";
import { setMux } from "../src/mux";
import { paths } from "../src/paths";
import { setToolsEntry } from "../src/self";
import * as store from "../src/store";
import {
  AgentState,
  Kind,
  Priority,
  SpendRole,
  TaskStatus,
  TurnRole,
} from "../src/types";
import { FakeMux } from "../test/support/fake-mux";

const SAMPLE = [
  "what is waiting?",
  "what's running right now?",
  "show RIKER-0002",
  "where is RIKER-0003 at?",
  "done RIKER-0004",
  "stop RIKER-0003",
  "start RIKER-0001",
  "make a task called Rotate the GitHub token",
];

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    models: { type: "string", default: "haiku,sonnet" },
    out: { type: "string" },
  },
  allowPositionals: true,
});
const asks = positionals.length ? positionals : SAMPLE;
const models = values.models!.split(",");

setToolsEntry(resolve(import.meta.dir, "../../cli/src/riker-tools.ts"));
setMux(new FakeMux());

function seed(): void {
  const rail = store.createProject({
    name: "rail-polish",
    tmuxSession: "rail-polish",
  });
  store.createProject({ name: "billing", tmuxSession: "billing" });
  const tasks = [
    {
      title: "Reply to Sam about the release date",
      kind: Kind.general,
      state: AgentState.waiting,
      says: "Should I say Friday or next Tuesday?",
    },
    {
      title: "Fix the flaky rail twins test",
      kind: Kind.coding,
      state: AgentState.ready,
      says: "PR #41 is up, tests green",
      project: rail.id,
    },
    {
      title: "Draft Q4 roadmap notes",
      kind: Kind.general,
      state: AgentState.working,
      says: null,
    },
    {
      title: "Bump bun to 1.4",
      kind: Kind.coding,
      state: AgentState.none,
      says: null,
      later: true,
    },
    {
      title: "Review PR #38: one-pager on Home",
      kind: Kind.task,
      state: AgentState.none,
      says: null,
      urgent: true,
    },
  ];
  for (const t of tasks) {
    const row = store.createTask({
      title: t.title,
      kind: t.kind,
      channel: "owner",
      projectId: t.project ?? null,
      priority: t.urgent ? Priority.urgent : undefined,
    });
    store.updateTask(row.id, {
      agent_state: t.state,
      agent_says: t.says,
      ...(t.later ? { status: TaskStatus.later } : {}),
    });
  }
}

interface Run {
  model: string;
  ask: string;
  simple: boolean;
  answer: string;
  steps: string[];
  costUsd: number | null;
  usage: BrainResult["usage"] | null;
  durationMs: number;
  denied: string[];
}

async function once(model: string, ask: string): Promise<Run> {
  process.env.RIKER_HOME = mkdtempSync(join(tmpdir(), "riker-home-eval-"));
  useDb(openDb(paths.db()));
  ensureDocs();
  seed();
  const config = fixedConfig({
    ...DEFAULT_CONFIG,
    brain: {
      ...DEFAULT_CONFIG.brain,
      agentModel: "haiku",
      assistantModel: model,
    },
    autostart: false,
    spend: { capEnabled: false, dailyUsd: 0 },
  });
  let seen: BrainResult | null = null;
  setBrain(async (call) => {
    if (call.spend?.role !== SpendRole.assistant) {
      return {
        text: "on it",
        structured: null,
        sessionId: null,
        durationMs: 1,
        isError: false,
      };
    }
    seen = await claudeBrain(call);
    return seen;
  });
  const engine = new Engine({ config });
  const drain = setInterval(() => void engine.drainMoves(), 100);
  const home = store.homeTask();
  store.addTurn({
    taskId: home.id,
    role: TurnRole.you,
    author: "you",
    body: ask,
  });
  const simple = simpleAsk(store.turnsForTask(home.id));
  try {
    await new AgentPool({ config }).request(
      home.id,
      "the owner typed",
      "owner",
    );
  } finally {
    clearInterval(drain);
  }
  await engine.drainMoves();
  const turn = store
    .turnsForTask(home.id)
    .findLast((t) => t.role === TurnRole.agent);
  const result = seen as BrainResult | null;
  return {
    model,
    ask,
    simple,
    answer: turn?.body ?? "",
    steps: turn?.steps ? (JSON.parse(turn.steps) as string[]) : [],
    costUsd: result?.costUsd ?? null,
    usage: result?.usage ?? null,
    durationMs: result?.durationMs ?? 0,
    denied: result?.denied ?? [],
  };
}

const runs: Run[] = [];
for (const ask of asks) {
  for (const model of models) {
    const run = await once(model, ask);
    runs.push(run);
    console.log(
      `\n== ${model} | ${ask} | simple=${run.simple} | $${run.costUsd?.toFixed(4)} | ${run.durationMs}ms | ${JSON.stringify(run.usage)}`,
    );
    for (const s of run.steps) {
      console.log(`  step: ${s}`);
    }
    console.log(`  answer: ${run.answer.replace(/\n/g, "\n          ")}`);
  }
}

console.log("\n== totals");
for (const model of models) {
  const mine = runs.filter((r) => r.model === model);
  const cost = mine.reduce((n, r) => n + (r.costUsd ?? 0), 0);
  const ms = mine.reduce((n, r) => n + r.durationMs, 0);
  console.log(
    `${model}: ${mine.length} asks, $${cost.toFixed(4)} ($${(cost / mine.length).toFixed(4)} each), ${Math.round(ms / mine.length)}ms each`,
  );
}
if (values.out) {
  writeFileSync(values.out, JSON.stringify(runs, null, 2));
}
process.exit(0);
