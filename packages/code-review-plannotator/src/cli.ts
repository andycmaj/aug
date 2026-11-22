#!/usr/bin/env bun
// code-review-plannotator review: a guided review of the checkout's change,
// without Riker. It writes guide.json (Plannotator's snapshot),
// guide-findings.json and usage.json (each call's cost and tokens, for
// comparing models and batch sizes) to --out, imports the guide into
// Plannotator unless --no-plannotator, and with --open starts
// `plannotator review` with the findings posted as comments.

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { claudeAsk } from "./ask";
import { BATCH_CHARS } from "./batches";
import { freePort, postComments, saveGuide, snapshot, writeFindings } from "./guide";
import { setGuideLog } from "./log";
import { review } from "./review";

const USAGE = `usage: code-review-plannotator review [options]

  --cwd <dir>           the checkout (default: .)
  --base <branch>       what the change is against (default: main, or master)
  --model <model>       claude's model (default: claude's own)
  --claude <bin>        the claude binary (default: claude on PATH)
  --batch-chars <n>     numbered diff characters per call (default: ${BATCH_CHARS})
  --pr <n|url>          the pull request, for the guide and Plannotator
  --about <text>        what the change is for
  --out <dir>           where the files go (default: <cwd>/.code-review)
  --no-plannotator      write the files only; no Plannotator import
  --open                then open \`plannotator review\` with the findings as comments
  --quiet               no warnings on stderr
`;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    cwd: { type: "string" },
    base: { type: "string" },
    model: { type: "string" },
    claude: { type: "string" },
    "batch-chars": { type: "string" },
    pr: { type: "string" },
    about: { type: "string" },
    out: { type: "string" },
    "no-plannotator": { type: "boolean" },
    open: { type: "boolean" },
    quiet: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help || positionals[0] !== "review") {
  process.stdout.write(USAGE);
  process.exit(values.help ? 0 : 1);
}
if (values.open && values["no-plannotator"]) fail("--open needs Plannotator: drop --no-plannotator");

const cwd = resolve(values.cwd ?? ".");
const out = resolve(values.out ?? join(cwd, ".code-review"));
const batchChars = values["batch-chars"] ? Number(values["batch-chars"]) : undefined;
if (batchChars !== undefined && !(batchChars > 0)) fail("--batch-chars wants a positive number");
if (!values.quiet)
  setGuideLog({ warn: (msg, fields) => process.stderr.write(`warn: ${msg} ${JSON.stringify(fields ?? {})}\n`) });

const claude = claudeAsk({ cwd, model: values.model, claude: values.claude });
const ran = await review({
  cwd,
  ask: async (prompt, label) => {
    process.stderr.write(`${label}...\n`);
    return claude.ask(prompt, label);
  },
  base: values.base,
  pr: values.pr,
  about: values.about,
  batchChars,
});
if ("error" in ran) {
  if (ran.answer) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "answer.txt"), ran.answer);
  }
  fail(`no review: ${ran.error}${ran.answer ? ` (the answer is in ${join(out, "answer.txt")})` : ""}`);
}

let id = "";
if (values["no-plannotator"]) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "guide.json"), `${JSON.stringify(snapshot(ran.guide, ran.patch), null, 2)}\n`);
  writeFindings(out, { id, title: ran.guide.title, base: ran.patch.base, findings: ran.findings });
} else {
  const saved = await saveGuide({ guide: ran.answered, cwd, dir: out, patch: ran.patch, pr: values.pr });
  if ("error" in saved) fail(saved.error);
  id = saved.id;
}

const total = claude.total();
writeFileSync(
  join(out, "usage.json"),
  `${JSON.stringify(
    {
      model: values.model ?? null,
      batchChars: batchChars ?? BATCH_CHARS,
      base: ran.patch.base,
      mergeBase: ran.patch.mergeBase,
      batches: ran.plan.batches.map((b) => b.map((f) => f.file)),
      lockfiles: ran.plan.lockfiles,
      tooLarge: ran.plan.tooLarge,
      findings: ran.findings.length,
      gaps: ran.gaps,
      denied: ran.denied,
      total,
      calls: claude.calls,
    },
    null,
    2,
  )}\n`,
);

const chapters = ran.guide.sections.map((s) => s.title).join("; ");
process.stdout.write(
  [
    ran.guide.title,
    `${ran.guide.sections.length} chapters: ${chapters}`,
    ...ran.gaps,
    ...(ran.denied.length ? [`denied: ${ran.denied.join(", ")}`] : []),
    `${ran.findings.length} findings${ran.lines.length ? ":" : ""}`,
    ...ran.lines,
    `${total.calls} calls, $${total.costUsd.toFixed(4)}, ${total.inputTokens + total.cacheReadTokens + total.cacheWriteTokens} in / ${total.outputTokens} out tokens`,
    id ? `Plannotator guide ${id}; files in ${out}` : `files in ${out}`,
    "",
  ].join("\n"),
);

if (values.open) {
  const port = freePort();
  const proc = Bun.spawn(["plannotator", "review", "--base", ran.patch.base], {
    cwd,
    stdio: ["inherit", "inherit", "inherit"],
    env: { ...process.env, PLANNOTATOR_UPDATE_CHECK: "0", PLANNOTATOR_PORT: String(port) },
  });
  const posted = await postComments(port, ran.comments);
  if ("error" in posted) process.stderr.write(`comments not posted: ${posted.error}\n`);
  process.exit(await proc.exited);
}
