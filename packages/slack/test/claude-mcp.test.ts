import { beforeEach, describe, expect, test } from "bun:test";
import { localDay } from "@riker/core/rail";
import * as store from "@riker/core/store";
import { SpendRole } from "@riker/core/types";
import { freshHome } from "@riker/core/test/support/helpers";
import {
  PersistentClaude,
  polledToRaw,
  realSpawn,
  type ProcLike,
} from "../src/claude-mcp";
import { plainText, rawToNewMessage, threadKeyFor } from "../src/shared";

beforeEach(() => freshHome());

describe("Slack messages", () => {
  test("Slack text and thread keys", () => {
    const names = new Map([["U1", "Ruth"]]);
    expect(
      plainText(
        "<@U1> see <https://x.io|the doc> in <#C9|general> &amp; go",
        names,
      ),
    ).toBe("@Ruth see the doc (https://x.io) in #general & go");
    expect(threadKeyFor("D1", { ts: "1.1" }, true)).toBe("slack:D1:dm");
    expect(threadKeyFor("C1", { ts: "2.2", thread_ts: "1.1" }, false)).toBe(
      "slack:C1:1.1",
    );
  });
});

describe("ingest says who was asked", () => {
  test("a Slack message that mentions you says so, from either transport", () => {
    const raw = polledToRaw({
      channel: "C1",
      is_dm: false,
      ts: "1.0",
      user_name: "Priya",
      text: "@me can you check?",
      from_me: false,
      mentions_me: true,
    });
    expect(rawToNewMessage(raw).meta).toMatchObject({ mention: true });
    expect(
      rawToNewMessage({ ...raw, mentionsMe: undefined }).meta,
    ).toMatchObject({ mention: false });
  });
});

describe("the Slack session's spend", () => {
  test("the Slack session's running total is recorded turn by turn", async () => {
    const totals = [0.1, 0.25, 0.05];
    const spawn = (): ProcLike => {
      const pending: string[] = [];
      let wake: (() => void) | null = null;
      return {
        write() {
          pending.push(
            JSON.stringify({
              type: "result",
              structured_output: {},
              total_cost_usd: totals.shift(),
              usage: { input_tokens: 1, output_tokens: 2 },
            }),
          );
          wake?.();
        },
        lines: (async function* () {
          for (;;) {
            if (!pending.length) {
              await new Promise<void>((r) => (wake = r));
            }
            wake = null;
            while (pending.length) {
              yield pending.shift()!;
            }
          }
        })(),
        kill() {},
      };
    };
    // A fresh process every two turns: its total starts over.
    const session = new PersistentClaude(() => ["claude"], {
      maxTurns: 2,
      spawn,
      model: "haiku",
    });
    await session.ask("a");
    await session.ask("b");
    await session.ask("c");
    const costs = store
      .spendByRole(localDay(new Date()))
      .find((r) => r.role === SpendRole.slack);
    expect(costs?.calls).toBe(3);
    // 0.10, then 0.25 - 0.10, then a new process's 0.05.
    expect(costs?.cost).toBeCloseTo(0.3);
  });
});

describe("Riker's own claudes", () => {
  // Riker may run in a pane of a task's window, and its Slack claude loads
  // user settings (so the guard): adopted as that task's newest session, s
  // would resume an id claude has no conversation for.
  test("carry no pane, so the guard never adopts them", async () => {
    const before = process.env.TMUX_PANE;
    process.env.TMUX_PANE = "%5";
    try {
      const proc = realSpawn(["sh", "-c", 'echo "pane=${TMUX_PANE:-none}"']);
      const seen: string[] = [];
      for await (const line of proc.lines) {
        seen.push(line);
      }
      expect(seen).toEqual(["pane=none"]);
    } finally {
      if (before === undefined) {
        delete process.env.TMUX_PANE;
      } else {
        process.env.TMUX_PANE = before;
      }
    }
  });
});
