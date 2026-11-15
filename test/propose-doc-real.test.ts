// The Assistant handing in a real doc through a real `claude -p`, under the
// same tools, allow rules and dontAsk mode as Home (AUG-0093). Costs tokens,
// so it runs only with AUG_REAL_CLAUDE=1:
//   AUG_REAL_CLAUDE=1 bun test test/propose-doc-real.test.ts

import { afterAll, describe, expect, test } from "bun:test";
import { ASSISTANT_TOOLS, assistantAllow, assistantSystem } from "../src/core/assistant";
import { claudeBrain, setBrain, think } from "../src/core/brain";
import { openDb, useDb } from "../src/core/db";
import { Engine } from "../src/core/engine";
import { setMux } from "../src/core/mux";
import { paths } from "../src/core/paths";
import { toolsEnv } from "../src/core/self";
import * as store from "../src/core/store";
import { ProposalStatus } from "../src/core/types";
import { REAL_JOB } from "./doc-fixture";
import { FakeMux } from "./fake-mux";
import { freshHome } from "./helpers";

describe.skipIf(!process.env.AUG_REAL_CLAUDE)("propose_doc through real claude", () => {
  afterAll(() => setBrain(async () => {
    throw new Error("no brain after the real-claude test");
  }));

  test(
    "a multi-line Markdown doc is handed in without a denial",
    async () => {
      freshHome();
      // aug-tools runs in its own process: it must see this database.
      useDb(openDb(paths.db()));
      setMux(new FakeMux());
      setBrain(claudeBrain);
      const engine = new Engine();
      const drain = setInterval(() => void engine.drainMoves(), 100);
      try {
        const result = await think({
          prompt: [
            "The owner asked you to propose this JOB.md for them, exactly as it is. Hand it in with move propose_doc, then stop:",
            "",
            REAL_JOB,
          ].join("\n"),
          system: assistantSystem(),
          model: "haiku",
          tools: ASSISTANT_TOOLS,
          allow: assistantAllow(),
          env: { AUG_ASKED_BY: "assistant", ...toolsEnv() },
        });
        expect(result.denied ?? []).toEqual([]);
      } finally {
        clearInterval(drain);
      }
      await engine.drainMoves();
      const job = store
        .openProposals()
        .find((p) => p.doc === "JOB.md" && p.status === ProposalStatus.open);
      expect(job?.proposed.trim()).toBe(REAL_JOB.trim());
    },
    240_000,
  );
});
