// Riker's one entry: the dev launcher (script/riker.ts), `bun run demo|sim` and
// the compiled binary (script/compile.ts) all start here. One file is both
// Riker and riker-tools, so hooks and agents call `riker tools ...` in a compiled
// binary (core/self.ts), and the demo's stand-in agent is `riker demo-agent`.

import { fileURLToPath } from "node:url";
import {
  DEMO_AGENT_SUBCOMMAND,
  lastingEntry,
  setToolsEntry,
  TOOLS_SUBCOMMAND,
} from "@riker/core/self";

setToolsEntry(
  lastingEntry(fileURLToPath(new URL("./riker-tools.ts", import.meta.url))),
);

if (process.argv[2] === TOOLS_SUBCOMMAND) {
  process.argv.splice(2, 1);
  await import("./riker-tools");
} else if (process.argv[2] === DEMO_AGENT_SUBCOMMAND) {
  process.argv.splice(2, 1);
  await import("@riker/fixtures/fake-claude");
} else {
  await import("@riker/tui/index");
}
