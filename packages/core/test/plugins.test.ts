import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { configSection } from "../src/config";
import { Engine } from "../src/engine";
import { setMux } from "../src/mux";
import type { Connector, ConnectorContext, DraftKind, RikerPlugin } from "../src/plugins";
import * as store from "../src/store";
import { Kind, MessageState, TurnRole } from "../src/types";
import { FakeMux } from "./support/fake-mux";
import { freshHome, testConfig } from "./support/helpers";

let engine: Engine | null = null;

beforeEach(() => {
  freshHome();
  setMux(new FakeMux());
});

afterEach(() => {
  engine?.stop();
  engine = null;
});

class FakeConnector implements Connector {
  readonly label = "Fake";
  ctx: ConnectorContext | null = null;
  started = 0;
  stopped = 0;
  constructor(readonly name = "fake") {}
  attach(ctx: ConnectorContext) {
    this.ctx = ctx;
  }
  start() {
    this.started++;
    this.ctx!.setStatus({ state: "ok", detail: "listening", at: null });
  }
  stop() {
    this.stopped++;
  }
}

function message(n: number): store.NewMessage {
  return {
    // Channel is still core's closed list (github, slack, owner).
    channel: "slack",
    externalId: `fake:${n}`,
    threadKey: `fake:${n}`,
    author: "u",
    authorName: "U",
    title: "t",
    body: "hello",
    receivedAt: new Date().toISOString(),
  };
}

describe("a plugin's connectors", () => {
  test("are attached at construction, started and stopped with the engine, and keyed by name", () => {
    const c = new FakeConnector();
    engine = new Engine({ config: testConfig(), plugins: [{ name: "p", connectors: [c] }] });
    expect(c.ctx).not.toBeNull();
    expect(engine.status.fake).toMatchObject({ state: "off", detail: "not started" });
    expect(engine.connections().map((x) => x.name)).toEqual(["fake"]);
    engine.start();
    expect(c.started).toBe(1);
    expect(engine.status.fake).toMatchObject({ state: "ok", detail: "listening" });
    engine.stop();
    expect(c.stopped).toBe(1);
  });

  test("are not started on the fixture day, and say so", () => {
    const c = new FakeConnector();
    engine = new Engine({ config: testConfig(), offline: true, plugins: [{ name: "p", connectors: [c] }] });
    engine.start();
    expect(c.started).toBe(0);
    expect(engine.status.fake).toMatchObject({ state: "off", detail: "fixture mode" });
  });

  test("two of one name are refused", () => {
    expect(
      () =>
        new Engine({
          config: testConfig(),
          plugins: [{ name: "a", connectors: [new FakeConnector("x"), new FakeConnector("x")] }],
        }),
    ).toThrow("two connectors are called x");
  });

  test("ingest inserts once; without triage the message waits untriaged", async () => {
    const c = new FakeConnector();
    engine = new Engine({ config: testConfig(), offline: true, plugins: [{ name: "p", connectors: [c] }] });
    expect(c.ctx!.ingest([message(1), message(1)])).toBe(1);
    expect(await engine.triageInbox()).toBe(0);
    expect(store.recentMessages(10).map((m) => m.state)).toEqual([MessageState.new]);
  });
});

describe("a plugin's triage", () => {
  test("hears each fresh message and runs on the worker", async () => {
    const arrived: number[] = [];
    let ran = 0;
    const plugin: RikerPlugin = {
      name: "judge",
      triage: {
        arrived: (m) => void arrived.push(m.id),
        next: async () => {
          const due = store.dueMessages(new Date().toISOString())[0];
          if (!due || !store.claimMessage(due.id)) return null;
          ran++;
          store.settleMessage(due.id, MessageState.done);
          return { messages: [due.id], outcome: { verdict: "fyi", taskId: null, reason: "r", effects: [] } };
        },
        again: () => Promise.reject(new Error("unused")),
        fromHeld: () => null,
      },
    };
    const c = new FakeConnector();
    engine = new Engine({ config: testConfig(), offline: true, plugins: [plugin, { name: "p", connectors: [c] }] });
    c.ctx!.ingest([message(1), message(2)]);
    expect(arrived).toHaveLength(2);
    expect(await engine.triageInbox()).toBe(2);
    expect(ran).toBe(2);
  });

  test("only one plugin may bring it", () => {
    const judge = { next: async () => null, again: () => Promise.reject(new Error()), fromHeld: () => null };
    expect(
      () =>
        new Engine({
          config: testConfig(),
          plugins: [
            { name: "a", triage: judge },
            { name: "b", triage: judge },
          ],
        }),
    ).toThrow("more than one plugin brings triage");
  });

  test("without it, r says so", async () => {
    engine = new Engine({ config: testConfig(), offline: true });
    const m = store.insertMessage(message(1))!;
    expect(await engine.desk.retriage(m.id)).toEqual({ ok: false, why: "no triage is installed" });
  });
});

describe("a plugin's drafts and guards", () => {
  function draft(): number {
    const t = store.createTask({ title: "reply", kind: Kind.general, channel: "github" });
    const turn = store.addTurn({ taskId: t.id, role: TurnRole.agent, body: "draft" });
    store.setTurnAction(turn.id, { type: "github_comment", repo: "a/b", number: 1, body: "thanks" });
    return t.id;
  }

  const comment: DraftKind = {
    type: "github_comment",
    build: () => null,
    describe: (a) => `comment on ${String(a.repo)}`,
    text: (a) => String(a.body),
    withText: (a, body) => ({ ...a, body }),
    send: async (a) => (sent.push(String(a.body)), "commented"),
  };
  let sent: string[] = [];
  beforeEach(() => (sent = []));

  test("a draft goes out through the kind that made it, in its words", async () => {
    engine = new Engine({ config: testConfig(), offline: true, plugins: [{ name: "gh", drafts: [comment] }] });
    expect(engine.desk.drafts.describe(store.pendingAction(draft())!.action)).toBe("comment on a/b");
    expect(await engine.desk.send(draft())).toBe("commented");
    expect(sent).toEqual(["thanks"]);
  });

  test("with no kind for its type, nothing goes and it says why", async () => {
    engine = new Engine({ config: testConfig(), offline: true });
    await expect(engine.desk.send(draft())).rejects.toThrow("nothing is connected to send a github_comment draft");
  });

  test("two plugins cannot bring one kind", () => {
    expect(
      () => new Engine({ config: testConfig(), offline: true, plugins: [{ name: "a", drafts: [comment] }, { name: "b", drafts: [comment] }] }),
    ).toThrow("two plugins draft github_comment");
  });

  test("a guard holds a move instead of running it", async () => {
    engine = new Engine({
      config: testConfig(),
      offline: true,
      plugins: [{ name: "g", guards: [(verb, _args, by) => (by === "remote" && verb === "done" ? "held for a yes" : null)] }],
    });
    const t = store.createTask({ title: "x", kind: Kind.general, channel: "owner" });
    const ref = store.taskRef(t.id);
    expect(await engine.runMove("done", { task: ref }, "remote")).toEqual({ ok: true, result: "held for a yes" });
    expect(store.getTask(t.id)!.status).toBe("open");
    expect((await engine.runMove("done", { task: ref }, "you")).ok).toBe(true);
    expect(store.getTask(t.id)!.status).toBe("done");
  });
});

describe("a plugin's config", () => {
  test("a section may not take a core key, or one another plugin has", () => {
    const repos = configSection("repos", {});
    const mine = configSection("mine", {});
    expect(() => new Engine({ config: testConfig(), offline: true, plugins: [{ name: "a", config: [repos] }] })).toThrow(
      "config key repos is taken",
    );
    expect(
      () =>
        new Engine({
          config: testConfig(),
          offline: true,
          plugins: [
            { name: "a", config: [mine] },
            { name: "b", config: [mine] },
          ],
        }),
    ).toThrow("config key mine is taken");
  });
});
