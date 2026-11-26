import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, useDb } from "../../src/db";
import { setBrain, type BrainCall, type BrainResult } from "../../src/brain";
import {
  DEFAULT_CONFIG,
  fixedConfig,
  type RikerConfig,
  type ConfigSource,
} from "../../src/config";
import { ensureDocs } from "../../src/docs";
import { configureLog } from "../../src/log";

let current: ConfigSource = fixedConfig();

// A new home, and the config its engine is handed (in memory, never a file).
export function freshHome(config: Partial<RikerConfig> = {}): ConfigSource {
  process.env.RIKER_HOME = mkdtempSync(join(tmpdir(), "riker-test-"));
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

export function config(): RikerConfig {
  return current.get();
}

// costUsd: what each call reports it cost (none by default, so no spend row);
// a function gives each call its own, as a resumed session's growing total.
export function fakeBrain(
  answer: (call: BrainCall) => unknown,
  opts: { costUsd?: number | ((call: BrainCall) => number) } = {},
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
            costUsd:
              typeof opts.costUsd === "function"
                ? opts.costUsd(call)
                : opts.costUsd,
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
