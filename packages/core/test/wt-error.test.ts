import { describe, expect, test } from "bun:test";
import { wtError } from "../src/mux";

// What wt v0.81 prints on stderr when remove refuses (from a scratch repo).
describe("wtError", () => {
  test("keeps the reason, not only the hint under it", () => {
    const stderr =
      "✗ No branch named feat/site\n↳ To list branches, run wt list --branches --remotes\n";
    expect(wtError(stderr, "wt remove exited 1")).toBe(
      "No branch named feat/site. To list branches, run wt list --branches --remotes",
    );
  });

  test("names the dirty files", () => {
    const stderr =
      "\u001b[31m✗\u001b[39m Cannot remove worktree: w2 has uncommitted changes\n" +
      "  ?? x\n" +
      "   M src/a.ts\n" +
      "↳ Commit or run git stash -u in the dirty worktree first, or to lose uncommitted changes, run wt remove --force w2\n";
    expect(wtError(stderr, "wt remove exited 1")).toBe(
      "Cannot remove worktree: w2 has uncommitted changes (?? x, M src/a.ts). " +
        "Commit or run git stash -u in the dirty worktree first, or to lose uncommitted changes, run wt remove --force w2",
    );
  });

  test("falls back when wt says nothing", () => {
    expect(wtError("  \n", "wt remove exited 1")).toBe("wt remove exited 1");
  });
});
