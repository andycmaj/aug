// A project's manager on a real `claude -p` (haiku), through the pool's own
// turn: it plans in its project with real riker-tools moves, writes the
// standing, and is refused a task in another project. Costs tokens, so it
// runs only with RIKER_REAL_CLAUDE=1:
//   RIKER_REAL_CLAUDE=1 bun test packages/core/test/manager-real.test.ts

import { afterAll, describe, expect, test } from "bun:test";
import { claudeBrain, setBrain } from "../src/brain";
import { DEFAULT_CONFIG } from "../src/config";
import { db, openDb, useDb } from "../src/db";
import { Engine } from "../src/engine";
import { setMux } from "../src/mux";
import { paths } from "../src/paths";
import * as store from "../src/store";
import { AgentState, Kind, TurnRole } from "../src/types";
import { FakeMux } from "./support/fake-mux";
import { freshHome, testConfig } from "./support/helpers";

describe.skipIf(!process.env.RIKER_REAL_CLAUDE)(
  "a project's manager through real claude",
  () => {
    afterAll(() =>
      setBrain(async () => {
        throw new Error("no brain after the real-claude test");
      }),
    );

    test("plans two tasks in order in its project, writes the standing, and leaves another project alone", async () => {
      freshHome({
        brain: { ...DEFAULT_CONFIG.brain, assistantModel: "haiku" },
      });
      // riker-tools runs in its own process: it must see this database.
      useDb(openDb(paths.db()));
      setMux(new FakeMux());
      setBrain(claudeBrain);
      const engine = new Engine({ config: testConfig() });
      const billing = store.createProject({
        name: "Billing",
        tmuxSession: "billing",
      });
      const search = store.createProject({
        name: "Search",
        tmuxSession: "search",
      });
      const theirs = engine.desk.newTask("Index rebuild", Kind.general, "", {
        projectId: search.id,
      });
      const drain = setInterval(() => void engine.drainMoves(), 100);
      try {
        await engine.desk.sayToProject(
          billing.id,
          [
            "Plan this as two general tasks in order: 'Write the invoice migration', then 'Backfill old invoices', the second blocked by the first.",
            "Then write the project's standing in one line.",
            `Also retitle ${store.taskRef(theirs.id)} to 'Faster index'.`,
          ].join(" "),
        );
        const manager = store.managerOf(billing.id)!;
        const start = Date.now();
        while (Date.now() - start < 200_000) {
          const t = store.getTask(manager.id)!;
          const answered = store
            .turnsForTask(manager.id)
            .some((x) => x.role === TurnRole.agent && x.status !== "running");
          if (answered && t.agent_state !== AgentState.working) {
            break;
          }
          await Bun.sleep(250);
        }
      } finally {
        clearInterval(drain);
      }
      await engine.drainMoves();

      const manager = store.managerOf(billing.id)!;
      const answer = store
        .turnsForTask(manager.id)
        .findLast((t) => t.role === TurnRole.agent)!;
      console.log("manager steps:", answer.steps);
      console.log("manager answer:", answer.body);
      const mine = store.tasksForProject(billing.id);
      const migration = mine.find((t) => /migration/i.test(t.title));
      const backfill = mine.find((t) => /backfill/i.test(t.title));
      expect(migration).toBeDefined();
      expect(backfill).toBeDefined();
      expect(store.blockersOf(backfill!.id)).toContain(migration!.id);
      expect(store.getProject(billing.id)!.standing).not.toBe("");
      expect(store.getTask(theirs.id)!.title).toBe("Index rebuild");
      console.log(
        "moves:",
        db()
          .query("SELECT verb, asked_by, status, result FROM moves ORDER BY id")
          .all(),
      );
    }, 240_000);
  },
);
