// Entry point for aug.

import { runApp } from "@andycmaj/opentui-app";
import { App } from "./app";
import { CrashGuard } from "./components/crash-guard";
import { parseCLI } from "./cli";
import { fileConfig } from "./core/config";
import { Engine } from "./core/engine";
import { claimHome, releaseHome } from "./core/home-lock";
import { configureLog, logCrashes, logger } from "./core/log";
import { setMux, TmuxMux } from "./core/mux";
import { startPerf, timing } from "./core/perf";
import { paths } from "./core/paths";
import { exitCode } from "./core/restart";

const cli = await parseCLI();
// config.json, read again whenever it changes. Everything below is handed
// this source; nothing else reads the file.
const config = fileConfig();
configureLog(() => config.get().log);
logCrashes();
startPerf({ proc: "aug", sampleProcess: true });
logger("aug").info("start", {
  fixture: cli.fixture ?? (cli.sim ? "sim" : null),
  home: process.env.AUG_HOME ?? null,
});

let engine: Engine;
let started = () => {};
if (cli.sim) {
  const { installSim } = await import("./fixtures/sim");
  ({ engine, started } = installSim(cli.sim));
} else if (cli.fixture) {
  const { installFixture } = await import("./fixtures/demo");
  engine = installFixture(cli.fixture);
} else {
  setMux(new TmuxMux(config.get().tmuxSocket));
  engine = new Engine({ config });
}

// Before the TUI takes the terminal, so the refusal is readable.
const claim = claimHome();
if (!claim.ok) {
  logger("aug").warn("home taken", { pid: claim.pid });
  console.error(
    `aug: already running on ${paths.home()} (pid ${claim.pid}).\n` +
      "Quit that one first, or run this one with AUG_HOME set to another folder.",
  );
  process.exit(1);
}
process.on("exit", () => releaseHome());
engine.start();
started();
// From process start; startup.first_frame is the screen itself.
timing("startup.engine", performance.now());

// opentui answers SIGHUP/SIGTERM by tearing the renderer down and nothing
// more, so the engine's timers kept a closed window's aug running headless
// forever. The terminal is restored by the time this runs.
// A restart asked for (CrashGuard) exits with the code bin/aug restarts on.
await runApp(
  () => (
    <CrashGuard>
      <App engine={engine} theme={engine.desk.config().theme} />
    </CrashGuard>
  ),
  {
    onDestroy: () => {
      engine.stop();
      process.exit(exitCode());
    },
  },
);
