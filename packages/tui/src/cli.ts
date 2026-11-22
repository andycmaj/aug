import { defineCommand, runMain } from "citty";
import { envVar } from "@riker/core/brand";
import {
  claudeSettingsPath,
  hooksInstalled,
  installHooks,
  uninstallHooks,
} from "@riker/core/adopt";
import { INSTALLS, InstallState, installState } from "@riker/core/install";
import { CMD } from "@riker/core/brand";
import { loadConfig } from "@riker/core/config";
import { migrateHome, planHomeMigration } from "@riker/core/migrate-home";
import { setMux, TmuxMux } from "@riker/core/mux";
import { copyLegacyTags } from "@riker/core/projects";

export interface CLIConfig {
  // A built-in fixture name: no network, no AI, a fictional day.
  fixture?: string;
  // The offline GitHub simulator (@riker/fixtures sim): `riker sim [scenario]`.
  sim?: { scenario?: string; brain: "fake" | "haiku" };
}

let config: CLIConfig | undefined;

// These commands run here, inside parseCLI, before index.tsx moves aug's home.
// Writing first would make a fresh ~/.riker that the move then refuses to
// overwrite, so one that writes into the home moves it first, as a start does.
function moveHomeFirst(): void {
  const moved = migrateHome();
  if (moved.refuse) {
    console.error(`${CMD}: cannot move aug's home: ${moved.refuse}`);
    process.exit(1);
  }
  if (!moved.skip) console.log(moved.steps.join("\n"));
}

// Hooks in your user settings, so Riker picks up claudes you start by hand in
// a project's tmux session. Never written unless you ask.
const hooks = defineCommand({
  meta: {
    name: "hooks",
    description: "Pick up claudes you start by hand in project sessions",
  },
  subCommands: {
    install: defineCommand({
      meta: { name: "install", description: "Add Riker's hooks to your Claude settings" },
      run() {
        moveHomeFirst();
        console.log(`riker hooks added to ${installHooks()}`);
      },
    }),
    uninstall: defineCommand({
      meta: { name: "uninstall", description: "Remove Riker's hooks from your Claude settings" },
      run() {
        moveHomeFirst();
        console.log(
          uninstallHooks()
            ? `riker hooks removed from ${claudeSettingsPath()}`
            : "no riker hooks to remove",
        );
      },
    }),
    status: defineCommand({
      meta: { name: "status", description: "Whether Riker's hooks are installed" },
      run() {
        console.log(
          hooksInstalled()
            ? `installed in ${claudeSettingsPath()}`
            : "not installed (riker install hooks)",
        );
      },
    }),
  },
});

function chosen(names: string[]): string[] {
  const unknown = names.filter((n) => !(n in INSTALLS));
  if (unknown.length) {
    console.error(
      `riker: no install named ${unknown.join(", ")} (one of ${Object.keys(INSTALLS).join(", ")})`,
    );
    process.exit(2);
  }
  return names.length ? names : Object.keys(INSTALLS);
}

const indent = (text: string) => text.replace(/^/gm, "  ");

// What Riker sets up outside its home (core/install.ts). With no names, all of
// them that apply here, so one command sets up a machine.
const install = defineCommand({
  meta: {
    name: "install",
    description: `Set up what riker adds to your tools: ${Object.keys(INSTALLS).join(", ")} (all when none named)`,
  },
  args: {
    check: { type: "boolean", description: "say what is installed, change nothing" },
  },
  run({ args }) {
    const names = chosen(args._.map(String));
    if (!args.check) moveHomeFirst();
    for (const name of names) {
      const item = INSTALLS[name];
      const state = installState(name);
      if (args.check) {
        const why = item.unavailable();
        console.log(`${name}: ${state}${why ? ` (${why})` : ""} · ${item.help}`);
        continue;
      }
      if (state === InstallState.unavailable) {
        console.log(`${name}: skipped, ${item.unavailable()}`);
        continue;
      }
      if (state === InstallState.installed) {
        console.log(`${name}: up to date`);
        continue;
      }
      console.log(`${name}: ${state === InstallState.stale ? "updated" : "installed"}`);
      console.log(indent(item.install()));
    }
  },
});

const uninstall = defineCommand({
  meta: {
    name: "uninstall",
    description: `Take out what riker install put in: ${Object.keys(INSTALLS).join(", ")} (all when none named)`,
  },
  run({ args }) {
    const names = chosen(args._.map(String));
    moveHomeFirst();
    for (const name of names) {
      const removed = INSTALLS[name].uninstall();
      console.log(removed ? `${name}: removed\n${indent(removed)}` : `${name}: nothing to remove`);
    }
  },
});

// The real TUI on a scratch home, polling a fake GitHub (bun run sim).
const sim = defineCommand({
  meta: {
    name: "sim",
    description: "Run on a scratch home against an offline, simulated GitHub (bun run sim:do makes things happen)",
  },
  args: {
    scenario: { type: "positional", required: false, description: "play one: review-cycle, review-ask" },
    brain: { type: "string", default: "fake", description: "fake (canned, free) | haiku (real claude, cheap)" },
  },
  run({ args }) {
    const brain = args.brain === "haiku" ? "haiku" : "fake";
    if (args.brain !== brain) {
      console.error(`riker sim: --brain is fake or haiku, not ${args.brain}`);
      process.exit(2);
    }
    config = { sim: { brain, scenario: args.scenario ? String(args.scenario) : undefined } };
  },
});

// aug's home becomes Riker's (core/migrate-home.ts). Riker does this itself
// at start; this shows what it would do, or does it without starting.
const migrate = defineCommand({
  meta: {
    name: "migrate",
    description: "Move aug's home (~/.aug) to Riker's (~/.riker), as a start does",
  },
  args: {
    check: { type: "boolean", description: "say what it would do, change nothing" },
  },
  async run({ args }) {
    const done = args.check ? planHomeMigration() : migrateHome();
    if (done.skip) console.log(`nothing to do: ${done.skip}`);
    else if (done.refuse) {
      console.error(`${CMD}: ${done.refuse}`);
      process.exit(1);
    } else console.log(done.steps.join("\n"));
    if (done.refuse) return;
    // Windows aug tagged get Riker's tags too (the engine also does this at
    // each start).
    if (args.check) console.log("copy @aug_* tags on live tmux windows to @riker_*");
    else {
      setMux(new TmuxMux(loadConfig().tmuxSocket));
      console.log(`tmux: tagged ${await copyLegacyTags()} sessions and windows`);
    }
  },
});

const SUBCOMMANDS = { hooks, install, uninstall, sim, migrate };

const main = defineCommand({
  meta: {
    name: "riker",
    version: "0.0.1",
    description:
      "Your work manager in a terminal: GitHub and Slack become tasks, Claude does the work, nothing goes out until you approve.",
  },
  subCommands: SUBCOMMANDS,
  args: {
    demo: {
      type: "boolean",
      description: "run on a fictional day: no network, no AI, nothing sends",
    },
  },
  run({ args, rawArgs }) {
    // citty runs this after a subcommand too; a subcommand is not the TUI.
    if (rawArgs[0] && rawArgs[0] in SUBCOMMANDS) return;
    config = {
      fixture: args.demo ? "demo" : envVar("FIXTURE") || undefined,
    };
  },
});

export async function parseCLI(): Promise<CLIConfig> {
  await runMain(main);
  // citty prints --help/--version without calling run() and without exiting.
  if (!config) process.exit(0);
  return config;
}
