// The brain: headless `claude -p`. One call shape for triage (no tools, a
// JSON schema), the assistant (same), and a general agent's turn (read-only
// tools, resumable session, steps streamed live).
//
// User settings are skipped (`--setting-sources ""`): their hooks and output
// styles would leak into what triage and drafts read back. Auth still comes
// from the logged-in CLI.

import { logger } from "./log";
import { claudeEnv } from "./self";
import { recordSpend, type SpendTag } from "./spend";

const log = logger("brain");

// Enough of a JSON schema to type the ones aug writes; claude checks the rest.
export interface JsonSchema {
  readonly type?: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
}

export interface BrainCall {
  prompt: string;
  // Appended to Claude Code's own system prompt.
  system?: string;
  // A JSON schema for the answer (an `as const` object literal is fine).
  schema?: JsonSchema;
  model?: string;
  cwd?: string;
  // Start a persisted session under this id, or resume one.
  sessionId?: string;
  resume?: string;
  // Built-in tools the call may use; omitted means none.
  tools?: string[];
  // Permission rules for those tools; anything else is denied, not asked.
  allow?: string[];
  // Tools denied outright, even if a rule elsewhere would allow them.
  disallow?: string[];
  // Claude Code plugins to load for this call (core/capabilities.ts).
  pluginDirs?: string[];
  // "user" loads the user's settings, which is the only way claude.ai
  // connectors (MCP servers) load. Default skips them.
  settingSources?: "" | "user";
  // Added to the child's environment (aug-tools reads who is asking here).
  env?: Record<string, string>;
  onStep?: (step: string) => void;
  // Each finished tool call with what it gave back (a headless call has no
  // PostToolUse hook; agents.ts links the docs it made from here).
  onTool?: (call: ToolCall) => void;
  signal?: AbortSignal;
  // Who the call is for, so its cost lands on the right row (core/spend.ts).
  // Untagged calls are recorded as "other".
  spend?: SpendTag;
}

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
  response: unknown;
}

export interface BrainResult {
  text: string;
  structured: unknown;
  sessionId: string | null;
  durationMs: number;
  isError: boolean;
  // Calls dontAsk turned away (deniedCalls).
  denied?: string[];
  // What the call cost, as claude reported it. Absent when it said nothing.
  costUsd?: number;
  usage?: TokenUsage;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// The result event's usage block, in aug's names.
export function tokenUsage(
  event: Pick<StreamEvent, "usage">,
): TokenUsage | undefined {
  const u = event.usage;
  if (!u) return undefined;
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
}

export type Brain = (call: BrainCall) => Promise<BrainResult>;

let impl: Brain = claudeBrain;

export function setBrain(next: Brain): void {
  impl = next;
}

// Every model call is traced here, whichever brain answers it.
export async function think(call: BrainCall): Promise<BrainResult> {
  const fields = {
    model: call.model ?? null,
    resume: call.resume ?? call.sessionId ?? null,
    tools: call.tools?.length ?? 0,
    schema: !!call.schema,
    prompt: call.prompt.length,
  };
  log.trace("call", { ...fields, prompt: call.prompt.slice(0, 500) });
  const done = log.time("call done", fields);
  try {
    const result = await impl(call);
    done({
      ok: !result.isError,
      durationMs: result.durationMs,
      sessionId: result.sessionId,
      costUsd: result.costUsd ?? null,
      ...(result.isError ? { text: result.text.slice(0, 500) } : {}),
    });
    recordSpend(call.spend, call.model, result);
    return result;
  } catch (err) {
    done({ ok: false, err });
    throw err;
  }
}

export class BrainError extends Error {}

// Under -p, claude.ai connectors connect in the background and the first
// request goes out before they're up, so a granted connector tool simply isn't
// there. When the call is allowed any MCP tool, make claude wait for them.
export function brainEnv(call: BrainCall): Record<string, string> {
  const wantsMcp = call.allow?.some((rule) => rule.startsWith("mcp__"));
  return wantsMcp
    ? { MCP_CONNECTION_NONBLOCKING: "false", ...call.env }
    : { ...call.env };
}

export function claudeArgs(call: BrainCall): string[] {
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--setting-sources",
    call.settingSources ?? "",
  ];
  if (call.model) args.push("--model", call.model);
  if (call.system) args.push("--append-system-prompt", call.system);
  if (call.schema) args.push("--json-schema", JSON.stringify(call.schema));
  if (call.resume) args.push("--resume", call.resume);
  else if (call.sessionId) args.push("--session-id", call.sessionId);
  else args.push("--no-session-persistence");
  // A plugin brings its hooks along; they'd reopen what skipping user
  // settings closed, so they're off.
  if (call.pluginDirs?.length) {
    for (const dir of call.pluginDirs) args.push("--plugin-dir", dir);
    args.push("--settings", JSON.stringify({ disableAllHooks: true }));
  }
  args.push("--tools", (call.tools ?? []).join(","));
  if (call.allow?.length) {
    args.push("--permission-mode", "dontAsk");
    args.push("--allowedTools", ...call.allow);
  }
  if (call.disallow?.length) args.push("--disallowedTools", ...call.disallow);
  return args;
}

interface StreamContent {
  type: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
}

export interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: { content?: StreamContent[] };
  result?: string;
  structured_output?: unknown;
  duration_ms?: number;
  is_error?: boolean;
  parent_tool_use_id?: string | null;
  permission_denials?: { tool_name?: string; tool_input?: Record<string, unknown> }[];
  // On the result event: the whole process's cost so far, and this turn's
  // tokens (a persistent session's total grows turn by turn).
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

// A connector call's input can hold a whole document: the tool's name says
// what to grant, so only the start of it is kept on the turn and in the log.
const DENIED_INPUT_CHARS = 160;

// What dontAsk turned away, in full: the model's own account of a denial
// rarely says which command or rule missed.
export function deniedCalls(event: StreamEvent): string[] {
  return (event.permission_denials ?? []).map((d) => {
    const command = d.tool_input?.command;
    if (typeof command === "string") return `${d.tool_name ?? "tool"} ${command}`;
    const input = JSON.stringify(d.tool_input ?? {});
    const short =
      input.length > DENIED_INPUT_CHARS
        ? `${input.slice(0, DENIED_INPUT_CHARS)}…`
        : input;
    return `${d.tool_name ?? "tool"} ${short}`;
  });
}

// One line per tool call: "Read src/app.ts", "WebSearch payroll same-day".
export function describeStep(
  name: string,
  input: Record<string, unknown> = {},
): string {
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value) return value;
    }
    return "";
  };
  const detail = pick(
    "file_path",
    "path",
    "pattern",
    "query",
    "url",
    "command",
    "description",
    "prompt",
  );
  const short = detail.replace(/\s+/g, " ").slice(0, 80);
  return short ? `${name} ${short}` : name;
}

export interface StreamAcc {
  text: string;
  result: StreamEvent | null;
  sessionId: string | null;
  // Tool calls waiting for their result, by tool_use id.
  pending?: Map<string, { name: string; input: Record<string, unknown> }>;
}

export function parseStreamLine(
  line: string,
  onStep: ((step: string) => void) | undefined,
  acc: StreamAcc,
  onTool?: (call: ToolCall) => void,
): void {
  if (!line.trim()) return;
  let event: StreamEvent;
  try {
    event = JSON.parse(line) as StreamEvent;
  } catch {
    return;
  }
  if (event.session_id) acc.sessionId = event.session_id;
  if (event.type === "assistant" && !event.parent_tool_use_id) {
    for (const part of event.message?.content ?? []) {
      if (part.type === "tool_use" && part.name !== "StructuredOutput") {
        onStep?.(describeStep(part.name ?? "tool", part.input));
        if (onTool && part.id)
          (acc.pending ??= new Map()).set(part.id, {
            name: part.name ?? "tool",
            input: part.input ?? {},
          });
      } else if (part.type === "text" && part.text) {
        acc.text = part.text;
      }
    }
  }
  if (event.type === "user" && onTool && acc.pending?.size) {
    const content = event.message?.content;
    for (const part of Array.isArray(content) ? content : []) {
      if (part.type !== "tool_result" || !part.tool_use_id) continue;
      const call = acc.pending.get(part.tool_use_id);
      if (!call) continue;
      acc.pending.delete(part.tool_use_id);
      onTool({ ...call, response: part.content });
    }
  }
  if (event.type === "result") acc.result = event;
}

export async function claudeBrain(call: BrainCall): Promise<BrainResult> {
  const started = Date.now();
  const proc = Bun.spawn(["claude", ...claudeArgs(call)], {
    cwd: call.cwd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: claudeEnv(brainEnv(call)),
  });
  const abort = () => proc.kill();
  call.signal?.addEventListener("abort", abort);
  proc.stdin.write(call.prompt);
  await proc.stdin.end();

  const acc: StreamAcc = { text: "", result: null, sessionId: null };
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of proc.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      parseStreamLine(buffer.slice(0, nl), call.onStep, acc, call.onTool);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
    }
  }
  parseStreamLine(buffer, call.onStep, acc, call.onTool);
  const code = await proc.exited;
  call.signal?.removeEventListener("abort", abort);

  if (!acc.result) {
    const stderr = (await new Response(proc.stderr).text()).trim();
    throw new BrainError(
      call.signal?.aborted
        ? "stopped"
        : `claude exited ${code}: ${stderr.split("\n").slice(-3).join(" ") || "no result"}`,
    );
  }
  const denied = deniedCalls(acc.result);
  if (denied.length) log.warn("permission denied", { denied, allow: call.allow ?? [] });
  return {
    text: acc.result.result ?? acc.text,
    structured: acc.result.structured_output ?? null,
    sessionId: acc.sessionId,
    durationMs: acc.result.duration_ms ?? Date.now() - started,
    isError: acc.result.is_error === true,
    denied,
    costUsd: acc.result.total_cost_usd,
    usage: tokenUsage(acc.result),
  };
}
