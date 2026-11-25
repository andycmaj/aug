import { describe, expect, test } from "bun:test";
import { EMPTY_CURSOR, type SlackCursor } from "../src/shared";
import { TokenTransport, type SlackApi } from "../src/token";

// A workspace with many DMs, watched channels and tracked threads: what one
// poll asks of Slack, counted by method, and how many calls are out at once.
function fakeSlack(opts: { dms: number; replies?: (thread: string) => unknown[] }) {
  const calls: string[] = [];
  let inFlight = 0;
  let most = 0;
  const api: SlackApi = async (method, params) => {
    calls.push(method);
    inFlight++;
    most = Math.max(most, inFlight);
    // Uneven latency: later conversations often answer first.
    await Bun.sleep(calls.length % 3);
    inFlight--;
    switch (method) {
      case "auth.test":
        return { ok: true, user_id: "UME", url: "https://acme.slack.com/" };
      case "users.conversations":
        return {
          ok: true,
          channels: Array.from({ length: opts.dms }, (_, i) => ({
            id: `D${i}`,
            is_im: true,
            user: `U${i}`,
            priority: opts.dms - i,
          })),
        };
      case "users.info":
        return { ok: true, user: { real_name: `Person ${params.user}` } };
      case "search.messages":
        return { ok: true, messages: { matches: [] } };
      case "conversations.replies":
        return { ok: true, messages: opts.replies?.(params.ts!) ?? [] };
      default:
        // conversations.history: one line in D1 and C1, nothing elsewhere;
        // like Slack, only what is newer than oldest.
        return {
          ok: true,
          messages:
            (params.channel === "D1" || params.channel === "C1") &&
            Number(params.oldest) < 2000000000.0001
              ? [{ ts: "2000000000.000100", user: "U1", text: `hi from ${params.channel}` }]
              : [],
        };
    }
  };
  return { api, calls, most: () => most };
}

const tally = (calls: string[]) =>
  calls.reduce<Record<string, number>>((acc, c) => ({ ...acc, [c]: (acc[c] ?? 0) + 1 }), {});

describe("a token poll on a big workspace", () => {
  test("one read per conversation, a few at a time; who I am and names asked once a process", async () => {
    const slack = fakeSlack({
      dms: 40,
      replies: (ts) => (ts === "100.0" ? [{ ts: "2000000000.000200", user: "U3", text: "reply" }] : []),
    });
    const transport = new TokenTransport("xoxp-test", slack.api);
    const ctx = {
      watchChannels: ["C1", "C2", "C3", "C4", "C5"],
      trackedThreads: Array.from({ length: 10 }, (_, i) => `C9:${100 + i}.0`),
      firstLookSeconds: 86400,
    };
    const first = await transport.poll({ ...ctx, cursor: EMPTY_CURSOR });
    // 25 DMs (the most active) + 5 channels + 10 threads + the list + search.
    expect(tally(slack.calls)).toEqual({
      "auth.test": 1,
      "users.conversations": 1,
      "search.messages": 1,
      "conversations.history": 30,
      "conversations.replies": 10,
      // Only the people who wrote something: a quiet DM's name is not asked.
      "users.info": 2,
    });
    expect(slack.most()).toBeGreaterThan(1);
    expect(slack.most()).toBeLessThanOrEqual(13);
    // In the order the reads used to run: DMs, channels, then threads.
    expect(first.messages.map((m) => m.body)).toEqual(["hi from D1", "hi from C1", "reply"]);
    expect(first.messages[0]!.title).toContain("DM with Person U1");

    slack.calls.length = 0;
    const cursor: SlackCursor = first.cursor;
    const second = await transport.poll({ ...ctx, cursor });
    expect(second.messages).toEqual([]);
    expect(tally(slack.calls)).toEqual({
      "users.conversations": 1,
      "search.messages": 1,
      "conversations.history": 30,
      "conversations.replies": 10,
    });
  });
});
