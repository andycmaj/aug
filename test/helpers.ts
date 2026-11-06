import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, useDb } from "../src/core/db";
import { setBrain, type BrainCall, type BrainResult } from "../src/core/brain";
import {
  DEFAULT_CONFIG,
  setConfigForTest,
  type AugConfig,
} from "../src/core/config";
import { ensureDocs } from "../src/core/docs";
import { resetLog } from "../src/core/log";

export function freshHome(config: Partial<AugConfig> = {}): void {
  process.env.AUG_HOME = mkdtempSync(join(tmpdir(), "aug-test-"));
  useDb(openDb(":memory:"));
  setConfigForTest({ ...DEFAULT_CONFIG, ...config });
  ensureDocs();
  resetLog();
}

export function fakeBrain(answer: (call: BrainCall) => unknown): BrainCall[] {
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
    };
  });
  return calls;
}
