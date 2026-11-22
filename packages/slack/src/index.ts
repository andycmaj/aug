// Slack as a plugin: the inbox poller, the owner's remote line to the
// Assistant, replies out through the poller's transport, and the hold on
// moves the Assistant asks for while answering Slack. Core knows none of it.

import type { MoveGuard, RikerPlugin } from "@riker/core/plugins";
import { CONFIRM_MOVES, holdForYes, SLACK_ASKER } from "./confirm";
import { RemoteConnector, SlackConnector } from "./connector";
import type { RemoteLink } from "./remote";
import type { SlackTransport } from "./shared";
import { slackReply, type SlackReply } from "./draft";

export { RemoteConnector, SlackConnector, slackReply, type SlackReply };

export interface SlackOptions {
  // Replace what config picks (tests).
  transport?: SlackTransport;
  remoteLink?: RemoteLink;
}

// From Slack, work is started or ended only on the owner's own yes there.
export const confirmGuard: MoveGuard = (verb, args, by) =>
  by === SLACK_ASKER && CONFIRM_MOVES.has(verb) ? holdForYes(verb, args) : null;

export function slackPlugin(
  options: SlackOptions = {},
): RikerPlugin & { poller: SlackConnector; remote: RemoteConnector } {
  const poller = new SlackConnector(options.transport);
  const remote = new RemoteConnector(options.remoteLink);
  return {
    name: "slack",
    poller,
    remote,
    connectors: [poller, remote],
    drafts: [slackReply((action) => poller.send(action))],
    guards: [confirmGuard],
  };
}
