// A GuideAsk on `claude -p`, for running a review without aug (the CLI,
// evals). Each call is fresh and read-only: no user settings or hooks, no
// MCP servers, no saved session, only the skill's own tools. What each call
// cost is kept, so runs at different models and batch sizes compare.

import type { GuideAsk } from "./run";
import { skillBody, skillTools } from "./prompt";

export interface CallUsage {
  label: string;
  ms: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  denied: string[];
  isError: boolean;
}

export interface ClaudeAsk {
  ask: GuideAsk;
  // Every call so far, in the order they finished.
  calls: CallUsage[];
  total(): Omit<CallUsage, "label" | "denied" | "isError"> & { calls: number };
}

export interface ClaudeAskOptions {
  cwd: string;
  // claude's own default when left out.
  model?: string;
  // The `claude` binary; the one on PATH by default.
  claude?: string;
  // The system prompt appended to claude's; the skill's instructions by default.
  system?: string;
  // Allow rules; the skill's `allowed-tools` by default.
  allow?: string[];
}

interface ResultEvent {
  result?: string;
  is_error?: boolean;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  permission_denials?: { tool_name?: string; tool_input?: Record<string, unknown> }[];
}

const DENIED_INPUT_CHARS = 200;

// `Bash(git log:*)` -> `Bash`: the tools a call has at all.
function toolNames(allow: string[]): string[] {
  return [...new Set(allow.map((r) => r.replace(/\(.*$/, "")))];
}

export function claudeArgs(opts: ClaudeAskOptions): string[] {
  const allow = opts.allow ?? skillTools();
  return [
    "-p",
    "--output-format",
    "json",
    "--setting-sources",
    "",
    "--no-session-persistence",
    "--strict-mcp-config",
    ...(opts.model ? ["--model", opts.model] : []),
    "--append-system-prompt",
    opts.system ?? skillBody(),
    "--tools",
    toolNames(allow).join(","),
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    ...allow,
  ];
}

function deniedCalls(event: ResultEvent): string[] {
  return (event.permission_denials ?? []).map((d) => {
    const command = d.tool_input?.command;
    if (typeof command === "string") return `${d.tool_name ?? "tool"} ${command}`;
    const input = JSON.stringify(d.tool_input ?? {});
    return `${d.tool_name ?? "tool"} ${input.length > DENIED_INPUT_CHARS ? `${input.slice(0, DENIED_INPUT_CHARS)}…` : input}`;
  });
}

export function claudeAsk(opts: ClaudeAskOptions): ClaudeAsk {
  const bin = opts.claude ?? Bun.which("claude") ?? "claude";
  const args = claudeArgs(opts);
  const calls: CallUsage[] = [];
  const ask: GuideAsk = async (prompt, label) => {
    const started = performance.now();
    // The prompt goes on stdin: a batch's diffs run to 100k characters.
    const proc = Bun.spawn([bin, ...args], {
      cwd: opts.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "code-review-plannotator" },
    });
    proc.stdin.write(prompt);
    await proc.stdin.end();
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    let event: ResultEvent;
    try {
      event = JSON.parse(out) as ResultEvent;
    } catch {
      throw new Error(`claude exited ${code} without a result: ${(err || out).trim().slice(0, 500)}`);
    }
    const u = event.usage ?? {};
    const call: CallUsage = {
      label,
      ms: Math.round(performance.now() - started),
      costUsd: event.total_cost_usd ?? 0,
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      denied: deniedCalls(event),
      isError: event.is_error === true,
    };
    calls.push(call);
    if (call.isError) throw new Error(event.result || `claude failed (${label})`);
    return { text: event.result ?? "", denied: call.denied };
  };
  return {
    ask,
    calls,
    total() {
      return calls.reduce(
        (t, c) => ({
          calls: t.calls + 1,
          ms: t.ms + c.ms,
          costUsd: t.costUsd + c.costUsd,
          inputTokens: t.inputTokens + c.inputTokens,
          outputTokens: t.outputTokens + c.outputTokens,
          cacheReadTokens: t.cacheReadTokens + c.cacheReadTokens,
          cacheWriteTokens: t.cacheWriteTokens + c.cacheWriteTokens,
        }),
        { calls: 0, ms: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      );
    },
  };
}
