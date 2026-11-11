// The actions on a rail row, one handler set shared by the rail and the
// table so a key does the same thing wherever focus is. (A "move" is what
// another process asks for through aug-tools; these are the owner's keys.)

import type { CommandHandlers } from "@andycmaj/opentui-app";

export type TaskActions = CommandHandlers;

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
