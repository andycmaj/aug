// bun run docs:keys: writes the keymap's data into docs/keyboard.html.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withKeysData } from "../src/keys-doc";

const page = join(import.meta.dir, "../../../docs/keyboard.html");
const before = readFileSync(page, "utf8");
const after = withKeysData(before);
if (after === before) console.log("docs/keyboard.html is up to date");
else {
  writeFileSync(page, after);
  console.log("wrote docs/keyboard.html");
}
