// Entry point for Riker.

import { runApp } from "@andycmaj/opentui-app";
import { envVar } from "@riker/core/brand";
import { App } from "./app";
import { CrashGuard } from "./components/crash-guard";
import { parseCLI } from "./cli";
import { fileConfig } from "@riker/core/config";
import { Engine } from "@riker/core/engine";
import { claimHome, releaseHome } from "@riker/core/home-lock";
import { configureLog, logCrashes, logger } from "@riker/core/log";
import { setMux, TmuxMux } from "@riker/core/mux";
import { startPerf, timing } from "@riker/core/perf";
import { paths } from "@riker/core/paths";
import { exitCode } from "@riker/core/restart";

const cli = await parseCLI();
// config.json, read again whenever it changes. Everything below is handed
// this source; nothing else reads the file.
const config = fileConfig();
configureLog(() => config.get().log);
logCrashes();
startPerf({ proc: "riker", sampleProcess: true });
logger("riker").info("start", {
  fixture: cli.fixture ?? (cli.sim ? "sim" : null),
  home: envVar("HOME") ?? null,
});

let engine: Engine;
let started = () => {};
if (cli.sim) {
  const { installSim } = await import("@riker/fixtures/sim/index");
  ({ engine, started } = installSim(cli.sim));
} else if (cli.fixture) {
  const { installFixture } = await import("@riker/fixtures/demo");
  engine = installFixture(cli.fixture);
} else {
  setMux(new TmuxMux(config.get().tmuxSocket));
  engine = new Engine({ config });
}

// Before the TUI takes the terminal, so the refusal is readable.
const claim = claimHome();
if (!claim.ok) {
  logger("riker").warn("home taken", { pid: claim.pid });
  console.error(
    `riker: already running on ${paths.home()} (pid ${claim.pid}).\n` +
      "Quit that one first, or run this one with RIKER_HOME set to another folder.",
  );
  process.exit(1);
}
process.on("exit", () => releaseHome());
engine.start();
started();
// From process start; startup.first_frame is the screen itself.
timing("startup.engine", performance.now());

// opentui answers SIGHUP/SIGTERM by tearing the renderer down and nothing
// more, so the engine's timers kept a closed window's Riker running headless
// forever. The terminal is restored by the time this runs.
// A restart asked for (CrashGuard) exits with the code the dev launcher restarts on.
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
