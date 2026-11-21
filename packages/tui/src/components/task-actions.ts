// The actions on a rail row, one handler set shared by the rail and the
// Canvas so a key does the same thing wherever focus is. (A "move" is what
// another process asks for through aug-tools; these are the owner's keys.)

import type { CommandHandlers } from "@andycmaj/opentui-app";

export type TaskActions = CommandHandlers;

// The terminal a task action opens on the Canvas (the guide's plannotator
// review, a quiz when the agent has no window).
export const actionTermId = (taskId: number) => `action-${taskId}`;

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
