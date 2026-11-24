// bun run docs:site [outDir]: writes the GitHub Pages site (default _site/
// at the repo root). .github/workflows/pages.yml runs it and publishes the
// folder on every push to main.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildSite } from "../src/site";

const out = resolve(process.argv[2] ?? join(import.meta.dir, "../../../_site"));
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [path, body] of Object.entries(buildSite())) {
  writeFileSync(join(out, path), body);
  console.log(`wrote ${join(out, path)}`);
}
