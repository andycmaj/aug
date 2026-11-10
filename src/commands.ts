// App commands: the framework's base commands plus aug's own.

import { BaseCommands } from "@andycmaj/opentui-app";

export const Commands = {
  ...BaseCommands,

  // App-level
  VIEW_TOGGLE: "view.toggle",
  ASK_OPEN: "assistant.open",
  NEW_TASK: "task.new",
  POLL_NOW: "ingest.poll",
  DOCS_OPEN: "docs.open",
  STATUS_OPEN: "status.open",
  WALK_NEXT: "walk.next",
  WALK_BACK: "walk.back",

  // On the item at the cursor / on the table
  OPEN: "item.open",
  DONE: "task.done",
  REMIND: "task.remind",
  WATCH: "task.watch",
  NOT_TASK: "task.not",
  START: "agent.start",
  STOP: "agent.stop",
  JUMP: "agent.jump",
  NUDGE: "agent.nudge",
  MOVE_TO_PROJECT: "task.project",
  FOLD: "rail.fold",
  PROJECT_ADOPT: "project.adopt",
  PROJECT_ARCHIVE: "project.archive",
  SEND: "action.send",
  EDIT_DRAFT: "action.edit",
  EDIT_BRIEF: "task.brief",
  REDRAFT: "action.redraft",
  PRIORITY: "task.priority",
  KIND: "task.kind",
  WAIT_ON: "task.waiton",
  OPEN_URL: "item.url",
  EDIT_FILE: "item.file.edit",
  MAKE_TASK: "item.task",
  INFO: "item.info",
  TYPE: "chat.type",

  // Task pane
  BACK_TO_RAIL: "task.back",

  // Chat input
  INPUT_SUBMIT: "input.submit",
  INPUT_LEAVE: "input.leave",
  INPUT_EDITOR: "input.editor",
  INPUT_COMPLETE: "input.complete",
  INPUT_PICK_UP: "input.pick.up",
  INPUT_PICK_DOWN: "input.pick.down",

  // Embedded terminal
  TERMINAL_DETACH: "terminal.detach",

  // Board
  BOARD_LEFT: "board.left",
  BOARD_RIGHT: "board.right",
  BOARD_TAB_1: "board.tab.1",
  BOARD_TAB_2: "board.tab.2",
  BOARD_TAB_3: "board.tab.3",
  BOARD_TAB_4: "board.tab.4",
  BOARD_TAB_5: "board.tab.5",
  BOARD_COMPOSE: "board.compose",
  WALL_COLS: "wall.cols",
} as const;
