import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fitGuide,
  freePort,
  parseGuide,
  postComments,
  patchFor,
  patchHunks,
  reviewComments,
  reviewNotes,
  type ReviewComment,
} from "../src/guide";
import { fakeReview } from "./support/fake-review";
import { ANSWER, repo, sh } from "./support/repo";

describe("the guide's JSON", () => {
  test("is read from a json fence", () => {
    const g = parseGuide(
      `Here:\n\`\`\`json\n${JSON.stringify(ANSWER)}\n\`\`\`\n`,
    );
    if ("error" in g) {
      throw new Error(g.error);
    }
    expect(g.sections[0]!.diffs[0]!.notes).toHaveLength(2);
  });

  test("not JSON, or no chapters, says so", () => {
    expect(parseGuide("no")).toHaveProperty("error");
    expect(parseGuide('{"title":"x","sections":[]}')).toHaveProperty("error");
  });
});

describe("fitted to the patch", () => {
  test("files it lacks go, files it left out are unplaced, every note is a review comment", () => {
    const dir = repo();
    const patch = patchFor(dir, "main");
    if ("error" in patch) {
      throw new Error(patch.error);
    }
    expect([...patchHunks(patch.text).keys()].sort()).toEqual([
      "README.md",
      "math.ts",
    ]);

    const parsed = parseGuide(JSON.stringify(ANSWER));
    if ("error" in parsed) {
      throw new Error(parsed.error);
    }
    const { guide, findings, comments } = fitGuide(parsed, patch.text);
    expect(findings.map((f) => f.note.lineStart)).toEqual([6, 40]);
    const section = guide.sections[0]!;
    expect(section.diffs.map((d) => d.file)).toEqual(["math.ts"]);
    expect(section.diffs[0]!.notes!.map((n) => n.lineStart)).toEqual([6]);
    expect(section.overview).toBe("A new `div` function.");
    expect(guide.unplacedFiles).toEqual(["README.md"]);
    // On its line when a hunk shows it; on its file, naming the line, when not.
    expect(comments).toEqual([
      {
        source: "riker-guide",
        author: "riker guide",
        scope: "line",
        filePath: "math.ts",
        lineStart: 6,
        lineEnd: 6,
        side: "new",
        type: "concern",
        text: "Bug: b of 0 gives Infinity.",
      },
      {
        source: "riker-guide",
        author: "riker guide",
        scope: "file",
        filePath: "math.ts",
        type: "comment",
        text: "L40: Nit: outside every hunk.",
      },
    ]);
  });

  test("a new file not yet added is in the patch", () => {
    const dir = repo();
    writeFileSync(join(dir, "mod.ts"), "export const m = 1;\n");
    const patch = patchFor(dir, "main");
    if ("error" in patch) {
      throw new Error(patch.error);
    }
    expect([...patchHunks(patch.text).keys()]).toContain("mod.ts");
    // The agent's index is left as it was.
    expect(sh(dir, "git", "status", "--porcelain")).toContain("?? mod.ts");
  });

  test("master when there is no main", () => {
    const dir = repo();
    sh(dir, "git", "branch", "-m", "main", "master");
    const patch = patchFor(dir, "main");
    if ("error" in patch) {
      throw new Error(patch.error);
    }
    expect(patch.base).toBe("master");
  });
});

describe("refit to a later patch", () => {
  test("lines a hunk still shows stay on them, others go to the file, files out of the change are left out", () => {
    const patch = [
      "diff --git a/math.ts b/math.ts",
      "--- a/math.ts",
      "+++ b/math.ts",
      "@@ -3,0 +4,6 @@",
      "+x",
      "diff --git a/README.md b/README.md",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1,3 @@",
      "+y",
      "",
    ].join("\n");
    const { comments, dropped } = reviewComments(
      [
        {
          file: "math.ts",
          note: { lineStart: 6, lineEnd: 7, text: "Bug: in the hunk" },
        },
        {
          file: "math.ts",
          note: { lineStart: 12, lineEnd: 12, text: "Nit: moved out of it" },
        },
        {
          file: "gone.ts",
          note: { lineStart: 1, lineEnd: 1, text: "Risk: file reverted" },
        },
      ],
      patch,
    );
    expect(dropped).toBe(1);
    expect(
      comments.map((c) => [c.scope, c.filePath, c.lineStart ?? null, c.text]),
    ).toEqual([
      ["line", "math.ts", 6, "Bug: in the hunk"],
      ["file", "math.ts", null, "L12: Nit: moved out of it"],
    ]);
  });
});

describe("what the review sends back", () => {
  test("an approval or a review closed without feedback is nothing to pass on", () => {
    expect(reviewNotes("")).toBeNull();
    expect(reviewNotes("The user approved.\n")).toBeNull();
    expect(reviewNotes("Review session closed without feedback.\n")).toBeNull();
    expect(reviewNotes("# Code Review Feedback\n\nBug: x\n")).toBe(
      "# Code Review Feedback\n\nBug: x",
    );
  });
});

describe("posting the comments", () => {
  test("Riker's earlier comments are cleared before posting, so they are there once", async () => {
    const review = fakeReview();
    const comment: ReviewComment = {
      source: "riker-guide",
      author: "riker guide",
      scope: "file",
      filePath: "math.ts",
      type: "comment",
      text: "L1: Nit: x",
    };
    await postComments(review.server.port!, [comment], {
      waitMs: 3000,
      everyMs: 50,
    });
    await postComments(review.server.port!, [comment], {
      waitMs: 3000,
      everyMs: 50,
    });
    void review.server.stop(true);
    expect(review.calls).toEqual([
      "DELETE /api/external-annotations?source=riker-guide",
      "DELETE /api/external-annotations?source=aug-guide",
      "POST /api/external-annotations",
      "DELETE /api/external-annotations?source=riker-guide",
      "DELETE /api/external-annotations?source=aug-guide",
      "POST /api/external-annotations",
    ]);
    expect(review.held()).toEqual([comment]);
  });

  test("waits for the review to come up, then posts them as one batch", async () => {
    const port = freePort();
    const got: unknown[] = [];
    // Plannotator starts a moment after Riker begins posting.
    let server: ReturnType<typeof Bun.serve> | null = null;
    setTimeout(() => {
      server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        async fetch(req) {
          const path = new URL(req.url).pathname;
          if (path === "/api/diff") {
            return Response.json({ rawPatch: "" });
          }
          if (req.method === "DELETE") {
            return Response.json({ ok: true });
          }
          got.push({ path, body: await req.json() });
          return Response.json({ ids: ["a"] }, { status: 201 });
        },
      });
    }, 150);
    const comment = {
      source: "riker-guide",
      author: "riker guide",
      scope: "file" as const,
      filePath: "math.ts",
      type: "comment" as const,
      text: "L1: Nit: x",
    };
    const r = await postComments(port, [comment], {
      waitMs: 3000,
      everyMs: 50,
    });
    void server!.stop(true);
    expect(r).toEqual({ ok: true });
    expect(got).toEqual([
      { path: "/api/external-annotations", body: { annotations: [comment] } },
    ]);
  });

  test("a port something else took gets nothing", async () => {
    let posted = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        if (req.method === "POST") {
          posted++;
        }
        return new Response("not found", { status: 404 });
      },
    });
    const r = await postComments(
      server.port!,
      [
        {
          source: "s",
          author: "a",
          scope: "file",
          filePath: "f",
          type: "comment",
          text: "t",
        },
      ],
      { waitMs: 3000, everyMs: 50 },
    );
    void server.stop(true);
    expect("error" in r && r.error).toContain("is not a Plannotator review");
    expect(posted).toBe(0);
  });

  test("a refusal is not retried, and nothing answering gives up", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (req) =>
        new URL(req.url).pathname === "/api/diff"
          ? Response.json({ rawPatch: "" })
          : Response.json({ error: "annotations[0] missing" }, { status: 400 }),
    });
    const refused = await postComments(
      server.port!,
      [
        {
          source: "s",
          author: "a",
          scope: "file",
          filePath: "f",
          type: "comment",
          text: "t",
        },
      ],
      { waitMs: 3000, everyMs: 50 },
    );
    void server.stop(true);
    expect("error" in refused && refused.error).toContain(
      "refused the comments (400)",
    );

    const silent = await postComments(
      freePort(),
      [
        {
          source: "s",
          author: "a",
          scope: "file",
          filePath: "f",
          type: "comment",
          text: "t",
        },
      ],
      { waitMs: 200, everyMs: 50 },
    );
    expect(silent).toHaveProperty("error");
  });
});
