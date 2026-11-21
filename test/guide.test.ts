import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setBrain, type BrainResult } from "../src/core/brain";
import { Engine } from "../src/core/engine";
import {
  fitGuide,
  parseGuide,
  patchFor,
  patchHunks,
  setGuideTool,
} from "../src/core/guide";
import { setMux } from "../src/core/mux";
import * as store from "../src/core/store";
import { Kind, TurnRole } from "../src/core/types";
import { FakeMux } from "./fake-mux";
import { freshHome, testConfig } from "./helpers";

function sh(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
  return r.stdout.toString();
}

// A repo on a feature branch that adds div to math.ts and a README line.
function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "aug-guide-"));
  const git = (...a: string[]) =>
    sh(dir, "git", "-c", "user.email=t@t", "-c", "user.name=t", ...a);
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "math.ts"), "export function add(a: number, b: number) {\n  return a + b;\n}\n");
  writeFileSync(join(dir, "README.md"), "# math\n");
  git("add", ".");
  git("commit", "-qm", "base");
  git("checkout", "-qb", "feature");
  writeFileSync(
    join(dir, "math.ts"),
    "export function add(a: number, b: number) {\n  return a + b;\n}\n\nexport function div(a: number, b: number) {\n  return a / b;\n}\n",
  );
  writeFileSync(join(dir, "README.md"), "# math\n\nAdds and divides.\n");
  git("commit", "-qam", "div");
  return dir;
}

const ANSWER = {
  title: "Add div",
  intent: "Division for the calculator.",
  sections: [
    {
      title: "Division",
      overview: "A new `div` function.",
      diffs: [
        {
          file: "math.ts",
          summary: "Adds `div`.",
          notes: [
            { lineStart: 6, lineEnd: 6, text: "Bug: b of 0 gives Infinity." },
            { lineStart: 40, lineEnd: 40, text: "Nit: outside every hunk." },
          ],
        },
        { file: "invented.ts", summary: "not in the patch" },
      ],
    },
  ],
  unplacedFiles: [],
};

describe("the guide's JSON", () => {
  test("is read from a json fence", () => {
    const g = parseGuide(`Here:\n\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\`\n`);
    if ("error" in g) throw new Error(g.error);
    expect(g.sections[0]!.diffs[0]!.notes).toHaveLength(2);
  });

  test("not JSON, or no chapters, says so", () => {
    expect(parseGuide("no")).toHaveProperty("error");
    expect(parseGuide('{"title":"x","sections":[]}')).toHaveProperty("error");
  });
});

describe("fitted to the patch", () => {
  test("files it lacks go, files it left out are unplaced, notes outside a hunk stay in the overview only", () => {
    const dir = repo();
    const patch = patchFor(dir, "main");
    if ("error" in patch) throw new Error(patch.error);
    expect([...patchHunks(patch.text).keys()].sort()).toEqual(["README.md", "math.ts"]);

    const parsed = parseGuide(JSON.stringify(ANSWER));
    if ("error" in parsed) throw new Error(parsed.error);
    const { guide, findings } = fitGuide(parsed, patch.text);
    expect(findings).toBe(2);
    const section = guide.sections[0]!;
    expect(section.diffs.map((d) => d.file)).toEqual(["math.ts"]);
    expect(section.diffs[0]!.notes!.map((n) => n.lineStart)).toEqual([6]);
    expect(section.overview).toContain("**Review notes**");
    expect(section.overview).toContain("`math.ts` L40: Nit: outside every hunk.");
    expect(guide.unplacedFiles).toEqual(["README.md"]);
  });

  test("a new file not yet added is in the patch", () => {
    const dir = repo();
    writeFileSync(join(dir, "mod.ts"), "export const m = 1;\n");
    const patch = patchFor(dir, "main");
    if ("error" in patch) throw new Error(patch.error);
    expect([...patchHunks(patch.text).keys()]).toContain("mod.ts");
    // The agent's index is left as it was.
    expect(sh(dir, "git", "status", "--porcelain")).toContain("?? mod.ts");
  });

  test("master when there is no main", () => {
    const dir = repo();
    sh(dir, "git", "branch", "-m", "main", "master");
    const patch = patchFor(dir, "main");
    if ("error" in patch) throw new Error(patch.error);
    expect(patch.base).toBe("master");
  });
});

describe("the guide action", () => {
  let saved: { file: string; cwd: string; pr?: string }[];

  beforeEach(() => {
    freshHome({ autostart: false });
    setMux(new FakeMux());
    saved = [];
    setGuideTool({
      async save(file, cwd, pr) {
        saved.push({ file, cwd, pr });
        return { id: "1795-add-div" };
      },
    });
  });
  afterEach(() => setGuideTool(null));

  function answering(text: string) {
    setBrain(
      async (): Promise<BrainResult> => ({
        text,
        structured: null,
        sessionId: null,
        durationMs: 1,
        isError: false,
      }),
    );
  }

  function codingTask(worktree: string) {
    const engine = new Engine({ config: testConfig() });
    const t = engine.desk.newTask("Add div", Kind.coding);
    store.updateTask(t.id, { worktree });
    return { engine, task: store.getTask(t.id)! };
  }

  test("saves a v4 snapshot into Plannotator and opens its review", async () => {
    const dir = repo();
    answering(`\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\``);
    const { engine, task } = codingTask(dir);
    const started = engine.desk.runAction(task.id, "guide");
    if ("error" in started) throw new Error(started.error);
    const result = await started.done;
    expect(result.ok).toBe(true);

    expect(saved).toHaveLength(1);
    expect(saved[0]!.cwd).toBe(dir);
    const snap = JSON.parse(readFileSync(saved[0]!.file, "utf8")) as {
      version: number;
      review: { rawPatch: string };
    };
    expect(snap.version).toBe(4);
    expect(snap.review.rawPatch).toContain("+export function div");

    expect(result.terminal!.argv.join(" ")).toContain("plannotator review --base");
    expect(result.terminal!.cwd).toBe(dir);
    expect(result.terminal!.feedback).toEndWith("guide-feedback.md");

    const turn = store.turnsForTask(task.id).find((x) => x.role === TurnRole.action)!;
    expect(turn.status).toBe("done");
    expect(turn.body).toContain("2 review notes (1 not on a changed line)");
    expect(turn.body).toContain("Bug: b of 0 gives Infinity.");
    expect(turn.body).toContain("1795-add-div");
  });

  test("an answer that is not a guide fails, and is kept as a file", async () => {
    const dir = repo();
    answering("I could not write it.");
    const { engine, task } = codingTask(dir);
    const started = engine.desk.runAction(task.id, "guide");
    if ("error" in started) throw new Error(started.error);
    const result = await started.done;
    expect(result.ok).toBe(false);
    expect(saved).toHaveLength(0);
    const turn = store.turnsForTask(task.id).find((x) => x.role === TurnRole.action)!;
    expect(turn.status).toBe("failed");
    expect(turn.body).toContain("not JSON");
    const files = JSON.parse(turn.files ?? "[]") as { path: string }[];
    expect(readFileSync(files[0]!.path, "utf8")).toContain("could not write it");
  });
});
