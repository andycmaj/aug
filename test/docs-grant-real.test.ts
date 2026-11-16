// Claude Docs from a real headless `claude -p`, under a task agent's own
// tools, allow rules and dontAsk mode (AUG-0119). Costs tokens and needs the
// claude.ai Claude Docs connector, so it runs only with AUG_REAL_CLAUDE=1:
//   AUG_REAL_CLAUDE=1 bun test test/docs-grant-real.test.ts
// Nothing here writes a doc: the write is only ever denied.

import { afterAll, describe, expect, test } from "bun:test";
import { GENERAL_TOOLS, generalAllow, turnSystem } from "../src/core/agents";
import { claudeBrain, setBrain, think } from "../src/core/brain";
import { grantSteps } from "../src/core/capabilities";
import { DEFAULT_CONFIG, type AugConfig } from "../src/core/config";
import { freshHome } from "./helpers";

const DOCS = "mcp__claude_ai_Claude_Docs__";

function granted(general: string[]): AugConfig {
  return {
    ...DEFAULT_CONFIG,
    capabilities: { ...DEFAULT_CONFIG.capabilities, grants: { general } },
  };
}

async function run(config: AugConfig, prompt: string) {
  const steps: string[] = [];
  const result = await think({
    prompt,
    system: turnSystem(config),
    model: "haiku",
    tools: GENERAL_TOOLS,
    allow: generalAllow(config),
    onStep: (s) => steps.push(s),
  });
  return { result, steps };
}

describe.skipIf(!process.env.AUG_REAL_CLAUDE)("Claude Docs grants through real claude", () => {
  afterAll(() => setBrain(async () => {
    throw new Error("no brain after the real-claude test");
  }));

  test(
    "ungranted, a doc's create is denied and the turn can say what to grant",
    async () => {
      freshHome();
      setBrain(claudeBrain);
      // Some connector grant, as in AUG-0402: with no mcp__ rule at all the
      // connectors never connect (brainEnv) and the tool is absent, not denied.
      const config = granted(["slack.read"]);
      const { result } = await run(
        config,
        `Call ${DOCS}batch once with container {"kind":"project","create":{"name":"aug probe","doc":{"markdown":"# aug probe"}}} and batch []. Then stop and say what happened.`,
      );
      const denied = result.denied ?? [];
      expect(denied.some((d) => d.startsWith(`${DOCS}batch`))).toBe(true);
      expect(grantSteps(denied, "general", config)[0]).toContain(
        'add "docs.write" to capabilities.grants.general',
      );
    },
    240_000,
  );

  test(
    "docs.read granted, guide runs and a write is still denied",
    async () => {
      freshHome();
      setBrain(claudeBrain);
      const { result, steps } = await run(
        granted(["docs.read"]),
        `Call ${DOCS}guide with items ["topic.index"], then call ${DOCS}batch once with container {"kind":"project","create":{"name":"aug probe","doc":{"markdown":"# aug probe"}}} and batch []. Then stop.`,
      );
      expect(steps.some((s) => s.startsWith(`${DOCS}guide`))).toBe(true);
      const denied = result.denied ?? [];
      expect(denied.some((d) => d.startsWith(`${DOCS}guide`))).toBe(false);
      expect(denied.some((d) => d.startsWith(`${DOCS}batch`))).toBe(true);
    },
    240_000,
  );
});
