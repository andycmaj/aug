import { defineCommand, runMain } from "citty";

export interface CLIConfig {
  // A built-in fixture name: no network, no AI, a fictional day.
  fixture?: string;
}

let config: CLIConfig | undefined;

const main = defineCommand({
  meta: {
    name: "aug",
    version: "0.0.1",
    description:
      "Your work manager in a terminal: GitHub and Slack become tasks, Claude does the work, nothing goes out until you approve.",
  },
  args: {
    demo: {
      type: "boolean",
      description: "run on a fictional day: no network, no AI, nothing sends",
    },
  },
  run({ args }) {
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
