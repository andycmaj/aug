import { beforeEach, describe, expect, test } from "bun:test";
import { setBrain, type BrainCall } from "../src/core/brain";
import { mergeConfig } from "../src/core/config";
import { Engine } from "../src/core/engine";
import { claudeEnv } from "../src/core/self";
import {
  REPLY_MARK,
  Remote,
  toSlack,
  type RemoteLink,
  type RemoteMessage,
  type RemoteQuery,
} from "../src/core/slack/remote";
import { remoteLink, TokenRemoteLink } from "../src/core/slack/remote-links";
import * as store from "../src/core/store";
import { SLACK_AUTHOR, TurnRole, TurnStatus } from "../src/core/types";
import { freshHome, testConfig } from "./helpers";

const ME = "U_ME";
const CHANNEL = "D_SELF";

class FakeLink implements RemoteLink {
  readonly kind = "token" as const;
  members = [ME];
  messages: RemoteMessage[] = [];
  queries: RemoteQuery[] = [];
  posts: { channel: string; threadTs: string; text: string }[] = [];
  failPost = false;
  private nextTs = 1000;

  async read(query: RemoteQuery) {
    this.queries.push(query);
    return {
      channel: CHANNEL,
      me: ME,
      members: this.members,
      messages: this.messages,
    };
  }

  async post(channel: string, threadTs: string, text: string) {
    if (this.failPost) throw new Error("slack unreachable");
    this.posts.push({ channel, threadTs, text });
    return String(this.nextTs++ + Date.now() / 1000);
  }

  stop() {}
}

let calls: BrainCall[];
let link: FakeLink;
let engine: Engine;
let remote: Remote;

const nowTs = (offset = 0) => (Date.now() / 1000 + offset).toFixed(6);

function owner(text: string, extra: Partial<RemoteMessage> = {}): RemoteMessage {
  return { ts: nowTs(1), user: ME, bot: false, text, ...extra };
}

async function settled(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const home = store.homeTask();
    const running = store
      .turnsForTask(home.id)
      .some((t) => t.status === TurnStatus.running);
    if (!running) return;
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(async () => {
  freshHome({ remote: { enabled: true, pollSeconds: 15 } });
  calls = [];
  setBrain(async (call) => {
    calls.push(call);
    return {
      text: "**Done.** Made AUG-0002.",
      structured: null,
      sessionId: call.sessionId ?? call.resume ?? null,
      durationMs: 1,
      isError: false,
    };
  });
  link = new FakeLink();
  engine = new Engine({ config: testConfig() });
  remote = new Remote({
    link,
    config: testConfig(),
    say: (id, text, author) => engine.desk.say(id, text, author),
    wake: (id) => {
      const home = store.getTask(id);
      if (home) engine.drivers.for(home).wake(home, "test");
    },
  });
  // The first look only marks where listening starts.
  await remote.tick();
});

describe("the Slack remote", () => {
  test("starts listening now: a message from before it was on is never heard", async () => {
    store.kvSet("slack.remote", "");
    link.messages = [{ ts: nowTs(-600), user: ME, bot: false, text: "yes" }];
    const result = await remote.tick();
    expect(result?.heard).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("an owner line reaches Home and its answer comes back in the thread", async () => {
    const msg = owner("make a task for the flaky test");
    link.messages = [msg];
    const heard = await remote.tick();
    expect(heard?.heard).toBe(1);
    const home = store.homeTask();
    const said = store.turnsForTask(home.id).find((t) => t.role === TurnRole.you);
    expect(said?.author).toBe(SLACK_AUTHOR);
    expect(said?.body).toBe("make a task for the flaky test");
    await settled();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain("The owner wrote from Slack");

    link.messages = [];
    await remote.tick();
    expect(link.posts).toEqual([
      { channel: CHANNEL, threadTs: msg.ts, text: `${REPLY_MARK} *Done.* Made AUG-0002.` },
    ]);
    // The thread stays live for replies, and nothing is posted twice.
    await remote.tick();
    expect(link.posts).toHaveLength(1);
    expect(link.queries.at(-1)?.threads).toEqual([msg.ts]);
  });

  test("a thread reply is answered in that thread", async () => {
    link.messages = [owner("and start it", { threadTs: "111.000" })];
    await remote.tick();
    await settled();
    await remote.tick();
    expect(link.posts[0]?.threadTs).toBe("111.000");
  });

  test("hears only the owner's own plain lines", async () => {
    link.messages = [
      owner("from someone else", { user: "U_OTHER" }),
      owner("from a bot", { bot: true }),
      owner("joined", { subtype: "channel_join" }),
      owner(`${REPLY_MARK} an earlier answer`),
      owner(`:robot_face: ${REPLY_MARK} an answer with an emoji`),
      owner("   "),
    ];
    const result = await remote.tick();
    expect(result?.heard).toBe(0);
    expect(calls).toHaveLength(0);
  });

  test("refuses a conversation with anyone else in it, and hears nothing", async () => {
    link.members = [ME, "U_OTHER"];
    link.messages = [owner("stop AUG-0003")];
    await expect(remote.tick()).rejects.toThrow("other member");
    expect(calls).toHaveLength(0);
    // Turned private again, the line is still there to hear.
    link.members = [ME];
    expect((await remote.tick())?.heard).toBe(1);
  });

  test("an answer Slack would not take is posted on a later tick", async () => {
    link.failPost = true;
    link.messages = [owner("what is running?")];
    await remote.tick().catch(() => {});
    await settled();
    link.messages = [];
    await expect(remote.tick()).rejects.toThrow("slack unreachable");
    link.failPost = false;
    expect((await remote.tick())?.answered).toBe(1);
    expect(link.posts).toHaveLength(1);
  });

  test("a line heard while Home was mid-turn gets a turn of its own", async () => {
    let release = () => {};
    const first = new Promise<void>((r) => (release = r));
    let n = 0;
    setBrain(async (call) => {
      calls.push(call);
      if (n++ === 0) await first;
      return {
        text: n === 1 ? "about the terminal line" : "about the Slack line",
        structured: null,
        sessionId: call.sessionId ?? call.resume ?? null,
        durationMs: 1,
        isError: false,
      };
    });
    const home = store.homeTask();
    await engine.desk.say(home.id, "typed in the terminal");
    link.messages = [owner("and also this")];
    await remote.tick();
    expect(calls).toHaveLength(1);
    release();
    await settled();
    link.messages = [];
    await remote.tick();
    await settled();
    expect(calls).toHaveLength(2);
    await remote.tick();
    expect(link.posts.map((p) => p.text)).toEqual([
      `${REPLY_MARK} about the Slack line`,
    ]);
  });
});

describe("the answer as Slack shows it", () => {
  test("bold and headings in Slack's mrkdwn, marked, and clipped", () => {
    expect(toSlack("## Plan\n**one** thing")).toBe(`${REPLY_MARK} *Plan*\n*one* thing`);
    const long = toSlack("x".repeat(5000));
    expect(long.length).toBeLessThan(3700);
    expect(long).toContain("the rest is in aug's Home");
  });
});

describe("config and links", () => {
  test("off by default, and slower under claude-mcp", () => {
    expect(mergeConfig({}).remote).toEqual({ enabled: false, pollSeconds: 15 });
    expect(
      mergeConfig({ slack: { transport: "claude-mcp" }, remote: { enabled: true } })
        .remote.pollSeconds,
    ).toBe(60);
  });

  test("a token link finds the self-DM and calls a public channel not private", async () => {
    const asked: string[] = [];
    const api = async (method: string, params: Record<string, string>) => {
      asked.push(`${method} ${params.channel ?? params.users ?? ""}`);
      if (method === "auth.test") return { ok: true, user_id: ME };
      if (method === "conversations.open") return { ok: true, channel: { id: CHANNEL } };
      if (method === "conversations.info")
        return params.channel === CHANNEL
          ? { ok: true, channel: { id: CHANNEL, is_im: true, user: ME } }
          : { ok: true, channel: { id: params.channel, is_private: false } };
      if (method === "conversations.history")
        return { ok: true, messages: [{ ts: "2.0", user: ME, text: "hi" }] };
      return { ok: true };
    };
    const link = new TokenRemoteLink(api);
    const read = await link.read({ since: "1.0", threads: [] });
    expect(read.channel).toBe(CHANNEL);
    expect(read.members).toEqual([ME]);
    expect(read.messages[0]?.text).toBe("hi");
    expect(asked).toContain(`conversations.open ${ME}`);
    const pub = await link.read({ channel: "C_PUBLIC", since: "1.0", threads: [] });
    expect(pub.members.length).toBeGreaterThan(1);
  });

  test("no token is an error the status line shows", () => {
    const prior = process.env.SLACK_TOKEN;
    delete process.env.SLACK_TOKEN;
    const link = remoteLink(mergeConfig({ remote: { enabled: true } }));
    expect("error" in link && link.error).toContain("SLACK_TOKEN");
    if (prior) process.env.SLACK_TOKEN = prior;
  });

  test("claude-mcp needs the conversation named", async () => {
    const link = remoteLink(
      mergeConfig({ slack: { transport: "claude-mcp" }, remote: { enabled: true } }),
    );
    if ("error" in link) throw new Error(link.error);
    await expect(link.read({ since: "1", threads: [] })).rejects.toThrow("remote.channel");
  });

  test("an agent's environment never carries the Slack token", () => {
    process.env.SLACK_TOKEN = "xoxp-secret";
    try {
      expect(claudeEnv().SLACK_TOKEN).toBeUndefined();
    } finally {
      delete process.env.SLACK_TOKEN;
    }
  });
});
