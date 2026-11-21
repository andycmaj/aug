import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setBrain } from "../src/brain";
import { AgentPool } from "../src/agents";
import { db, openDb, useDb } from "../src/db";
import { paths } from "../src/paths";
import * as store from "../src/store";
import { TurnRole, TurnStatus } from "../src/types";
import { freshHome, withLimit } from "./support/helpers";

// Another process (an agent's hook, aug-tools) holding the write lock, as
// it does while the owner replies in a chat. It lets go after `holdMs`, or
// when its stdin closes. A busy wait blocks this process's event loop, so
// only the holder's own timer can end a lock this process is waiting on.
const HOLDER = `
import { Database } from "bun:sqlite";
const db = new Database(process.argv[1]);
db.exec("BEGIN IMMEDIATE");
db.exec("INSERT INTO kv (key, value) VALUES ('holder', 'x')");
console.log("locked");
const holdMs = Number(process.argv[2]);
await (holdMs > 0 ? Bun.sleep(holdMs) : Bun.stdin.text());
db.exec("COMMIT");
`;

type Holder = { release: () => Promise<void> };

async function holdWriteLock(file: string, holdMs = 0): Promise<Holder> {
  const proc = Bun.spawn(["bun", "-e", HOLDER, file, String(holdMs)], {
    stdin: "pipe",
    stdout: "pipe",
  });
  const lines = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
  expect((await lines.read()).value?.trim()).toBe("locked");
  return {
    release: async () => {
      proc.stdin.end();
      expect(await proc.exited).toBe(0);
    },
  };
}

let file: string;

beforeEach(() => {
  freshHome({ log: { enabled: true, level: "debug" } });
  file = join(process.env.AUG_HOME!, "aug.db");
  useDb(openDb(file));
  setBrain(async (call) => ({
    text: "On it.",
    structured: null,
    sessionId: call.sessionId ?? call.resume ?? null,
    durationMs: 1,
    isError: false,
  }));
});

afterEach(() => {
  db().close();
});

function reply(taskId: number, body: string) {
  store.addTurn({ taskId, role: TurnRole.you, author: "you", body });
}

describe("replying in the Assistant's thread while another process writes", () => {
  test("waits for the lock instead of failing", async () => {
    const home = store.homeTask();
    reply(home.id, "make a task");
    const holder = await holdWriteLock(file, 200);
    await new AgentPool({ config: withLimit(4) }).request(home.id, "the owner typed in the chat", "owner");
    await holder.release();
    const answer = store.turnsForTask(home.id).at(-1)!;
    expect(answer).toMatchObject({ role: TurnRole.agent, status: TurnStatus.done, body: "On it." });
  });

  test("a lock held past the busy timeout is a failed turn in the thread, not an unhandled rejection", async () => {
    db().exec("PRAGMA busy_timeout = 50");
    const home = store.homeTask();
    reply(home.id, "make a task");
    const holder = await holdWriteLock(file);
    const turn = new AgentPool({ config: withLimit(4) }).request(home.id, "the owner typed in the chat", "owner");
    await holder.release();
    await turn;

    const last = store.turnsForTask(home.id).at(-1)!;
    expect(last.role).toBe(TurnRole.agent);
    expect(last.status).toBe(TurnStatus.failed);
    expect(last.body).toContain("database is locked");
    const log = existsSync(paths.log()) ? readFileSync(paths.log(), "utf8") : "";
    expect(log).toContain("turn could not start");
    expect(log).toContain(`"task":${home.id}`);
  });
});
