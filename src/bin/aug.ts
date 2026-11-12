// The compiled binary's entry (script/compile.ts). One file is both aug and
// aug-tools, so hooks and agents call `aug tools ...` (core/self.ts).

import { TOOLS_SUBCOMMAND } from "../core/self";

if (process.argv[2] === TOOLS_SUBCOMMAND) {
  process.argv.splice(2, 1);
  await import("./aug-tools");
} else {
  await import("../index");
}
