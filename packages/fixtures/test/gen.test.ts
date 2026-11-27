// The review activity generator, end to end on the sim: its moves land in
// the sim's state file and Riker reads them through the real pollGithub,
// so what it makes is what triage sees. The GitHub target is checked
// against a fake API: the calls it makes, in order, with what they carry.

import { beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollGithub } from "@riker/github/ingest";
import { reviewIsYours } from "@riker/triage/triage";
import { freshHome } from "@riker/core/test/support/helpers";
import type { MessageRow } from "@riker/core/types";
import { applyToFile } from "../src/sim/events";
import {
  emptyState,
  loadState,
  saveState,
  simApi,
  SIM_ME,
  SIM_REPO,
} from "../src/sim/github";
import { appJwt, githubTarget } from "../src/gen/github-target";
import { Ask, DEFAULT_LIMITS, PrState } from "../src/gen/plan";
import { EMPTY_STATE, tick, type Changes } from "../src/gen/run";
import { GEN_AUTHOR, simTarget } from "../src/gen/sim-target";
import type { Change } from "../src/gen/target";

let file: string;

const change: Change = {
  title: "Tidy the rail's sub line",
  body: "Shorter words.",
  files: [{ path: "a.ts", content: "export const a = 1;\n" }],
  source: "commit abc1234",
};
const changes: Changes = { next: async () => ({ change }) };
const fresh = () => structuredClone(EMPTY_STATE);

beforeEach(() => {
  freshHome();
  file = join(process.env.RIKER_HOME ?? "", "sim", "github.json");
  saveState(file, emptyState({}));
});

describe("on the sim", () => {
  test("a PR asking you is a review request Riker hears from its author", async () => {
    const state = fresh();
    const { said } = await tick(simTarget(file), state, changes, {
      moves: [{ type: "open", ask: Ask.me }],
    });
    expect(said[0]).toMatch(/^opened #1 \(commit abc1234\), asking you/);
    expect(state.nextAsk).toBe(Ask.team);
    const [m] = await pollGithub(null, simApi(file));
    expect(m).toMatchObject({
      author: GEN_AUTHOR,
      title: `${SIM_REPO}#1 PR: Tidy the rail's sub line (review requested)`,
    });
    expect(m!.meta).toMatchObject({
      reason: "review_requested",
      requested: { me: true, teams: [] },
    });
  });

  test("a PR asking your team is one the sim's triage takes as yours", async () => {
    await tick(simTarget(file), fresh(), changes, {
      moves: [{ type: "open", ask: Ask.team }],
    });
    const [m] = await pollGithub(null, simApi(file));
    expect(m!.meta).toMatchObject({
      reason: "review_requested",
      requested: { me: false, teams: ["sim/reviewers"] },
    });
    const row = {
      channel: "github",
      body: m!.body,
      meta: JSON.stringify(m!.meta),
    } as MessageRow;
    expect(reviewIsYours(row, ["sim/reviewers"])).toEqual({
      ok: true,
      value: "a review requested from sim/reviewers, a team you watch",
    });
  });

  test("your changes get a follow-up and a new ask; your approval merges it", async () => {
    const target = simTarget(file);
    const state = fresh();
    await tick(target, state, changes, {
      moves: [{ type: "open", ask: Ask.me }],
    });
    await Bun.sleep(5);
    applyToFile(file, {
      type: "review",
      pr: 1,
      by: SIM_ME,
      verdict: "changes",
      comments: 1,
    });
    const later = {
      now: new Date(Date.now() + 1000),
      limits: { ...DEFAULT_LIMITS, maxOpen: 1 },
    };
    const followed = await tick(target, state, changes, later);
    expect(followed.said).toEqual([
      "#1: pushed a follow-up (commit abc1234) and asked you again",
    ]);
    const s = loadState(file);
    expect(s.pulls[0]!.requested).toContain(SIM_ME);
    expect(s.comments.at(-1)).toMatchObject({ user: GEN_AUTHOR, pr: 1 });
    // Answered: nothing more until you review again.
    expect((await tick(target, state, changes, later)).said).toEqual([]);

    await Bun.sleep(5);
    applyToFile(file, {
      type: "review",
      pr: 1,
      by: SIM_ME,
      verdict: "approve",
    });
    const merged = await tick(target, state, changes, {
      ...later,
      now: new Date(Date.now() + 2000),
    });
    expect(merged.said).toEqual(["#1: merged after your approval"]);
    expect((await target.list())[0]!.state).toBe(PrState.merged);
  });

  test("a comment review is answered once", async () => {
    const target = simTarget(file);
    const state = fresh();
    await tick(target, state, changes, {
      moves: [{ type: "open", ask: Ask.me }],
    });
    await Bun.sleep(5);
    applyToFile(file, {
      type: "review",
      pr: 1,
      by: SIM_ME,
      verdict: "comment",
      comments: 0,
    });
    const later = {
      now: new Date(Date.now() + 1000),
      limits: { ...DEFAULT_LIMITS, maxOpen: 1 },
    };
    expect((await tick(target, state, changes, later)).said).toEqual([
      "#1: answered your comments",
    ]);
    expect((await tick(target, state, changes, later)).said).toEqual([]);
  });
});

describe("on GitHub, as an App", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  test("its token is a JWT signed with the App's key", () => {
    const jwt = appJwt("123", pem, Date.UTC(2026, 10, 23));
    const [head, body, sig] = jwt.split(".");
    expect(
      JSON.parse(Buffer.from(body!, "base64url").toString()),
    ).toMatchObject({ iss: "123" });
    const verify = createVerify("RSA-SHA256");
    verify.update(`${head}.${body}`);
    expect(verify.verify(publicKey, Buffer.from(sig!, "base64url"))).toBe(true);
  });

  function fakeGithub() {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const answers: Record<string, unknown> = {
      "POST /app/installations/9/access_tokens": {
        token: "ghs_x",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
      },
      "GET /git/ref/heads/main": { object: { sha: "main1" } },
      "GET /git/commits/main1": { tree: { sha: "tree1" } },
      "GET /git/commits/head1": { tree: { sha: "tree2" } },
      "POST /git/blobs": { sha: "blob1" },
      "POST /git/trees": { sha: "tree3" },
      "POST /git/commits": { sha: "commit1" },
      "POST /git/refs": {},
      "POST /pulls": {
        number: 7,
        html_url: "https://github.com/lab/repo/pull/7",
      },
      "POST /pulls/7/requested_reviewers": {},
      "GET /pulls/7": {
        number: 7,
        head: { ref: "riker-gen/abc", sha: "head1" },
      },
      "PATCH /git/refs/heads/riker-gen/abc": {},
      "POST /issues/7/comments": {},
      "PATCH /pulls/7": {
        number: 7,
        head: { ref: "riker-gen/abc", sha: "head1" },
      },
      "DELETE /git/refs/heads/riker-gen/abc": null,
    };
    const fetcher = async (url: string, init?: RequestInit) => {
      const path = url
        .replace("https://api.github.com", "")
        .replace("/repos/lab/repo", "");
      const key = `${init?.method ?? "GET"} ${path}`;
      calls.push({
        method: init?.method ?? "GET",
        path,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      if (!(key in answers)) {
        return new Response("not here", { status: 404 });
      }
      const a = answers[key];
      return a === null
        ? new Response(null, { status: 204 })
        : Response.json(a);
    };
    const target = githubTarget(
      {
        repo: "lab/repo",
        appId: "1",
        installationId: "9",
        keyPath: "",
        me: "andy",
        team: "lab/reviewers",
      },
      fetcher,
      () => pem,
    );
    return { target, calls };
  }

  test("a PR asking your team: one commit over main, a branch of its own, the team asked", async () => {
    const { target, calls } = fakeGithub();
    const opened = await target.open(change, Ask.team);
    expect(opened).toEqual({
      number: 7,
      url: "https://github.com/lab/repo/pull/7",
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /app/installations/9/access_tokens",
      "GET /git/ref/heads/main",
      "GET /git/commits/main1",
      "POST /git/blobs",
      "POST /git/trees",
      "POST /git/commits",
      "POST /git/refs",
      "POST /pulls",
      "POST /pulls/7/requested_reviewers",
    ]);
    expect(calls[4]!.body).toEqual({
      base_tree: "tree1",
      tree: [{ path: "a.ts", mode: "100644", type: "blob", sha: "blob1" }],
    });
    expect((calls[6]!.body as { ref: string }).ref).toMatch(
      /^refs\/heads\/riker-gen\//,
    );
    expect(calls[8]!.body).toEqual({ team_reviewers: ["reviewers"] });
  });

  test("a follow-up: a commit on its branch, a reply, and you asked again; the token is reused", async () => {
    const { target, calls } = fakeGithub();
    await target.followUp(7, change, "Fixed, another look?");
    const said = calls.map((c) => `${c.method} ${c.path}`);
    expect(said.filter((c) => c.includes("access_tokens"))).toHaveLength(1);
    expect(said.slice(1)).toEqual([
      "GET /pulls/7",
      "GET /git/commits/head1",
      "POST /git/blobs",
      "POST /git/trees",
      "POST /git/commits",
      "PATCH /git/refs/heads/riker-gen/abc",
      "POST /issues/7/comments",
      "POST /pulls/7/requested_reviewers",
    ]);
    expect(calls.at(-1)!.body).toEqual({ reviewers: ["andy"] });
  });

  test("closing deletes its branch", async () => {
    const { target, calls } = fakeGithub();
    await target.close(7);
    expect(calls.slice(1).map((c) => `${c.method} ${c.path}`)).toEqual([
      "PATCH /pulls/7",
      "DELETE /git/refs/heads/riker-gen/abc",
    ]);
  });
});

describe("the donor", () => {
  test("replays each commit after the seed as a change: its words and whole files", async () => {
    const { donorCommits, nextChange } = await import("../src/gen/donor");
    const dir = mkdtempSync(join(tmpdir(), "riker-gen-donor-"));
    const git = (...a: string[]) =>
      Bun.spawnSync(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", ...a],
        { cwd: dir, stdout: "pipe" },
      );
    git("init", "-q", "-b", "main");
    writeFileSync(
      join(dir, "math.ts"),
      "export const add = (a: number, b: number) => a + b;\n",
    );
    writeFileSync(join(dir, "README.md"), "# math\n");
    git("add", ".");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "feature");
    writeFileSync(
      join(dir, "math.ts"),
      "export const add = (a: number, b: number) => a + b;\nexport function div(a: number, b: number) {\n  return a / b;\n}\n",
    );
    writeFileSync(join(dir, "README.md"), "# math\n\nAdds and divides.\n");
    git(
      "commit",
      "-qam",
      "div\n\nDivision too.\n\nCo-Authored-By: someone <x@y>",
    );
    const commits = donorCommits(dir, "main", "feature");
    expect(commits).toHaveLength(1);
    const next = nextChange(dir, commits, 0)!;
    expect(next.cursor).toBe(1);
    expect(next.change.title).toBe("div");
    expect(next.change.body).toMatch(
      /^Division too\.\n\nReplayed from [0-9a-f]{7}/,
    );
    expect(next.change.body).not.toContain("Co-Authored-By");
    expect(next.change.files.map((f) => f.path).sort()).toEqual([
      "README.md",
      "math.ts",
    ]);
    expect(
      next.change.files.find((f) => f.path === "math.ts")!.content,
    ).toContain("export function div");
    expect(nextChange(dir, commits, 1)).toBeNull();
  });
});
