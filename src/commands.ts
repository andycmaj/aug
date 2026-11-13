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
  SEARCH_OPEN: "search.open",

  // On the item at the cursor / on the table
  OPEN: "item.open",
  DONE: "task.done",
  REMIND: "task.remind",
  WATCH: "task.watch",
  NOT_TASK: "task.not",
  READ_FYI: "fyi.read",
  DISMISS_IDEA: "idea.dismiss",
  START: "agent.start",
  STOP: "agent.stop",
  JUMP: "agent.jump",
  NUDGE: "agent.nudge",
  MOVE_TO_PROJECT: "task.project",
  FOLD: "rail.fold",
  FILTER_CYCLE: "rail.filter.cycle",
  FILTER_CLEAR: "rail.filter.clear",
  FILTER_1: "rail.filter.1",
  FILTER_2: "rail.filter.2",
  FILTER_3: "rail.filter.3",
  FILTER_4: "rail.filter.4",
  FILTER_5: "rail.filter.5",
  FILTER_6: "rail.filter.6",
  FILTER_7: "rail.filter.7",
  FILTER_8: "rail.filter.8",
  PROJECT_ADOPT: "project.adopt",
  PROJECT_ARCHIVE: "project.archive",
  PROJECT_EDIT: "project.edit",
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
  PR_DASH: "pr.dash",
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
  BOARD_COMPOSE: "board.compose",
} as const;
