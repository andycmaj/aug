import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, useDb } from "../src/core/db";
import { setBrain, type BrainCall, type BrainResult } from "../src/core/brain";
import {
  DEFAULT_CONFIG,
  fixedConfig,
  type AugConfig,
  type ConfigSource,
} from "../src/core/config";
import { ensureDocs } from "../src/core/docs";
import { configureLog } from "../src/core/log";

let current: ConfigSource = fixedConfig();

// A new home, and the config its engine is handed (in memory, never a file).
export function freshHome(config: Partial<AugConfig> = {}): ConfigSource {
  process.env.AUG_HOME = mkdtempSync(join(tmpdir(), "aug-test-"));
  useDb(openDb(":memory:"));
  const source = fixedConfig({ ...DEFAULT_CONFIG, ...config });
  current = source;
  configureLog(() => source.get().log);
  ensureDocs();
  return source;
}

// The last freshHome's config: the source to hand an Engine or a pool, and
// the value a function takes.
export function testConfig(): ConfigSource {
  return current;
}

export function config(): AugConfig {
  return current.get();
}

// costUsd: what each call reports it cost (none by default, so no spend row).
export function fakeBrain(
  answer: (call: BrainCall) => unknown,
  opts: { costUsd?: number } = {},
): BrainCall[] {
  const calls: BrainCall[] = [];
  setBrain(async (call): Promise<BrainResult> => {
    calls.push(call);
    const structured = answer(call);
    return {
      text: "",
      structured,
      sessionId: call.sessionId ?? call.resume ?? null,
      durationMs: 1,
      isError: false,
      ...(opts.costUsd === undefined
        ? {}
        : {
            costUsd: opts.costUsd,
            usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 0 },
          }),
    };
  });
  return calls;
}

// The test's config with room for this many agents at once.
export function withLimit(maxActiveAgents: number): ConfigSource {
  return fixedConfig({ ...current.get(), maxActiveAgents });
}
