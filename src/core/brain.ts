// The brain: headless `claude -p`. One call shape for triage (no tools, a
// JSON schema), the assistant (same), and a general agent's turn (read-only
// tools, resumable session, steps streamed live).
//
// User settings are skipped (`--setting-sources ""`): their hooks and output
// styles would leak into what triage and drafts read back. Auth still comes
// from the logged-in CLI.

import { logger } from "./log";
import { claudeEnv } from "./self";

const log = logger("brain");

export interface BrainCall {
  prompt: string;
  // Appended to Claude Code's own system prompt.
  system?: string;
  schema?: Record<string, unknown>;
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
  // "user" loads the user's settings, which is the only way claude.ai
  // connectors (MCP servers) load. Default skips them.
  settingSources?: "" | "user";
  // Added to the child's environment (aug-tools reads who is asking here).
  env?: Record<string, string>;
  onStep?: (step: string) => void;
  signal?: AbortSignal;
}

export interface BrainResult {
  text: string;
  structured: unknown;
  sessionId: string | null;
  durationMs: number;
  isError: boolean;
  // Calls dontAsk turned away (deniedCalls).
  denied?: string[];
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
      ...(result.isError ? { text: result.text.slice(0, 500) } : {}),
    });
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
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
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
}

// What dontAsk turned away, in full: the model's own account of a denial
// rarely says which command or rule missed.
export function deniedCalls(event: StreamEvent): string[] {
  return (event.permission_denials ?? []).map((d) => {
    const command = d.tool_input?.command;
    return typeof command === "string"
      ? `${d.tool_name ?? "tool"} ${command}`
      : `${d.tool_name ?? "tool"} ${JSON.stringify(d.tool_input ?? {})}`;
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

export function parseStreamLine(
  line: string,
  onStep: ((step: string) => void) | undefined,
  acc: { text: string; result: StreamEvent | null; sessionId: string | null },
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
      } else if (part.type === "text" && part.text) {
        acc.text = part.text;
      }
    }
  }
  if (event.type === "result") acc.result = event;
}

async function claudeBrain(call: BrainCall): Promise<BrainResult> {
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

  const acc = {
    text: "",
    result: null as StreamEvent | null,
    sessionId: null as string | null,
  };
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of proc.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      parseStreamLine(buffer.slice(0, nl), call.onStep, acc);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
    }
  }
  parseStreamLine(buffer, call.onStep, acc);
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
  };
}
