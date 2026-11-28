import { describe, expect, test } from "bun:test";
import {
  githubReviews,
  readReviewContext,
  type ReviewContextData,
} from "../src/review-context";

const pr = {
  repo: "acme/api",
  number: 40,
  url: "https://github.com/acme/api/pull/40",
};

function data(
  over: Partial<
    NonNullable<NonNullable<ReviewContextData["repository"]>["pullRequest"]>
  > = {},
): ReviewContextData {
  return {
    viewer: { login: "Me" },
    repository: {
      pullRequest: {
        title: "Speed up export",
        body: "Fixes #12. Spec: https://www.notion.so/acme/Export-123 and https://github.com/acme/api/issues/9",
        author: { login: "erin" },
        closingIssuesReferences: {
          nodes: [
            {
              number: 12,
              title: "Export is slow",
              body: "Takes 40s on big accounts.",
              repository: { nameWithOwner: "acme/api" },
            },
          ],
        },
        reviews: {
          nodes: [
            {
              author: { login: "me" },
              state: "CHANGES_REQUESTED",
              submittedAt: "2026-11-01T00:00:00Z",
              commit: { oid: "aaa1111" },
            },
            {
              author: { login: "carol" },
              state: "APPROVED",
              submittedAt: "2026-11-02T00:00:00Z",
              commit: { oid: "bbb2222" },
            },
            {
              author: { login: "me" },
              state: "COMMENTED",
              submittedAt: "2026-11-03T00:00:00Z",
              commit: { oid: "ccc3333" },
            },
            {
              author: { login: "me" },
              state: "PENDING",
              submittedAt: null,
              commit: { oid: "ddd4444" },
            },
          ],
        },
        reviewThreads: {
          nodes: [
            {
              isResolved: false,
              isOutdated: false,
              path: "src/export.ts",
              line: 42,
              comments: {
                nodes: [
                  { author: { login: "carol" }, body: "Stream this instead?" },
                  { author: { login: "erin" }, body: "Done." },
                ],
              },
            },
            {
              isResolved: true,
              isOutdated: false,
              path: "README.md",
              line: null,
              comments: { nodes: [{ author: null, body: "typo" }] },
            },
          ],
        },
        ...over,
      },
    },
  };
}

describe("what the guide reads beside a PR asked of you", () => {
  test("its words, the issues it closes, the threads on it, and where you last reviewed", () => {
    const read = readReviewContext(pr, data());
    // Your last submitted review, a comment-only one too; never a pending one.
    expect(read.lastReviewed).toBe("ccc3333");
    expect(read.text).toContain("Title: Speed up export");
    expect(read.text).toContain("Author: erin");
    expect(read.text).toContain(
      "- acme/api#12 Export is slow\nTakes 40s on big accounts.",
    );
    expect(read.text).toContain("not read (outside GitHub");
    expect(read.text).toContain("- https://www.notion.so/acme/Export-123");
    expect(read.text).not.toContain("- https://github.com/acme/api/issues/9");
    expect(read.text).toContain(
      "- src/export.ts:42 (open)\n  carol: Stream this instead?\n  erin: Done.",
    );
    expect(read.text).toContain("- README.md (resolved)\n  ghost: typo");
    expect(read.text).toContain(
      "Reviews so far: me changes requested, carol approved",
    );
  });

  test("never reviewed: no commit to review since", () => {
    expect(
      readReviewContext(pr, data({ reviews: { nodes: [] } })).lastReviewed,
    ).toBeNull();
  });

  test("one GraphQL read with the PR's owner, name and number", async () => {
    const calls: Record<string, string | number>[] = [];
    const source = githubReviews(async (_q, vars) => {
      calls.push(vars);
      return { data: data() };
    });
    await source.context(pr);
    expect(calls).toEqual([{ owner: "acme", name: "api", number: 40 }]);
    const failing = githubReviews(async () => ({
      errors: [{ message: "Could not resolve to a PullRequest" }],
    }));
    await expect(failing.context(pr)).rejects.toThrow(
      "Could not resolve to a PullRequest",
    );
  });
});

describe("the PR's head", () => {
  test("is its head commit and branch, read for that PR", async () => {
    const calls: { query: string; vars: Record<string, string | number> }[] =
      [];
    const source = githubReviews(async (query, vars) => {
      calls.push({ query, vars });
      return {
        data: {
          repository: {
            pullRequest: { headRefOid: "abc1234def", headRefName: "export" },
          },
        },
      };
    });
    expect(await source.head!(pr)).toEqual({
      oid: "abc1234def",
      branch: "export",
    });
    expect(calls[0]!.vars).toEqual({ owner: "acme", name: "api", number: 40 });
    expect(calls[0]!.query).toContain("headRefOid");
  });

  test("a PR GitHub does not answer for throws, so the guide says so", async () => {
    const gone = githubReviews(async () => ({
      data: { repository: { pullRequest: null } },
    }));
    await expect(gone.head!(pr)).rejects.toThrow("acme/api#40 not found");
    const failing = githubReviews(async () => ({
      errors: [{ message: "API rate limit exceeded" }],
    }));
    await expect(failing.head!(pr)).rejects.toThrow("API rate limit exceeded");
  });
});
