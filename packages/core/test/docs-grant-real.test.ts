// Claude Docs from a real headless `claude -p`, under a task agent's own
// tools, allow rules and dontAsk mode (AUG-0119). Costs tokens and needs the
// claude.ai Claude Docs connector, so it runs only with AUG_REAL_CLAUDE=1:
//   AUG_REAL_CLAUDE=1 bun test test/docs-grant-real.test.ts
// Nothing here writes a doc: the write is only ever denied.

import { afterAll, describe, expect, test } from "bun:test";
import { GENERAL_TOOLS, generalAllow, turnSystem } from "../src/agents";
import { claudeBrain, setBrain, think } from "../src/brain";
import { grantSteps } from "../src/capabilities";
import { DEFAULT_CONFIG, type AugConfig } from "../src/config";
import { freshHome } from "./support/helpers";

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

// The write never runs and the answer names the grant. haiku either tries it
// and is denied, or declines it from the prompt's grant line without trying
// (2 of 5 runs with docs.read): both are right, so neither is required.
function expectWriteRefused(
  config: AugConfig,
  { result, steps }: Awaited<ReturnType<typeof run>>,
) {
  const denied = result.denied ?? [];
  const tried = steps.some((s) => s.startsWith(`${DOCS}batch`));
  const refused = denied.some((d) => d.startsWith(`${DOCS}batch`));
  expect(tried).toBe(refused);
  if (refused)
    expect(grantSteps(denied, "general", config)[0]).toContain(
      'add "docs.write" to capabilities.grants.general',
    );
  expect(result.text).toContain("docs.write");
}

describe.skipIf(!process.env.AUG_REAL_CLAUDE)("Claude Docs grants through real claude", () => {
  afterAll(() => setBrain(async () => {
    throw new Error("no brain after the real-claude test");
  }));

  test(
    "ungranted, a doc's create never runs and the turn says what to grant",
    async () => {
      freshHome();
      setBrain(claudeBrain);
      // Some connector grant, as in AUG-0402: with no mcp__ rule at all no
      // connector loads (--strict-mcp-config) and the tool is absent, not denied.
      const config = granted(["slack.read"]);
      const got = await run(
        config,
        `Call ${DOCS}batch once with container {"kind":"project","create":{"name":"aug probe","doc":{"markdown":"# aug probe"}}} and batch []. Then stop and say what happened.`,
      );
      expectWriteRefused(config, got);
    },
    240_000,
  );

  test(
    "docs.read granted, guide runs and a write still never does",
    async () => {
      freshHome();
      setBrain(claudeBrain);
      const config = granted(["docs.read"]);
      const got = await run(
        config,
        `Call ${DOCS}guide with items ["topic.index"], then call ${DOCS}batch once with container {"kind":"project","create":{"name":"aug probe","doc":{"markdown":"# aug probe"}}} and batch []. Then stop.`,
      );
      expect(got.steps.some((s) => s.startsWith(`${DOCS}guide`))).toBe(true);
      const denied = got.result.denied ?? [];
      expect(denied.some((d) => d.startsWith(`${DOCS}guide`))).toBe(false);
      expectWriteRefused(config, got);
    },
    240_000,
  );
});
