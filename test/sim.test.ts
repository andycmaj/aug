// The sim's fake GitHub, read through the real parsers: pollGithub and
// toMessage for notifications, readPrBatch and readPrView for PR status.
// If a shape drifts from what aug parses, these fail.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/core/engine";
import { unreadFeedback } from "../src/core/feedback";
import { pollGithub } from "../src/core/ingest/github";
import { setMux } from "../src/core/mux";
import { prChip, prBatchQuery, readPrView, type PrRef } from "../src/core/pr";
import * as store from "../src/core/store";
import { Kind, PrChecks, PrReview, PrState } from "../src/core/types";
import {
  diffLines,
  makeCheckout,
  repoRoot,
  type SimCheckout,
} from "../src/fixtures/sim/checkout";
import {
  applyEvent,
  SCENARIOS,
  type SimEvent,
} from "../src/fixtures/sim/events";
import {
  emptyState,
  saveState,
  simApi,
  simPrFetch,
  SIM_ME,
  SIM_REPO,
  type SimState,
} from "../src/fixtures/sim/github";
import { linkOpened } from "../src/fixtures/sim/link";
import { FakeMux } from "./fake-mux";
import { fakeBrain, freshHome, testConfig } from "./helpers";

let checkout: SimCheckout;
let file: string;
let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "aug-sim-test-"));
  checkout = makeCheckout(repoRoot(process.cwd()), scratch);
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function simState(over: Partial<SimState> = {}): SimState {
  return emptyState({
    checkout: checkout.path,
    base: checkout.base,
    commits: checkout.commits,
    work: { taskId: null, ...checkout.work },
    ...over,
  });
}

// Apply events and write the file the fakes read.
function happen(s: SimState, ...events: SimEvent[]): SimState {
  for (const e of events) applyEvent(s, e);
  saveState(file, s);
  return s;
}

const ref = (n: number): PrRef => ({
  repo: SIM_REPO,
  number: n,
  url: `https://github.com/${SIM_REPO}/pull/${n}`,
});

async function status(n: number) {
  const got = (await simPrFetch(file)([ref(n)])).views.get(ref(n).url);
  if (!got || got instanceof Error) throw got ?? new Error("missing");
  return readPrView(got);
}

beforeEach(() => {
  freshHome();
  setMux(new FakeMux());
  file = join(process.env.AUG_HOME ?? "", "sim", "github.json");
});

describe("the checkout", () => {
  test("has no remote, and main sits behind the work branch", () => {
    const remotes = Bun.spawnSync(["git", "-C", checkout.path, "remote"])
      .stdout.toString()
      .trim();
    expect(remotes).toBe("");
    expect(checkout.commits.length).toBeGreaterThan(0);
    expect(
      diffLines(checkout.path, "main", checkout.work.branch).files.length,
    ).toBeGreaterThan(0);
  });
});

describe("notifications, through pollGithub and toMessage", () => {
  test("a review asked of you: a PR message naming you, with its head", async () => {
    happen(simState(), { type: "pr-open", by: "bob", title: "Tidy up" });
    const [m] = await pollGithub(null, simApi(file));
    expect(m.threadKey).toBe(`github:${SIM_REPO}#1`);
    expect(m.author).toBe("bob");
    expect(m.fromMe).toBe(false);
    expect(m.title).toBe(`${SIM_REPO}#1 PR: Tidy up (review requested)`);
    expect(m.url).toBe(`https://github.com/${SIM_REPO}/pull/1`);
    expect(m.meta).toMatchObject({
      repo: SIM_REPO,
      number: 1,
      type: "PullRequest",
      reason: "review_requested",
      head: "sim/pr-1",
      requested: { me: true, teams: [] },
    });
  });

  test("your own PR is heard only when someone else acts on it", async () => {
    const s = happen(simState(), { type: "pr-open", mine: true });
    expect(await pollGithub(null, simApi(file))).toEqual([]);
    happen(s, { type: "comment", by: "alice", body: "Why this?" });
    const [m] = await pollGithub(null, simApi(file));
    expect(m.body).toBe("Why this?");
    expect(m.meta?.reason).toBe("author");
    expect(m.url).toMatch(/pull\/1#issuecomment-\d+$/);
  });

  test("a mention says so; your own comment is not heard", async () => {
    const s = happen(simState(), { type: "pr-open", by: "bob" });
    happen(
      s,
      { type: "comment", by: SIM_ME, body: "looking" },
      { type: "mention", by: "bob" },
    );
    const [m] = await pollGithub(null, simApi(file));
    expect(m.meta?.reason).toBe("mention");
    expect(m.body).toContain(`@${SIM_ME}`);
  });

  test("a review's line comments sit on lines of the PR's diff", async () => {
    const s = happen(simState(), { type: "pr-open", mine: true });
    happen(s, { type: "review", by: "alice", verdict: "changes", comments: 3 });
    const [m] = await pollGithub(null, simApi(file));
    expect(m.author).toBe("alice");
    expect(m.url).toMatch(/#pullrequestreview-\d+$/);
    const diff = diffLines(checkout.path, "main", checkout.work.branch);
    const spots = m.body.split("\n").slice(1);
    expect(spots).toHaveLength(3);
    for (const spot of spots) {
      const [path, line] = spot.split(":");
      expect(diff.lines).toContainEqual({ path, line: Number(line) });
    }
  });

  test("since: only what changed after it", async () => {
    const s = happen(simState(), { type: "pr-open", by: "bob" });
    const since = new Date(Date.now() + 5).toISOString();
    await Bun.sleep(10);
    expect(await pollGithub(since, simApi(file))).toEqual([]);
    happen(s, { type: "comment", by: "bob", body: "ping" });
    const got = await pollGithub(since, simApi(file));
    expect(got.map((m) => m.body)).toEqual(["ping"]);
  });

  test("a path the sim does not have is a 404", async () => {
    happen(simState());
    await expect(simApi(file)("repos/acme/x/pulls/1")).rejects.toThrow(
      "HTTP 404",
    );
  });
});

describe("PR status, through readPrBatch and readPrView", () => {
  test("the review cycle, step by step", async () => {
    const s = happen(simState(), { type: "pr-open", mine: true });
    expect(await status(1)).toMatchObject({
      state: PrState.open,
      checks: PrChecks.pending,
      review: PrReview.required,
    });
    happen(s, { type: "review", by: "alice", verdict: "changes" });
    expect((await status(1)).review).toBe(PrReview.changes);
    happen(s, { type: "ci", result: "fail" });
    expect((await status(1)).checks).toBe(PrChecks.fail);
    happen(s, { type: "push" });
    expect((await status(1)).checks).toBe(PrChecks.pending);
    happen(s, { type: "ci", result: "pass" });
    expect((await status(1)).checks).toBe(PrChecks.pass);
    happen(s, { type: "review", by: "alice", verdict: "approve" });
    expect((await status(1)).review).toBe(PrReview.approved);
    happen(s, { type: "merge" });
    expect((await status(1)).state).toBe(PrState.merged);
  });

  test("a PR or repo the sim does not have comes back as an error, per PR", async () => {
    happen(simState(), { type: "pr-open", by: "bob" });
    const other = {
      repo: "acme/x",
      number: 1,
      url: "https://github.com/acme/x/pull/1",
    };
    const batch = await simPrFetch(file)([ref(1), ref(9), other]);
    expect(batch.views.get(ref(1).url)).not.toBeInstanceOf(Error);
    expect(batch.views.get(ref(9).url)).toBeInstanceOf(Error);
    expect(batch.views.get(other.url)).toBeInstanceOf(Error);
    expect(batch.budget?.remaining).toBe(5000);
  });

  test("answers the aliases the real query asks for", () => {
    expect(prBatchQuery([ref(1), ref(2)])).toContain("p1: repository");
  });
});

describe("the engine on the sim", () => {
  test("review-cycle: feedback on the work task, its PR merged", async () => {
    fakeBrain(() => null);
    const work = store.createTask({
      title: "work",
      kind: Kind.coding,
      repo: SIM_REPO,
      branch: checkout.work.branch,
      channel: "github",
    });
    store.createSession({
      id: "s1",
      taskId: work.id,
      kind: "tmux",
      cwd: "/tmp",
      startedBy: "aug",
    });
    const s = simState({ work: { taskId: work.id, ...checkout.work } });
    const engine = new Engine({
      config: testConfig(),
      offline: true,
      github: { api: simApi(file), prs: simPrFetch(file) },
    });
    for (const step of SCENARIOS["review-cycle"].steps) {
      const done = applyEvent(s, step.event);
      saveState(file, s);
      linkOpened(s, done);
      await engine.pollGithub(true);
      await engine.triageInbox();
    }
    const feedback = unreadFeedback(work.id);
    expect(feedback.map((m) => m.author)).toEqual(["alice", "alice"]);
    const pr = store.prStatus(work.id);
    expect(pr?.state).toBe(PrState.merged);
    expect(prChip(pr!).text).toBe("#1 merged");
    expect(store.getTask(work.id)?.merged_at).not.toBeNull();
  });

  test("every scenario plays", () => {
    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      const s = simState();
      for (const step of scenario.steps)
        expect(() => applyEvent(s, step.event), name).not.toThrow();
    }
  });
});
