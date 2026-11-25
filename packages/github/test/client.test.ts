import { beforeEach, describe, expect, test } from "bun:test";
import { Engine } from "@riker/core/engine";
import { linkPr } from "@riker/core/feedback";
import { setMux } from "@riker/core/mux";
import { SendError } from "@riker/core/outbound";
import * as store from "@riker/core/store";
import { Kind } from "@riker/core/types";
import { FakeMux } from "@riker/core/test/support/fake-mux";
import { freshHome, testConfig } from "@riker/core/test/support/helpers";
import { GhThrottled, GithubClient, parseIncluded, type GhRaw } from "../src/client";
import { GhBudget, PauseWhy, REST_RESERVE, SECONDARY_FIRST_MS, UNKNOWN_RESET_PAUSE_MS } from "../src/gate";
import { githubPlugin } from "../src/index";
import { githubSend } from "../src/send";

beforeEach(() => {
  freshHome();
  setMux(new FakeMux());
});

const T0 = 1_800_000_000_000;
const RESET_S = T0 / 1000 + 1800;

function clock() {
  const c = { t: T0, now: () => c.t, random: () => 0 };
  return c;
}

// What `gh api -i` prints: status line, headers, blank line, body.
function http(
  status: number,
  headers: Record<string, string | number>,
  body: unknown,
  stderr = "",
): GhRaw {
  const reason = status === 200 ? "OK" : status === 403 ? "Forbidden" : status === 429 ? "Too Many Requests" : "";
  const head = [`HTTP/2.0 ${status} ${reason}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
  return {
    code: status < 300 ? 0 : 1,
    stdout: `${head.join("\r\n")}\r\n\r\n${typeof body === "string" ? body : JSON.stringify(body)}`,
    stderr,
  };
}

const core = (remaining: number) => ({
  "X-Ratelimit-Resource": "core",
  "X-Ratelimit-Remaining": remaining,
  "X-Ratelimit-Reset": RESET_S,
});
const graphql = (remaining: number) => ({
  "X-Ratelimit-Resource": "graphql",
  "X-Ratelimit-Remaining": remaining,
  "X-Ratelimit-Reset": RESET_S,
});

// A fake gh: each call is answered by the next function in line (the last
// one repeats), and every call is kept.
function fakeGh(...answers: ((args: string[]) => GhRaw)[]) {
  const calls: string[][] = [];
  const run = async (args: string[]) => {
    calls.push(args);
    const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!;
    return answer(args);
  };
  return { run, calls };
}

async function throttled(p: Promise<unknown>): Promise<GhThrottled> {
  try {
    await p;
  } catch (err) {
    if (err instanceof GhThrottled) return err;
    throw err;
  }
  throw new Error("was not throttled");
}

describe("gh api -i", () => {
  test("status, headers and body", () => {
    const res = parseIncluded(http(404, core(4985), { message: "Not Found" }, "gh: Not Found (HTTP 404)"));
    expect(res.status).toBe(404);
    expect(res.headers.get("x-ratelimit-remaining")).toBe("4985");
    expect(JSON.parse(res.body)).toEqual({ message: "Not Found" });
  });

  test("a plain gh command's output is all body", () => {
    expect(parseIncluded({ code: 0, stdout: "merged\n", stderr: "" })).toMatchObject({
      status: null,
      body: "merged\n",
    });
  });
});

describe("a primary rate limit", () => {
  test("REST spent: paused until its reset, and nothing more reaches gh", async () => {
    const c = clock();
    const gh = fakeGh(() => http(403, core(0), { message: "API rate limit exceeded for user ID 1." }));
    const client = new GithubClient({ run: gh.run, clock: c });
    const err = await throttled(client.api("notifications"));
    expect(err.budget).toBe(GhBudget.rest);
    expect(err.pause).toEqual({ until: RESET_S * 1000, why: PauseWhy.rateLimit });
    expect(err.message).toMatch(/^GitHub rate limited until \d+:\d\d$/);
    // No rate_limit call: the headers said it all.
    expect(gh.calls).toHaveLength(1);
    await throttled(client.api("user"));
    await throttled(client.api("user"));
    expect(gh.calls).toHaveLength(1);
    // GraphQL is its own budget.
    expect(client.gate().pause(GhBudget.graphql)).toBeNull();
    c.t = RESET_S * 1000 + 1;
    gh.calls.length = 0;
    await throttled(client.api("user")).catch(() => null);
    expect(gh.calls).toHaveLength(1);
  });

  test("GraphQL spent answers 200 with RATE_LIMITED", async () => {
    const c = clock();
    const gh = fakeGh(() =>
      http(200, graphql(0), {
        errors: [{ type: "RATE_LIMITED", message: "API rate limit already exceeded for user ID 1." }],
      }),
    );
    const client = new GithubClient({ run: gh.run, clock: c });
    const err = await throttled(client.graphql("{ viewer { login } }"));
    expect(err.budget).toBe(GhBudget.graphql);
    expect(err.pause.until).toBe(RESET_S * 1000);
    expect(client.gate().pause(GhBudget.rest)).toBeNull();
  });

  test("outlives a restart", async () => {
    const c = clock();
    const gh = fakeGh(() => http(429, core(0), { message: "API rate limit exceeded" }));
    await throttled(new GithubClient({ run: gh.run, clock: c }).api("user"));
    const again = new GithubClient({ run: gh.run, clock: c });
    await throttled(again.api("user"));
    expect(gh.calls).toHaveLength(1);
  });

  test("only words, no headers: GraphQL's own headers say when it resets", async () => {
    const c = clock();
    const gh = fakeGh(
      () => ({ code: 1, stdout: "", stderr: "GraphQL: API rate limit already exceeded for user ID 1." }),
      // rate_limit's body can say budget is left while GraphQL's headers say 0.
      () => http(200, graphql(0), { data: { rateLimit: { remaining: 0 } } }),
    );
    const client = new GithubClient({ run: gh.run, clock: c });
    const err = await throttled(client.cli(["pr", "merge", "3", "-R", "a/b", "--squash"]));
    expect(gh.calls[1]?.slice(0, 3)).toEqual(["api", "graphql", "-i"]);
    expect(err.pause).toEqual({ until: RESET_S * 1000, why: PauseWhy.rateLimit });
  });

  test("REST in words only: rate_limit's body when it has no headers", async () => {
    const c = clock();
    const gh = fakeGh(
      () => ({ code: 1, stdout: "", stderr: "gh: API rate limit exceeded for user ID 1. (HTTP 403)" }),
      () => ({ code: 0, stdout: JSON.stringify({ resources: { core: { remaining: 0, reset: RESET_S } } }), stderr: "" }),
    );
    const client = new GithubClient({ run: gh.run, clock: c });
    // A REST call whose answer gh did not print with headers.
    const err = await throttled(client.api("user"));
    expect(gh.calls[1]).toEqual(["api", "-i", "rate_limit"]);
    expect(err.pause).toEqual({ until: RESET_S * 1000, why: PauseWhy.rateLimit });
  });

  test("nothing settles it: wait a while, not a minute", async () => {
    const c = clock();
    const gh = fakeGh(
      () => ({ code: 1, stdout: "", stderr: "API rate limit exceeded" }),
      () => ({ code: 1, stdout: "", stderr: "could not resolve host" }),
    );
    const client = new GithubClient({ run: gh.run, clock: c });
    const err = await throttled(client.cli(["issue", "close", "3"]));
    expect(err.pause.until - c.t).toBe(UNKNOWN_RESET_PAUSE_MS);
  });
});

describe("a secondary rate limit", () => {
  test("honors retry-after", async () => {
    const c = clock();
    const gh = fakeGh(() =>
      http(403, { ...core(4200), "Retry-After": 90 }, { message: "You have exceeded a secondary rate limit." }),
    );
    const client = new GithubClient({ run: gh.run, clock: c });
    const err = await throttled(client.api("notifications"));
    expect(err.pause).toEqual({ until: T0 + 90_000, why: PauseWhy.secondary });
    expect(err.message).toMatch(/^GitHub secondary rate limit, waiting until \d+:\d\d$/);
    await throttled(client.api("notifications"));
    expect(gh.calls).toHaveLength(1);
  });

  test("without retry-after: a minute, then doubling while it keeps coming back", async () => {
    const c = clock();
    let limited = true;
    const gh = fakeGh(() =>
      limited
        ? http(403, core(4200), { message: "You have exceeded a secondary rate limit." })
        : http(200, core(4199), { login: "me" }),
    );
    const client = new GithubClient({ run: gh.run, clock: c });
    const waits: number[] = [];
    for (let i = 0; i < 3; i++) {
      const err = await throttled(client.api("user"));
      waits.push(err.pause.until - c.t);
      c.t = err.pause.until;
    }
    expect(waits).toEqual([SECONDARY_FIRST_MS, 2 * SECONDARY_FIRST_MS, 4 * SECONDARY_FIRST_MS]);
    // A call that works forgets the strikes.
    limited = false;
    await client.api("user");
    limited = true;
    const err = await throttled(client.api("user"));
    expect(err.pause.until - c.t).toBe(SECONDARY_FIRST_MS);
  });

  test("jitter only adds to the step", async () => {
    const c = { ...clock(), random: () => 1 };
    c.now = () => T0;
    const gh = fakeGh(() => http(429, core(100), { message: "secondary rate limit" }));
    const client = new GithubClient({ run: gh.run, clock: c });
    const err = await throttled(client.api("user"));
    expect(err.pause.until - T0).toBe(SECONDARY_FIRST_MS * 1.25);
  });

  test("only words, budget left: rate_limit makes it secondary", async () => {
    const c = clock();
    const gh = fakeGh(
      () => ({ code: 1, stdout: "", stderr: "gh: API rate limit exceeded (HTTP 403)" }),
      () => http(200, graphql(4000), { data: { rateLimit: { remaining: 4000 } } }),
    );
    const client = new GithubClient({ run: gh.run, clock: c });
    const err = await throttled(client.cli(["pr", "review", "3", "--approve"]));
    expect(err.pause).toEqual({ until: T0 + SECONDARY_FIRST_MS, why: PauseWhy.secondary });
  });
});

describe("what is not a rate limit", () => {
  test("a 403 for a permission is an error, and pauses nothing", async () => {
    const gh = fakeGh(() =>
      http(403, core(4900), { message: "Resource not accessible by integration" }, "gh: Resource not accessible by integration (HTTP 403)"),
    );
    const client = new GithubClient({ run: gh.run, clock: clock() });
    const err = await client.api("repos/a/b/pulls/1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GhThrottled);
    expect((err as Error).message).toBe("gh: Resource not accessible by integration (HTTP 403)");
    expect(client.gate().pause(GhBudget.rest)).toBeNull();
  });

  test("a GraphQL answer with some errors is still an answer", async () => {
    const gh = fakeGh(() => ({
      ...http(200, graphql(4000), { data: { p0: null }, errors: [{ path: ["p0"], message: "not found" }] }),
      code: 1,
    }));
    const client = new GithubClient({ run: gh.run, clock: clock() });
    expect(await client.graphql("{ x }")).toMatchObject({ data: { p0: null } });
  });
});

describe("the reserve", () => {
  test("low REST budget pauses background calls until the reset; the owner's still go", async () => {
    const c = clock();
    const gh = fakeGh(() => http(200, core(REST_RESERVE - 1), {}));
    const client = new GithubClient({ run: gh.run, clock: c });
    await client.api("user");
    expect(client.gate().pause(GhBudget.rest)).toEqual({ until: RESET_S * 1000, why: PauseWhy.reserve });
    const err = await throttled(client.api("notifications"));
    expect(err.message).toMatch(/^GitHub rate limit budget low, saving it until \d+:\d\d$/);
    expect(gh.calls).toHaveLength(1);
    await client.api("repos/a/b/issues/3/comments", { body: "hi" }, { owner: true });
    expect(gh.calls).toHaveLength(2);
  });

  test("plenty left pauses nothing", async () => {
    const gh = fakeGh(() => http(200, graphql(4000), { data: {} }));
    const client = new GithubClient({ run: gh.run, clock: clock() });
    await client.graphql("{ x }");
    expect(client.gate().pause(GhBudget.graphql)).toBeNull();
  });
});

describe("a Send while rate limited", () => {
  test("says until when, and never reaches gh", async () => {
    const c = clock();
    const gh = fakeGh(() => http(403, core(0), { message: "API rate limit exceeded" }));
    const client = new GithubClient({ run: gh.run, clock: c });
    await throttled(client.api("user"));
    const err = await githubSend(
      client,
      { type: "github_comment", repo: "a/b", number: 3, body: "lgtm" },
      testConfig().get(),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendError);
    expect((err as Error).message).toMatch(/^GitHub rate limited until \d+:\d\d$/);
    expect(gh.calls).toHaveLength(1);
  });

  test("a plain failure stays a SendError with gh's words", async () => {
    const gh = fakeGh(() => http(422, core(4000), { message: "Validation Failed" }, "gh: Validation Failed (HTTP 422)"));
    const client = new GithubClient({ run: gh.run, clock: clock() });
    const err = await githubSend(
      client,
      { type: "github_comment", repo: "a/b", number: 3, body: "" },
      testConfig().get(),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendError);
    expect((err as Error).message).toBe("gh: Validation Failed (HTTP 422)");
  });
});

// The whole poll on the real client, with only gh faked.
describe("the poll through the client", () => {
  function prTask(n: number) {
    const t = store.createTask({ title: `PR ${n}`, kind: Kind.coding, channel: "github", repo: "acme/ledger" });
    linkPr(t.id, `https://github.com/acme/ledger/pull/${n}`);
    return t;
  }

  function engineWith(run: (args: string[]) => Promise<GhRaw>, c = clock()) {
    const github = githubPlugin({ run, clock: c });
    const engine = new Engine({ config: testConfig(), offline: true, plugins: [github] });
    return { engine, github: github.connector, client: github.client, c };
  }

  test("a REST primary limit: the status line says until when, and the next poll asks nothing", async () => {
    const gh = fakeGh((args) =>
      args[2] === "user" ? http(200, core(4000), { login: "me" }) : http(403, core(0), { message: "API rate limit exceeded" }),
    );
    const { engine, github } = engineWith(gh.run);
    await github.poll();
    expect(engine.status.github.state).toBe("error");
    expect(engine.status.github.detail).toMatch(/^rate limited until \d+:\d\d$/);
    expect(gh.calls.some((a) => a.includes("rate_limit"))).toBe(false);
    const asked = gh.calls.length;
    await github.poll(true);
    expect(gh.calls.length).toBe(asked);
  });

  test("a GraphQL secondary limit pauses PR status alone, and says so", async () => {
    prTask(1);
    const gh = fakeGh((args) => {
      if (args[1] === "graphql")
        return http(403, { ...graphql(3000), "Retry-After": 120 }, { message: "You have exceeded a secondary rate limit." });
      if (args[2] === "user") return http(200, core(4000), { login: "me" });
      return http(200, core(4000), []);
    });
    const { engine, github, client, c } = engineWith(gh.run);
    await github.poll();
    expect(engine.status.github.state).toBe("error");
    expect(engine.status.github.detail).toMatch(/^up to date · PR status secondary rate limit, waiting until \d+:\d\d$/);
    expect(client.gate().pause(GhBudget.graphql)).toEqual({ until: c.t + 120_000, why: PauseWhy.secondary });
    gh.calls.length = 0;
    await github.poll(true);
    expect(gh.calls.some((a) => a[1] === "graphql")).toBe(false);
    expect(gh.calls.some((a) => a[2]?.startsWith("notifications"))).toBe(true);
  });

  test("REST running low: notifications wait for the reset, and the line says why", async () => {
    const gh = fakeGh(() => http(200, core(REST_RESERVE - 5), []));
    const { engine, github } = engineWith(async (args) =>
      args[2] === "user" ? http(200, core(REST_RESERVE - 5), { login: "me" }) : gh.run(args),
    );
    await github.poll();
    await github.poll();
    expect(engine.status.github.detail).toMatch(/^paused until \d+:\d\d \(REST budget low\)$/);
  });
});
