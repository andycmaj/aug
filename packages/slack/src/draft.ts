// Slack's kind of draft: a reply in the conversation the message came from,
// in its thread unless it was a DM's top line.

import { messageMeta } from "@riker/core/meta";
import type { DraftKind } from "@riker/core/plugins";
import type { RikerConfig } from "@riker/core/config";

// A type, not an interface, so it fits core's open DraftAction.
export type SlackReply = {
  type: "slack_reply";
  channel: string;
  thread_ts?: string;
  to?: string;
  text: string;
};

export function slackReply(
  send: (action: SlackReply, config: RikerConfig) => Promise<string>,
): DraftKind<SlackReply> {
  return {
    type: "slack_reply",
    build(message, answer) {
      const meta = messageMeta(message);
      if (meta.channel !== "slack" || !meta.slackChannel) {
        return null;
      }
      const threadTs = meta.thread_ts ?? (meta.dm ? null : meta.ts);
      return {
        type: "slack_reply",
        channel: meta.slackChannel,
        thread_ts: threadTs ?? undefined,
        to: message.author_name,
        text: answer.text,
      };
    },
    describe: (action) =>
      `Slack reply${action.to ? ` to ${action.to}` : ""}${action.thread_ts ? " (in thread)" : ""}`,
    text: (action) => action.text,
    withText: (action, text) => ({ ...action, text }),
    send,
  };
}
