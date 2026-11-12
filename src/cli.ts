import { defineCommand, runMain } from "citty";
import {
  claudeSettingsPath,
  hooksInstalled,
  installHooks,
  uninstallHooks,
} from "./core/adopt";
import { INSTALLS, InstallState, installState } from "./core/install";

export interface CLIConfig {
  // A built-in fixture name: no network, no AI, a fictional day.
  fixture?: string;
}

let config: CLIConfig | undefined;

// Hooks in your user settings, so aug picks up claudes you start by hand in
// a project's tmux session. Never written unless you ask.
const hooks = defineCommand({
  meta: {
    name: "hooks",
    description: "Pick up claudes you start by hand in project sessions",
  },
  subCommands: {
    install: defineCommand({
      meta: { name: "install", description: "Add aug's hooks to your Claude settings" },
      run() {
        console.log(`aug hooks added to ${installHooks()}`);
      },
    }),
    uninstall: defineCommand({
      meta: { name: "uninstall", description: "Remove aug's hooks from your Claude settings" },
      run() {
        console.log(
          uninstallHooks()
            ? `aug hooks removed from ${claudeSettingsPath()}`
            : "no aug hooks to remove",
        );
      },
    }),
    status: defineCommand({
      meta: { name: "status", description: "Whether aug's hooks are installed" },
      run() {
        console.log(
          hooksInstalled()
            ? `installed in ${claudeSettingsPath()}`
            : "not installed (aug install hooks)",
        );
      },
    }),
  },
});

function chosen(names: string[]): string[] {
  const unknown = names.filter((n) => !(n in INSTALLS));
  if (unknown.length) {
    console.error(
      `aug: no install named ${unknown.join(", ")} (one of ${Object.keys(INSTALLS).join(", ")})`,
    );
    process.exit(2);
  }
  return names.length ? names : Object.keys(INSTALLS);
}

const indent = (text: string) => text.replace(/^/gm, "  ");

// What aug sets up outside its home (core/install.ts). With no names, all of
// them that apply here, so one command sets up a machine.
const install = defineCommand({
  meta: {
    name: "install",
    description: `Set up what aug adds to your tools: ${Object.keys(INSTALLS).join(", ")} (all when none named)`,
  },
  args: {
    check: { type: "boolean", description: "say what is installed, change nothing" },
  },
  run({ args }) {
    for (const name of chosen(args._.map(String))) {
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
    description: `Take out what aug install put in: ${Object.keys(INSTALLS).join(", ")} (all when none named)`,
  },
  run({ args }) {
    for (const name of chosen(args._.map(String))) {
      const removed = INSTALLS[name].uninstall();
      console.log(removed ? `${name}: removed\n${indent(removed)}` : `${name}: nothing to remove`);
    }
  },
});

const SUBCOMMANDS = { hooks, install, uninstall };

const main = defineCommand({
  meta: {
    name: "aug",
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
      fixture: args.demo ? "demo" : process.env.AUG_FIXTURE || undefined,
    };
  },
});

export async function parseCLI(): Promise<CLIConfig> {
  await runMain(main);
  // citty prints --help/--version without calling run() and without exiting.
  if (!config) process.exit(0);
  return config;
}
