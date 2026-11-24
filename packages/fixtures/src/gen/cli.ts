// `bun run gen`: the review activity generator, for dogfooding Riker's code
// reviews. It plays a colleague asking for the owner's review: on the
// offline sim (--target sim, the default) or on a real lab repo as a GitHub
// App (--target github, set up once with `gen setup`). `once` does one thing
// now; `stream` keeps going within its limits; `start`/`stop` run the stream
// in the background. Plain TS, no Solid.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineCommand, runMain } from "citty";
import { envVar } from "@riker/core/brand";
import { openDb, useDb } from "@riker/core/db";
import { paths } from "@riker/core/paths";
import { statePath } from "../sim/github";
import { POINTER } from "../sim/link";
import { donorCommits, nextChange } from "./donor";
import { githubTarget, type GithubGenConfig } from "./github-target";
import { Ask, DEFAULT_LIMITS, PrState, type Limits, type Move } from "./plan";
import { plant, plantable } from "./plant";
import { loadGenState, saveGenState, tick, type Changes, type GenState } from "./run";
import { simTarget } from "./sim-target";
import type { GenTarget } from "./target";

const Target = { sim: "sim", github: "github" } as const;
type Target = (typeof Target)[keyof typeof Target];

// The generator's folder: under the running sim's home for the sim, under
// Riker's home for GitHub (its config and the App's key live there).
function genDir(target: Target): string {
  if (target === Target.github) return join(paths.home(), "gen");
  const home =
    envVar("SIM_HOME") || (existsSync(POINTER) ? readFileSync(POINTER, "utf8").trim() : "");
  if (!home || !existsSync(statePath(home))) {
    console.error("gen: no sim running (start one with bun run sim), or use --target github");
    process.exit(2);
  }
  return join(home, "gen");
}

const githubConfigPath = () => join(genDir(Target.github), "github.json");

interface GenConfig extends GithubGenConfig {
  // The donor repo whose commits are replayed, and the commit the lab was
  // seeded from.
  donor: string;
  seed: string;
}

function readGithubConfig(): GenConfig {
  const file = githubConfigPath();
  if (!existsSync(file)) {
    console.error(`gen: no ${file}: run bun run gen setup first`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(file, "utf8")) as GenConfig;
}

// The donor by default is this checkout, replayed from 150 commits back.
function repoRoot(): string {
  const r = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: import.meta.dir, stdout: "pipe" });
  return r.stdout.toString().trim();
}

function setup(target: Target): { target: GenTarget; changes: (plantOn: boolean) => Changes; stateFile: string } {
  const dir = genDir(target);
  const stateFile = join(dir, `state-${target}.json`);
  const donor = target === Target.github ? readGithubConfig() : null;
  const repo = donor?.donor ?? repoRoot();
  const seed = donor?.seed ?? Bun.spawnSync(["git", "rev-parse", "HEAD~150"], { cwd: repo, stdout: "pipe" }).stdout.toString().trim();
  const commits = donorCommits(repo, seed);
  const t = donor ? githubTarget(donor) : simTarget(statePath(dirname(dir)));
  const changes = (plantOn: boolean): Changes => ({
    async next(state: GenState) {
      if (plantOn) {
        const files = Bun.spawnSync(["git", "ls-tree", "-r", "--name-only", seed], { cwd: repo, stdout: "pipe" })
          .stdout.toString()
          .split("\n")
          .filter(Boolean);
        for (let i = 0; i < files.length; i++) {
          const path = files[(state.cursor * 7 + i) % files.length]!;
          const content = Bun.spawnSync(["git", "show", `${seed}:${path}`], { cwd: repo, stdout: "pipe" }).stdout.toString();
          if (!plantable(path, content)) continue;
          state.cursor++;
          const planted = await plant(path, content);
          return { change: planted.change, planted: planted.bug };
        }
        return null;
      }
      const next = nextChange(repo, commits, state.cursor);
      if (!next) return null;
      state.cursor = next.cursor;
      return { change: next.change };
    },
  });
  return { target: t, changes, stateFile };
}

const common = {
  target: { type: "string", default: "sim", description: "sim (the offline sim that runs now) or github (the lab repo)" },
  plant: { type: "boolean", description: "haiku writes each new PR with one planted bug (costs a little)" },
} as const;

function targetOf(v: string): Target {
  if (v !== Target.sim && v !== Target.github) {
    console.error(`gen: --target is sim or github, not ${v}`);
    process.exit(2);
  }
  return v;
}

// --plant spends through Riker's brain, which records it in riker.db. The
// sim makes each PR's diff from its own commits, so a planted file would
// never reach it.
function openSpend(plantOn: boolean, target: Target): void {
  if (!plantOn) return;
  if (target !== Target.github) {
    console.error("gen: --plant needs --target github (the sim makes its diffs from its own commits)");
    process.exit(2);
  }
  useDb(openDb());
}

async function newestOpen(t: GenTarget, pr: string | undefined): Promise<number> {
  if (pr) return Number(pr);
  const open = (await t.list()).filter((p) => p.state === PrState.open).sort((a, b) => b.number - a.number);
  if (!open[0]) {
    console.error("gen: none of its PRs is open: gen once ask opens one");
    process.exit(2);
  }
  return open[0].number;
}

const once = defineCommand({
  meta: {
    name: "once",
    description: "do one thing now: ask (a PR asking you), team (asking your team), tag, rerequest, or tick (answer your reviews)",
  },
  args: {
    ...common,
    what: { type: "positional", default: "ask", description: "ask | team | tag | rerequest | tick" },
    pr: { type: "string", description: "which of its PRs (tag, rerequest; default: its newest open one)" },
  },
  async run({ args }) {
    const target = targetOf(args.target);
    openSpend(Boolean(args.plant), target);
    const { target: t, changes, stateFile } = setup(target);
    const state = loadGenState(stateFile);
    const what = String(args.what);
    let said: string[] = [];
    if (what === "ask" || what === "team") {
      const moves: Move[] = [{ type: "open", ask: what === "team" ? Ask.team : Ask.me }];
      said = (await tick(t, state, changes(Boolean(args.plant)), { moves })).said;
    } else if (what === "tag") {
      const pr = await newestOpen(t, args.pr);
      await t.tag(pr, "Hey, could you take a look at this one when you get a chance?");
      said = [`#${pr}: tagged you`];
    } else if (what === "rerequest") {
      const pr = await newestOpen(t, args.pr);
      await t.rerequest(pr);
      said = [`#${pr}: asked your review again`];
    } else if (what === "tick") {
      // Answers only: a new PR is what ask is for.
      const all = await tick(t, state, changes(false), { limits: { ...DEFAULT_LIMITS, maxOpen: 0 } });
      said = all.said.length ? all.said : ["nothing to answer"];
    } else {
      console.error(`gen once: ask, team, tag, rerequest or tick, not ${what}`);
      process.exit(2);
    }
    saveGenState(stateFile, state);
    for (const line of said) console.log(line);
  },
});

const DURATION = /^(\d+)(s|m|h)$/;
function ms(v: string): number {
  const m = DURATION.exec(v);
  if (!m) throw new Error(`a duration is like 30m, 2h or 90s, not ${v}`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"];
}

const streamArgs = {
  ...common,
  every: { type: "string", default: "30m", description: "a new PR at most this often" },
  hours: { type: "string", default: "9-18", description: "local hours it opens PRs in" },
  max: { type: "string", default: "5", description: "at most this many of its PRs open" },
} as const;

const stopFile = (target: Target) => join(genDir(target), "stop");
const pidFile = (target: Target) => join(genDir(target), `stream-${target}.pid`);

const stream = defineCommand({
  meta: { name: "stream", description: "keep going: answer your reviews, and open PRs within the limits, until gen stop" },
  args: streamArgs,
  async run({ args }) {
    const target = targetOf(args.target);
    openSpend(Boolean(args.plant), target);
    const [from, to] = args.hours.split("-").map(Number) as [number, number];
    const limits: Limits = { ...DEFAULT_LIMITS, everyMs: ms(args.every), hours: [from, to], maxOpen: Number(args.max) };
    const { target: t, changes, stateFile } = setup(target);
    rmSync(stopFile(target), { force: true });
    // Your reviews are answered within five minutes, whatever --every says.
    const wait = Math.min(limits.everyMs, 5 * 60_000);
    console.log(`gen stream on ${target}: a PR at most every ${args.every}, ${from}:00-${to}:00, at most ${limits.maxOpen} open; gen stop ends it`);
    while (!existsSync(stopFile(target))) {
      const state = loadGenState(stateFile);
      const { said } = await tick(t, state, changes(Boolean(args.plant)), { limits });
      saveGenState(stateFile, state);
      for (const line of said) console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
      for (let waited = 0; waited < wait && !existsSync(stopFile(target)); waited += 5000) await Bun.sleep(5000);
    }
    rmSync(pidFile(target), { force: true });
    console.log("gen stream stopped");
  },
});

const start = defineCommand({
  meta: { name: "start", description: "run the stream in the background (its log: gen/stream-<target>.log)" },
  args: streamArgs,
  run({ args }) {
    const target = targetOf(args.target);
    const dir = genDir(target);
    mkdirSync(dir, { recursive: true });
    const log = openSync(join(dir, `stream-${target}.log`), "a");
    const argv = [process.execPath, import.meta.path, "stream", "--target", target, "--every", args.every, "--hours", args.hours, "--max", args.max];
    if (args.plant) argv.push("--plant");
    const child = Bun.spawn(argv, { stdout: log, stderr: log, stdin: "ignore", env: process.env });
    child.unref();
    closeSync(log);
    writeFileSync(pidFile(target), `${child.pid}\n`);
    console.log(`gen stream on ${target} started (pid ${child.pid}); gen stop ends it`);
  },
});

const stop = defineCommand({
  meta: { name: "stop", description: "end the stream (it stops within five seconds)" },
  args: { target: common.target },
  run({ args }) {
    const target = targetOf(args.target);
    mkdirSync(genDir(target), { recursive: true });
    writeFileSync(stopFile(target), `${new Date().toISOString()}\n`);
    console.log(`gen stream on ${target}: asked to stop`);
  },
});

const state = defineCommand({
  meta: { name: "state", description: "its PRs, what it planted, and what it did lately" },
  args: { target: common.target },
  async run({ args }) {
    const target = targetOf(args.target);
    const { target: t, stateFile } = setup(target);
    const s = loadGenState(stateFile);
    for (const p of await t.list())
      console.log(`#${p.number} ${p.state}${p.mine ? ` · your review: ${p.mine.verdict.toLowerCase()}` : ""} · ${p.url}`);
    for (const b of s.planted) console.log(`planted #${b.pr} ${b.path}:${b.line}: ${b.what}`);
    for (const l of s.log.slice(-10)) console.log(`${l.at.slice(0, 19)} ${l.line}`);
    const pid = pidFile(target);
    console.log(existsSync(pid) ? `stream: running (pid ${readFileSync(pid, "utf8").trim()})` : "stream: not running");
  },
});

const SETUP_STEPS = (file: string) => `The GitHub target acts as a GitHub App on a lab repo, so GitHub tells you of
its asks as it would of a colleague's (it never tells you of your own).

1. Make the lab repo, seeded from this checkout 150 commits back:
     gh repo create botany-sanjuans/riker-review-lab --private
     git push git@github.com:botany-sanjuans/riker-review-lab.git "$(git rev-parse HEAD~150)":refs/heads/main
2. Make a team you are on, and give it the repo:
     github.com/orgs/botany-sanjuans/new-team: riker-reviewers, add yourself;
     the repo's Settings > Collaborators and teams: add riker-reviewers (Write).
3. Make the App (github.com/organizations/botany-sanjuans/settings/apps/new):
     name riker-review-gen, no webhook; repository permissions Contents,
     Pull requests and Issues: Read and write; organization Members: Read.
     Generate a private key; save it as ${join(dirname(file), "app.pem")} (chmod 600).
4. Install it on riker-review-lab only. The installation id is the number
   at the end of the installation's settings URL.
5. Write ${file} (chmod 600):
     { "repo": "botany-sanjuans/riker-review-lab", "appId": "<App ID>",
       "installationId": "<id>", "keyPath": "${join(dirname(file), "app.pem")}",
       "me": "<your login>", "team": "botany-sanjuans/riker-reviewers",
       "donor": "${repoRoot()}", "seed": "<the commit pushed in 1>" }
6. Add the team to Riker's config: triage.reviewTeams ["botany-sanjuans/riker-reviewers"].
7. bun run gen check --target github, then bun run gen once ask --target github.`;

const setupCmd = defineCommand({
  meta: { name: "setup", description: "the steps to set up the GitHub target (only you can do them)" },
  run() {
    console.log(SETUP_STEPS(githubConfigPath()));
  },
});

const check = defineCommand({
  meta: { name: "check", description: "check the GitHub target: config, key, token, repo, team" },
  async run() {
    const config = readGithubConfig();
    const t = githubTarget(config);
    const prs = await t.list();
    console.log(`ok: the App reads ${config.repo} (${prs.length} of its PRs); asks ${config.me}${config.team ? ` and ${config.team}` : ""}`);
  },
});

await runMain(
  defineCommand({
    meta: { name: "gen", description: "the review activity generator: PRs asking your review, for dogfooding" },
    subCommands: { once, stream, start, stop, state, setup: setupCmd, check },
  }),
);
