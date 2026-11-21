import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DocName, readDoc } from "../src/docs";
import { freshHome } from "./support/helpers";

describe("docs", () => {
  test("a fresh home is seeded with the starter files from the repo", () => {
    freshHome();
    for (const name of Object.values(DocName)) {
      const starter = readFileSync(
        join(import.meta.dir, "../defaults", name),
        "utf8",
      );
      expect(readDoc(name)).toBe(starter);
    }
  });
});
