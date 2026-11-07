// Declarative keymap: framework base bindings plus aug's own, keyed by scope.
// "app" applies anywhere in a mode's pane layout; the rest while focus is
// within that pane. Footer, palette and help all read this table.

import {
  baseAppBindings,
  navBindings,
  type BindingSpec,
  type KeymapTable,
} from "@andycmaj/opentui-app";
import { Commands } from "./commands";

// What the footer needs to know to show only the moves that apply.
export interface HelpCtx {
  item: "task" | "fyi" | "idea" | null;
  kind: string | null;
  hasDraft: boolean;
  live: boolean;
  coding: boolean;
  watching: boolean;
  // A text box has focus: only its own keys are worth showing.
  typing?: boolean;
}

// Hide a binding from the footer while typing (dispatch is unaffected).
function quietWhileTyping(
  specs: BindingSpec<HelpCtx>[],
): BindingSpec<HelpCtx>[] {
  return specs.map((spec) => ({
    ...spec,
    relevant: (c: HelpCtx) => !c.typing && (spec.relevant?.(c) ?? true),
  }));
}

export const CHAT_PANES = ["rail", "task", "input"];
export const BOARD_PANES = ["board"];

const listNav = navBindings().filter(
  (b) => b.cmd !== Commands.SCROLL_PAGEUP && b.cmd !== Commands.SCROLL_PAGEDOWN,
);

const isTask = (c: HelpCtx) => c.item === "task";

// The moves on an item, the same from the rail row and from the table.
const itemMoves: BindingSpec<HelpCtx>[] = [
  {
    key: "y",
    cmd: Commands.SEND,
    desc: "send the draft (asks first)",
    help: "send",
    relevant: (c) => c.hasDraft,
  },
  {
    key: "e",
    cmd: Commands.EDIT_DRAFT,
    desc: "edit the draft in $EDITOR",
    help: "edit",
    relevant: (c) => c.hasDraft,
  },
  {
    key: "shift+e",
    cmd: Commands.REDRAFT,
    desc: "ask for a different draft",
    relevant: (c) => c.hasDraft,
  },
  {
    key: "s",
    cmd: Commands.START,
    desc: "start / continue the agent",
    help: "start",
    relevant: (c) => isTask(c) && !c.live,
  },
  {
    key: "shift+s",
    cmd: Commands.STOP,
    desc: "stop the agent and save",
    help: "stop",
    relevant: (c) => c.live,
  },
  {
    key: "shift+t",
    cmd: Commands.JUMP,
    desc: "jump your tmux client to the agent's window",
    help: "jump",
    relevant: (c) => c.coding,
  },
  {
    key: "d",
    cmd: Commands.DONE,
    desc: "mark done",
    help: "done",
    relevant: isTask,
  },
  {
    key: "r",
    cmd: Commands.REMIND,
    desc: "remind me later",
    help: "later",
    relevant: isTask,
  },
  {
    key: "w",
    cmd: Commands.WATCH,
    desc: "watch it / stop watching",
    relevant: isTask,
  },
  {
    key: "x",
    cmd: Commands.NOT_TASK,
    desc: "not a task / read / dismiss",
    help: "not a task",
    relevant: (c) => c.item !== null,
  },
  {
    key: "m",
    cmd: Commands.MAKE_TASK,
    desc: "make it a task",
    help: "make task",
    relevant: (c) => c.item === "fyi" || c.item === "idea",
  },
  {
    key: "p",
    cmd: Commands.PRIORITY,
    desc: "cycle priority",
    relevant: isTask,
  },
  {
    key: "t",
    cmd: Commands.KIND,
    desc: "change what kind of work it is",
    relevant: isTask,
  },
  {
    key: "shift+w",
    cmd: Commands.WAIT_ON,
    desc: "hand it to a person (waiting on them)",
    relevant: isTask,
  },
  {
    key: "o",
    cmd: Commands.OPEN_URL,
    desc: "open the link or a file the agent made",
  },
  {
    key: "shift+o",
    cmd: Commands.EDIT_FILE,
    desc: "edit a file the agent made in $EDITOR",
    relevant: isTask,
  },
  {
    key: "shift+i",
    cmd: Commands.INFO,
    desc: "everything aug knows about it",
    help: "info",
    relevant: (c) => c.item !== null,
  },
  {
    key: "i",
    cmd: Commands.TYPE,
    desc: "type to the agent",
    help: "type",
    relevant: isTask,
  },
];

export const keymap: KeymapTable<HelpCtx> = {
  app: quietWhileTyping([
    ...(baseAppBindings as BindingSpec<HelpCtx>[]),
    {
      key: "v",
      cmd: Commands.VIEW_TOGGLE,
      desc: "switch Chat / Board",
      help: "view",
    },
    {
      key: "a",
      cmd: Commands.ASK_OPEN,
      desc: "ask the Assistant",
      help: "ask",
    },
    {
      key: "n",
      cmd: Commands.WALK_NEXT,
      desc: "next (walk the rail)",
      help: "next",
    },
    { key: "b", cmd: Commands.WALK_BACK, desc: "back" },
    { key: "shift+n", cmd: Commands.NEW_TASK, desc: "new task" },
    {
      key: "ctrl+r",
      cmd: Commands.POLL_NOW,
      desc: "check GitHub and Slack now",
    },
    {
      key: "shift+d",
      cmd: Commands.DOCS_OPEN,
      desc: "edit SOUL / JOB / LEARNED ...",
    },
    {
      key: "shift+c",
      cmd: Commands.STATUS_OPEN,
      desc: "connections and Advisor status",
    },
  ]),
  rail: [
    ...(listNav as BindingSpec<HelpCtx>[]),
    { key: "return", cmd: Commands.OPEN, desc: "put it on the table" },
    ...itemMoves,
  ],
  task: [
    ...(navBindings() as BindingSpec<HelpCtx>[]),
    { key: "escape", cmd: Commands.BACK_TO_RAIL, desc: "back to the rail" },
    ...quietWhileTyping(itemMoves),
  ],
  input: [
    { key: "return", cmd: Commands.INPUT_SUBMIT, desc: "send to the agent" },
    {
      key: "ctrl+g",
      cmd: Commands.INPUT_EDITOR,
      desc: "write it in $EDITOR (save and quit sends)",
      help: "editor",
    },
    {
      key: "escape",
      cmd: Commands.INPUT_LEAVE,
      desc: "leave the box",
      help: "leave",
    },
  ],
  // Reserved while a terminal is attached: every other key goes to it.
  terminal: [
    {
      key: "ctrl+]",
      cmd: Commands.TERMINAL_DETACH,
      desc: "detach from the terminal",
      help: "detach",
    },
  ],
  board: [
    ...(listNav as BindingSpec<HelpCtx>[]),
    { key: "h", cmd: Commands.BOARD_LEFT, desc: "left" },
    { key: "left", cmd: Commands.BOARD_LEFT, desc: "left" },
    { key: "l", cmd: Commands.BOARD_RIGHT, desc: "right" },
    { key: "right", cmd: Commands.BOARD_RIGHT, desc: "right" },
    { key: "1", cmd: Commands.BOARD_TAB_1, desc: "columns", help: "columns" },
    { key: "2", cmd: Commands.BOARD_TAB_2, desc: "wall", help: "wall" },
    {
      key: "3",
      cmd: Commands.BOARD_TAB_3,
      desc: "live handoffs",
      help: "handoffs",
    },
    { key: "4", cmd: Commands.BOARD_TAB_4, desc: "hub", help: "hub" },
    { key: "return", cmd: Commands.OPEN, desc: "open / attach", help: "open" },
    {
      key: "c",
      cmd: Commands.BOARD_COMPOSE,
      desc: "write a note / hub entry",
      help: "write",
    },
    { key: "shift+l", cmd: Commands.WALL_COLS, desc: "wall: tiles across" },
    { key: "s", cmd: Commands.START, desc: "start / continue the agent" },
    { key: "shift+s", cmd: Commands.STOP, desc: "stop the agent and save" },
    { key: "shift+t", cmd: Commands.JUMP, desc: "jump to the agent's tmux window" },
    { key: "d", cmd: Commands.DONE, desc: "mark done" },
  ],
};
