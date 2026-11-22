// Slack's two connectors. The poller reads watched channels, DMs and the
// threads of open tasks into the inbox through the transport config picks
// (transport.ts). The remote is the owner's own line to the Assistant
// (remote.ts, docs/slack-remote.md): opt-in, and never inbox.

import { now } from "@riker/core/db";
import { errorMessage, logger } from "@riker/core/log";
import { paths } from "@riker/core/paths";
import type { Connector, ConnectorContext } from "@riker/core/plugins";
import * as store from "@riker/core/store";
import { TaskStatus, type DraftAction } from "@riker/core/types";
import { SendError } from "@riker/core/outbound";
import { Remote, remoteChannel, type RemoteLink } from "./remote";
import { remoteLink } from "./remote-links";
import { EMPTY_CURSOR, type SlackCursor, type SlackTransport } from "./shared";
import { slackTransport } from "./transport";

const log = logger("slack");

const off = (detail: string) => ({ state: "off" as const, detail, at: null });

export class SlackConnector implements Connector {
  readonly name = "slack";
  readonly label = "Slack";
  // Read when shown: the home can move after the plugin is made.
  get hint(): string {
    return `Slack needs a user token in SLACK_TOKEN or ${paths.config()}.`;
  }
  private transport: SlackTransport | null;
  private polling = false;
  private ctx!: ConnectorContext;

  // A transport given here (tests) replaces the one config picks at start.
  constructor(transport?: SlackTransport) {
    this.transport = transport ?? null;
  }

  attach(ctx: ConnectorContext): void {
    this.ctx = ctx;
  }

  start(): void {
    const config = this.ctx.config.get();
    const slack = (this.transport ??= slackTransport(config));
    const can = slack.available();
    if (config.slack.enabled && can.ok) {
      void this.poll();
      this.ctx.every(config.slack.pollSeconds * 1000, () => void this.poll());
    } else if (!config.slack.enabled) this.ctx.setStatus(off("disabled in config"));
    else
      this.ctx.setStatus(
        slack.kind === "mcp"
          ? { state: "error", detail: can.detail, at: now() }
          : off(can.detail),
      );
  }

  stop(): void {
    this.transport?.stop();
  }

  pollNow(): Promise<void> {
    return this.poll();
  }

  // Replies go out through whichever transport polls.
  send(action: Extract<DraftAction, { type: "slack_reply" }>): Promise<string> {
    return this.transport
      ? this.transport.send(action)
      : Promise.reject(new SendError("Slack is not connected"));
  }

  async poll(): Promise<void> {
    const slack = this.transport;
    if (!slack?.available().ok || this.polling) return;
    this.polling = true;
    this.ctx.setStatus({ ...this.ctx.status(), state: "polling" });
    const done = log.time("slack poll", { transport: slack.kind });
    try {
      const config = this.ctx.config.get();
      const cursor = JSON.parse(
        store.kvGet(`slack.cursor.${slack.kind}`) ??
          JSON.stringify(EMPTY_CURSOR),
      ) as SlackCursor;
      const trackedThreads = store
        .listTasks()
        .filter(
          (t) =>
            t.status !== TaskStatus.done &&
            t.thread_key?.startsWith("slack:") &&
            !t.thread_key.endsWith(":dm"),
        )
        .map((t) => t.thread_key!.slice("slack:".length));
      const own = remoteChannel(this.ctx.config);
      const polled = await slack.poll({
        cursor,
        watchChannels: config.slack.channels,
        trackedThreads,
        firstLookSeconds: 86400,
      });
      // The remote's conversation is Riker talking with the owner, not inbox.
      const result = {
        ...polled,
        messages: polled.messages.filter((m) => m.meta?.channel !== own),
      };
      const fresh = this.ctx.ingest(result.messages);
      store.kvSet(`slack.cursor.${slack.kind}`, JSON.stringify(result.cursor));
      done({ read: result.messages.length, fresh });
      this.ctx.setStatus({
        state: "ok",
        detail: `${fresh ? `${fresh} new` : "up to date"} · ${slack.kind}`,
        at: now(),
      });
    } catch (err) {
      done({ ok: false, err });
      this.ctx.setStatus({
        state: "error",
        detail: errorMessage(err),
        at: now(),
      });
    } finally {
      this.polling = false;
    }
  }
}

export class RemoteConnector implements Connector {
  readonly name = "remote";
  readonly label = "Slack remote";
  // Shown once it is turned on.
  readonly quietWhenOff = true;
  private remote: Remote | null = null;
  private ctx!: ConnectorContext;

  // A link given here (tests) replaces the one config picks.
  constructor(private link?: RemoteLink) {}

  attach(ctx: ConnectorContext): void {
    this.ctx = ctx;
  }

  // Made on first use, so a test can tick a remote the engine never started.
  private ready(): Remote | null {
    if (this.remote) return this.remote;
    const config = this.ctx.config.get();
    if (!config.remote.enabled) {
      this.ctx.setStatus(off("disabled in config"));
      return null;
    }
    const link = this.link ?? remoteLink(config);
    if ("error" in link) {
      this.ctx.setStatus({ state: "error", detail: link.error, at: now() });
      return null;
    }
    const ctx = this.ctx;
    this.remote = new Remote({
      link,
      config: ctx.config,
      say: (taskId, text, author) => ctx.say(taskId, text, author),
      wake: (taskId) => ctx.wake(taskId, "the owner wrote from Slack"),
      // The owner's own yes in Slack: the move runs as theirs.
      runMove: (verb, args) => ctx.runMove(verb, args, "you via Slack"),
    });
    return this.remote;
  }

  start(): void {
    if (!this.ready()) return;
    void this.poll();
    this.ctx.every(this.ctx.config.get().remote.pollSeconds * 1000, () => void this.poll());
  }

  stop(): void {
    this.remote?.stop();
    this.remote = null;
  }

  async poll(): Promise<void> {
    if (!this.ctx.config.get().remote.enabled) return;
    const remote = this.ready();
    if (!remote) return;
    if (this.ctx.status().state !== "error")
      this.ctx.setStatus({ ...this.ctx.status(), state: "polling" });
    try {
      const result = await remote.tick();
      if (!result) return;
      const did = [
        result.heard ? `${result.heard} heard` : "",
        result.answered ? `${result.answered} answered` : "",
      ]
        .filter(Boolean)
        .join(", ");
      this.ctx.setStatus({
        state: "ok",
        detail: `${did || "listening"} · ${result.channel} · ${remote.kind}`,
        at: now(),
      });
    } catch (err) {
      // Slack unreachable, or the conversation is not the owner's alone:
      // nothing is heard or lost, and the next tick tries again.
      this.ctx.setStatus({
        state: "error",
        detail: errorMessage(err),
        at: now(),
      });
    }
  }
}
