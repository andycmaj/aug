// The moves on an item, one handler set shared by the rail row and the table
// so a key does the same thing wherever focus is.

import type { CommandHandlers } from "@andycmaj/opentui-app";

export type ItemMoves = CommandHandlers;

// Handlers that decline while a text box has focus, so typed keys reach it.
export function unlessTyping(
  handlers: CommandHandlers,
  typing: () => boolean,
): CommandHandlers {
  return Object.fromEntries(
    Object.entries(handlers).map(([cmd, fn]) => [
      cmd,
      () => (typing() ? false : fn?.()),
    ]),
  );
}
