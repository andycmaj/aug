// aug's one entry: the dev launcher (script/aug.ts), `bun run demo|sim` and
// the compiled binary (script/compile.ts) all start here. One file is both
// aug and aug-tools, so hooks and agents call `aug tools ...` in a compiled
// binary (core/self.ts).

import { fileURLToPath } from "node:url";
import { setToolsEntry, TOOLS_SUBCOMMAND } from "@aug/core/self";

setToolsEntry(fileURLToPath(new URL("./aug-tools.ts", import.meta.url)));

if (process.argv[2] === TOOLS_SUBCOMMAND) {
  process.argv.splice(2, 1);
  await import("./aug-tools");
} else {
  await import("@aug/tui/index");
}
