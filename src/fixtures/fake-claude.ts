// A stand-in coding agent for fixture mode: prints like an agent at work and
// fires the same hooks real Claude Code would, so the task, the rail and the
// Board move exactly as they do for real. Type a line to answer it; type
// "done" to have it finish.

import { createInterface } from "node:readline";
import { handleDone, handleHook } from "../core/hooks";

const env = {
  taskId: Number(process.env.AUG_TASK_ID),
  sessionId: process.env.AUG_SESSION_ID ?? "",
};
const title = process.argv[2] ?? "the task";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const orange = (s: string) => `\x1b[38;5;209m${s}\x1b[0m`;

async function work(steps: [string, Record<string, unknown>][]) {
  handleHook("prompt", {}, env);
  for (const [tool, input] of steps) {
    await sleep(900);
    handleHook("tool", { tool_name: tool, tool_input: input }, env);
    const detail = String(
      input.file_path ?? input.command ?? input.pattern ?? "",
    );
    console.log(`${orange("⏺")} ${tool}(${detail})`);
    console.log(dim("  ⎿  ok"));
  }
}

console.log(
  orange("✻ Claude Code") + dim("  (aug demo - a fake agent; nothing runs)"),
);
console.log(dim(`  cwd: ${process.cwd()}`));
console.log("");
console.log(`> Work: ${title}`);
console.log("");

await work([
  ["Bash", { command: "aug-tools notes" }],
  ["Read", { file_path: "tools/gl_export.py" }],
  ["Grep", { pattern: "inter_company" }],
]);
console.log("");
console.log(
  "Found it: `gl_export.py` filters rows where `entity != home_entity`, which",
);
console.log(
  "drops inter-company transfers. Want me to keep them and add a test?",
);
console.log("");
handleHook("stop", {}, env);

const rl = createInterface({ input: process.stdin });
process.stdout.write("> ");
for await (const line of rl) {
  if (/done|finish|ship/i.test(line)) {
    await work([
      ["Edit", { file_path: "tools/gl_export.py" }],
      ["Bash", { command: "pytest tests/export -q" }],
    ]);
    console.log("");
    console.log(
      handleDone(env, {
        summary:
          "Export keeps inter-company transfers; added a regression test. 14 tests green.",
        reply:
          "Fixed: the export now keeps inter-company transfers (the missing 4,180). Test added.",
        close: "issue",
      }),
    );
    console.log(dim("finished - the reply waits for your Send in aug"));
    rl.close();
    break;
  }
  await work([["Read", { file_path: "tests/export/test_gl.py" }]]);
  console.log(`Got it ("${line}"). Say "done" when you want me to finish.`);
  handleHook("stop", {}, env);
  process.stdout.write("> ");
}
handleHook("end", {}, env);
await sleep(200);
process.exit(0);
