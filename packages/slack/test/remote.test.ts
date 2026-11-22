import { beforeEach, describe, expect, test } from "bun:test";
import { setBrain, type BrainCall } from "@riker/core/brain";
import { mergeConfig } from "@riker/core/config";
import { Engine } from "@riker/core/engine";
import { claudeEnv } from "@riker/core/self";
import { runMove } from "@riker/core/moves";
import { CONFIRM_MINUTES, pendingConfirms, SLACK_ASKER, SLACK_AUTHOR } from "../src/confirm";
import {
  notification,
  REPLY_MARK,
  Remote,
  toSlack,
  type NotifyWhen,
  type RemoteLink,
  type RemoteMessage,
  type RemoteQuery,
} from "../src/remote";
import { remoteLink, TokenRemoteLink } from "../src/remote-links";
import { confirmGuard, slackPlugin } from "../src/index";
import { remoteConfig } from "../src/config";
import * as store from "@riker/core/store";
import { AgentState, Kind, TaskStatus, TurnRole, TurnStatus } from "@riker/core/types";
import { freshHome, testConfig } from "@riker/core/test/support/helpers";

const ME = "U_ME";
const CHANNEL = "D_SELF";

class FakeLink implements RemoteLink {
  readonly kind = "token" as const;
  members = [ME];
  messages: RemoteMessage[] = [];
  queries: RemoteQuery[] = [];
  posts: { channel: string; threadTs?: string; text: string; ts?: string }[] = [];
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

  async post(channel: string, threadTs: string | undefined, text: string) {
    if (this.failPost) throw new Error("slack unreachable");
    const ts = String(this.nextTs++ + Date.now() / 1000);
    this.posts.push({ channel, threadTs, text, ts });
    return ts;
  }

  stop() {}
}

let calls: BrainCall[];
let link: FakeLink;
let engine: Engine;
let remote: Remote;
let ran: { verb: string; args: Record<string, string> }[];

// Each message a later ts than the last, as Slack gives them.
let tick = 0;
const nowTs = (offset = 0) => (Date.now() / 1000 + offset + tick++ / 1000).toFixed(6);

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
  freshHome({ remote: { enabled: true, pollSeconds: 15, notify: [] } });
  calls = [];
  setBrain(async (call) => {
    calls.push(call);
    return {
      text: "**Done.** Made RIKER-0002.",
      structured: null,
      sessionId: call.sessionId ?? call.resume ?? null,
      durationMs: 1,
      isError: false,
    };
  });
  link = new FakeLink();
  ran = [];
  // The Slack plugin's hold, without its pollers: this test drives a Remote.
  engine = new Engine({ config: testConfig(), plugins: [{ name: "slack", guards: [confirmGuard] }] });
  remote = new Remote({
    link,
    config: testConfig(),
    say: (id, text, author) => engine.desk.say(id, text, author),
    wake: (id) => {
      const home = store.getTask(id);
      if (home) engine.drivers.for(home).wake(home, "test");
    },
    runMove: (verb, args) => {
      ran.push({ verb, args });
      return engine.runMove(verb, args, "you via Slack");
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
    expect(link.posts).toHaveLength(1);
    expect(link.posts[0]).toMatchObject({
      channel: CHANNEL,
      threadTs: msg.ts,
      text: `${REPLY_MARK} *Done.* Made RIKER-0002.`,
    });
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
    link.messages = [owner("stop RIKER-0003")];
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
    expect(long).toContain("the rest is in Riker's Home");
  });
});

describe("config and links", () => {
  test("off by default, and slower under claude-mcp", () => {
    expect(remoteConfig.of(mergeConfig({}))).toEqual({ enabled: false, pollSeconds: 15, notify: [] });
    expect(
      remoteConfig.of(mergeConfig({ slack: { transport: "claude-mcp" }, remote: { enabled: true } }))
        .pollSeconds,
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

describe("held moves from Slack", () => {
  // The Assistant asks for `verb` mid-turn, the way riker-tools would.
  function assistantAsks(verb: string, args: Record<string, string>, says = "I'll do that.") {
    setBrain(async (call) => {
      calls.push(call);
      const moved = await runMove(engine.desk, verb, args, call.env?.RIKER_ASKED_BY ?? "assistant");
      held.push(moved.result);
      return {
        text: says,
        structured: null,
        sessionId: call.sessionId ?? call.resume ?? null,
        durationMs: 1,
        isError: false,
      };
    });
  }

  let held: string[];
  let task: ReturnType<typeof store.createTask>;

  beforeEach(() => {
    held = [];
    task = store.createTask({ title: "flaky test", kind: Kind.general, channel: "owner" });
  });

  async function askedInSlack(text: string): Promise<RemoteMessage> {
    const msg = owner(text);
    link.messages = [msg];
    await remote.tick();
    await settled();
    link.messages = [];
    await remote.tick();
    return msg;
  }

  test("a Slack turn asks as the Slack asker, a terminal turn as the Assistant", async () => {
    await askedInSlack("hi");
    expect(calls[0]?.env?.RIKER_ASKED_BY).toBe(SLACK_ASKER);
    const home = store.homeTask();
    await engine.desk.say(home.id, "from the terminal");
    await settled();
    expect(calls[1]?.env?.RIKER_ASKED_BY).toBe("assistant");
  });

  test("stop is held, its answer asks for a yes, and yes in the thread runs it as the owner's", async () => {
    const ref = store.taskRef(task.id);
    assistantAsks("stop", { task: ref });
    const msg = await askedInSlack(`stop ${ref}`);
    expect(held[0]).toContain("held for the owner's yes");
    expect(ran).toHaveLength(0);
    expect(link.posts[0]?.text).toContain(`Reply *yes* in this thread to stop the agent on ${ref} (flaky test)`);

    link.messages = [owner("yes", { threadTs: msg.ts })];
    await remote.tick();
    expect(ran).toEqual([{ verb: "stop", args: { task: ref } }]);
    expect(link.posts.at(-1)).toMatchObject({
      threadTs: msg.ts,
      text: `${REPLY_MARK} stopped ${ref}'s agent`,
    });
    // The yes is not a line for the Assistant; Home has a note of it.
    expect(calls).toHaveLength(1);
    const notes = store.turnsForTask(store.homeTask().id).filter((t) => t.role === TurnRole.trigger);
    expect(notes.at(-1)?.body).toContain("said yes to stop the agent on");
    // Said once: a second yes is just a line.
    link.messages = [owner("yes", { threadTs: msg.ts })];
    await remote.tick();
    await settled();
    expect(ran).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  test("a move the Assistant may make anyway is not held", async () => {
    const ref = store.taskRef(task.id);
    assistantAsks("retitle", { task: ref, title: "flaky e2e test" });
    await askedInSlack("rename it");
    expect(held[0]).not.toContain("held");
    expect(store.getTask(task.id)?.title).toBe("flaky e2e test");
  });

  test("no leaves it, and says so", async () => {
    const ref = store.taskRef(task.id);
    assistantAsks("done", { task: ref });
    const msg = await askedInSlack(`close ${ref}`);
    link.messages = [owner("no", { threadTs: msg.ts })];
    await remote.tick();
    expect(ran).toHaveLength(0);
    expect(link.posts.at(-1)?.text).toBe(`${REPLY_MARK} Left as is: mark done ${ref} (flaky test).`);
    expect(store.getTask(task.id)?.status).toBe("open");
  });

  test("anything else drops the hold and goes to the Assistant", async () => {
    const ref = store.taskRef(task.id);
    assistantAsks("done", { task: ref });
    const msg = await askedInSlack(`close ${ref}`);
    assistantAsks("retitle", { task: ref, title: "flaky test" });
    link.messages = [owner("wait, what is its PR?", { threadTs: msg.ts })];
    await remote.tick();
    await settled();
    expect(ran).toHaveLength(0);
    expect(calls).toHaveLength(2);
    expect(pendingConfirms()).toHaveLength(0);
  });

  test("a yes after the hold lapsed runs nothing", async () => {
    const ref = store.taskRef(task.id);
    assistantAsks("stop", { task: ref });
    const msg = await askedInSlack(`stop ${ref}`);
    const old = new Date(Date.now() - (CONFIRM_MINUTES + 1) * 60_000).toISOString();
    const raw = JSON.parse(store.kvGet("slack.remote.confirm") ?? "[]") as { at: string }[];
    store.kvSet("slack.remote.confirm", JSON.stringify(raw.map((p) => ({ ...p, at: old }))));
    link.messages = [owner("yes", { threadTs: msg.ts })];
    await remote.tick();
    expect(ran).toHaveLength(0);
  });

  test("a top-level yes counts when one hold waits", async () => {
    const ref = store.taskRef(task.id);
    assistantAsks("stop", { task: ref });
    const msg = await askedInSlack(`stop ${ref}`);
    link.messages = [owner("Yes!")];
    await remote.tick();
    expect(ran).toHaveLength(1);
    expect(link.posts.at(-1)?.threadTs).toBe(msg.ts);
  });

  test("a move from the terminal Assistant is never held", async () => {
    const out = await runMove(engine.desk, "stop", { task: store.taskRef(task.id) }, "assistant");
    expect(out.result).toContain("stopped");
    expect(pendingConfirms()).toHaveLength(0);
  });
});

describe("notifications", () => {
  async function on(when: NotifyWhen[]) {
    testConfig().update((c) => ({ ...c, remote: { ...remoteConfig.of(c), notify: when } }));
    await remote.tick();
  }

  test("a coding agent finishing, and one waiting, are posted once; a reply names the task", async () => {
    const coding = store.createTask({ title: "fix login", kind: Kind.coding, channel: "owner" });
    const chat = store.createTask({ title: "answer Ruth", kind: Kind.general, channel: "owner" });
    await on(["finished", "waiting"]);
    expect(link.posts).toHaveLength(0);

    store.updateTask(coding.id, { agent_state: AgentState.ready });
    store.updateTask(chat.id, { agent_state: AgentState.ready });
    await remote.tick();
    const ref = store.taskRef(coding.id);
    expect(link.posts.map((p) => p.text)).toEqual([`${REPLY_MARK} ${ref} finished: fix login`]);
    expect(link.posts[0]?.threadTs).toBeUndefined();

    store.updateTask(chat.id, { agent_state: AgentState.waiting, agent_says: "Send it as is?" });
    await remote.tick();
    expect(link.posts.at(-1)?.text).toBe(
      `${REPLY_MARK} ${store.taskRef(chat.id)} is waiting for you: answer Ruth\n> Send it as is?`,
    );
    await remote.tick();
    expect(link.posts).toHaveLength(2);

    // The finished post's thread is read, and a reply there is about its task.
    const finishedTs = link.posts[0]!.ts!;
    expect(link.queries.at(-1)?.threads).toContain(finishedTs);
    link.messages = [owner("what changed?", { threadTs: finishedTs })];
    await remote.tick();
    const said = store.turnsForTask(store.homeTask().id).findLast((t) => t.role === TurnRole.you);
    expect(said?.body).toBe(`(About ${ref}) what changed?`);
  });

  test("only what was turned on", async () => {
    const coding = store.createTask({ title: "fix login", kind: Kind.coding, channel: "owner" });
    await on(["waiting"]);
    store.updateTask(coding.id, { agent_state: AgentState.ready });
    await remote.tick();
    expect(link.posts).toHaveLength(0);
  });

  test("work the owner closed is no news", () => {
    const t = store.createTask({ title: "x", kind: Kind.coding, channel: "owner" });
    store.updateTask(t.id, { status: TaskStatus.done, closed_by: "you" });
    expect(notification(store.getTask(t.id)!, AgentState.ready, ["finished"])).toBeNull();
    store.updateTask(t.id, { closed_by: "agent" });
    expect(notification(store.getTask(t.id)!, AgentState.ready, ["finished"])).toContain("closed itself");
  });
});

describe("what Slack tells the Assistant", () => {
  test("a line from Slack is answered there, and the moves it holds say so", () => {
    const lines = slackPlugin().assistant!(testConfig().get()).join("\n");
    expect(lines).toContain("A line from Slack is answered in Slack");
    expect(lines).toContain(`lapses after ${CONFIRM_MINUTES} minutes`);
  });
});
