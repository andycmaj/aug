import { defineCommand, runMain } from "citty";
import {
  claudeSettingsPath,
  hooksInstalled,
  installHooks,
  uninstallHooks,
} from "./core/adopt";

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
            : "not installed (aug hooks install)",
        );
      },
    }),
  },
});

const main = defineCommand({
  meta: {
    name: "aug",
    version: "0.0.1",
    description:
      "Your work manager in a terminal: GitHub and Slack become tasks, Claude does the work, nothing goes out until you approve.",
  },
  subCommands: { hooks },
  args: {
    demo: {
      type: "boolean",
      description: "run on a fictional day: no network, no AI, nothing sends",
    },
  },
  run({ args, rawArgs }) {
    // citty runs this after a subcommand too; a subcommand is not the TUI.
    if (rawArgs[0] === "hooks") return;
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
