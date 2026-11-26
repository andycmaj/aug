import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeArgs, claudeAsk } from "../src/ask";
import { jobPrompt, skillBody, skillTools } from "../src/prompt";
import { review } from "../src/review";
import { ANSWER, repo } from "./support/repo";

// A `claude` that answers every call with the same JSON result, and keeps
// the prompt it read and the arguments it was given.
function fakeClaude(result: Record<string, unknown>): {
  bin: string;
  dir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "crp-claude-"));
  writeFileSync(join(dir, "result.json"), JSON.stringify(result));
  const bin = join(dir, "claude");
  writeFileSync(
    bin,
    `#!/bin/sh\ncat > "${dir}/prompt.txt"\nprintf '%s\\n' "$@" > "${dir}/args.txt"\ncat "${dir}/result.json"\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, dir };
}

const GUIDE_TEXT = `\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``;

describe("the instructions without riker", () => {
  test("the skill's body and tools come from its own file", () => {
    expect(skillBody().startsWith("---")).toBe(false);
    expect(skillBody()).toContain("job: whole");
    expect(skillTools()).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Bash(git log:*)",
      "Bash(git diff:*)",
      "Bash(git status:*)",
      "Bash(git show:*)",
      "Bash(git merge-base:*)",
    ]);
  });

  test("a job prompt names the base, the pull request and the job", () => {
    const text = jobPrompt({
      base: "origin/main",
      pr: "12",
      about: "division",
    })("notes, batch 1 of 2");
    expect(text).toContain("Base branch: origin/main");
    expect(text).toContain("Pull request: 12");
    expect(text).toContain("What the change is for: division");
    expect(text).toContain("Arguments: job: notes, batch 1 of 2");
  });

  test("a claude call is fresh and read-only, with only the skill's tools", () => {
    const args = claudeArgs({ cwd: "/x", model: "haiku" });
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob,Bash");
    expect(args.slice(args.indexOf("--allowedTools") + 1)).toEqual(
      skillTools(),
    );
  });
});

describe("claudeAsk", () => {
  test("keeps each call's cost, tokens and denials", async () => {
    const fake = fakeClaude({
      result: "ok",
      total_cost_usd: 0.25,
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 7,
      },
      permission_denials: [
        { tool_name: "Bash", tool_input: { command: "rm -rf /" } },
      ],
    });
    const claude = claudeAsk({ cwd: fake.dir, claude: fake.bin });
    const answer = await claude.ask("the prompt", "guide");
    await claude.ask("again", "chapters");
    expect(answer).toEqual({ text: "ok", denied: ["Bash rm -rf /"] });
    expect(readFileSync(join(fake.dir, "prompt.txt"), "utf8")).toBe("again");
    expect(claude.calls.map((c) => c.label)).toEqual(["guide", "chapters"]);
    const total = claude.total();
    expect(total).toMatchObject({
      calls: 2,
      costUsd: 0.5,
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 200,
    });
  });

  test("a failed call says so", async () => {
    const fake = fakeClaude({ result: "credit too low", is_error: true });
    await expect(
      claudeAsk({ cwd: fake.dir, claude: fake.bin }).ask("p", "guide"),
    ).rejects.toThrow("credit too low");
  });
});

describe("review", () => {
  test("one call for a small change, the guide fitted to the patch", async () => {
    const dir = repo();
    const prompts: string[] = [];
    const ran = await review({
      cwd: dir,
      ask: async (prompt) => {
        prompts.push(prompt);
        return { text: GUIDE_TEXT, denied: [] };
      },
    });
    if ("error" in ran) {
      throw new Error(ran.error);
    }
    expect(ran.calls).toBe(1);
    expect(prompts[0]).toContain("Arguments: job: whole");
    expect(prompts[0]).toContain("Base branch: main");
    expect(ran.guide.sections[0]!.diffs.map((d) => d.file)).toEqual([
      "math.ts",
    ]);
    expect(ran.guide.unplacedFiles).toEqual(["README.md"]);
    expect(ran.findings).toHaveLength(2);
    expect(ran.comments.map((c) => c.scope)).toEqual(["line", "file"]);
  });

  test("a small batch size makes one call per batch and one for the chapters", async () => {
    const dir = repo();
    const jobs: string[] = [];
    const ran = await review({
      cwd: dir,
      batchChars: 10,
      ask: async (prompt) => {
        const job = /job: (.*)$/m.exec(prompt)![1]!;
        jobs.push(job);
        return job.startsWith("notes")
          ? { text: JSON.stringify({ files: [] }), denied: [] }
          : { text: GUIDE_TEXT, denied: [] };
      },
    });
    if ("error" in ran) {
      throw new Error(ran.error);
    }
    expect(jobs.sort()).toEqual([
      "chapters",
      "notes, batch 1 of 2",
      "notes, batch 2 of 2",
    ]);
    expect(ran.calls).toBe(3);
  });
});

describe("the CLI", () => {
  test("writes the guide, the findings and the usage, with no Plannotator", async () => {
    const dir = repo();
    const fake = fakeClaude({
      result: GUIDE_TEXT,
      total_cost_usd: 0.1,
      usage: { input_tokens: 3, output_tokens: 4 },
    });
    const out = join(dir, "out");
    const proc = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "../src/cli.ts"),
        "review",
        "--cwd",
        dir,
        "--claude",
        fake.bin,
        "--out",
        out,
        "--no-plannotator",
        "--model",
        "haiku",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stderr).toContain("guide...");
    expect(code).toBe(0);
    expect(stdout).toContain("Add div");
    expect(stdout).toContain("2 findings:");
    expect(existsSync(join(out, "guide.json"))).toBe(true);
    const findings = JSON.parse(
      readFileSync(join(out, "guide-findings.json"), "utf8"),
    );
    expect(findings.findings).toHaveLength(2);
    const usage = JSON.parse(readFileSync(join(out, "usage.json"), "utf8"));
    expect(usage).toMatchObject({
      model: "haiku",
      findings: 2,
      total: { calls: 1, costUsd: 0.1 },
    });
    expect(readFileSync(join(fake.dir, "args.txt"), "utf8")).toContain("haiku");
  });
});
