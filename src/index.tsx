// Entry point for aug.

import { runApp } from "@andycmaj/opentui-app";
import { App } from "./app";
import { parseCLI } from "./cli";
import { loadConfig } from "./core/config";
import { Engine } from "./core/engine";
import { logCrashes, logger } from "./core/log";

const cli = await parseCLI();
logCrashes();
logger("aug").info("start", {
  fixture: cli.fixture ?? null,
  home: process.env.AUG_HOME ?? null,
});

let engine: Engine;
if (cli.fixture) {
  const { installFixture } = await import("./fixtures/demo");
  engine = installFixture(cli.fixture);
} else {
  engine = new Engine();
}
engine.start();

// opentui answers SIGHUP/SIGTERM by tearing the renderer down and nothing
// more, so the engine's timers kept a closed window's aug running headless
// forever. The terminal is restored by the time this runs.
await runApp(() => <App engine={engine} theme={loadConfig().theme} />, {
  onDestroy: () => {
    engine.stop();
    process.exit(0);
  },
});
