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
  item: "task" | "fyi" | "idea" | "project" | null;
  kind: string | null;
  hasDraft: boolean;
  live: boolean;
  coding: boolean;
  watching: boolean;
  // Its agent has run at least once: the brief is settled.
  started: boolean;
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
// Home is a task row but not work: no done, later, kind or priority.
const isWork = (c: HelpCtx) => isTask(c) && c.kind !== "home";

// The actions on a row, the same from the rail and from the table.
const taskActions: BindingSpec<HelpCtx>[] = [
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
  // Shares e with the draft; a task with a draft has started, so they never
  // both apply.
  {
    key: "e",
    cmd: Commands.EDIT_BRIEF,
    desc: "edit the brief in $EDITOR (before it starts)",
    help: "brief",
    relevant: (c) => isWork(c) && !c.started && !c.hasDraft,
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
    relevant: (c) => isWork(c) && !c.live,
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
    relevant: (c) => c.coding || c.item === "project",
  },
  {
    key: "shift+m",
    cmd: Commands.MOVE_TO_PROJECT,
    desc: "move it to a project",
    relevant: (c) => c.coding,
  },
  {
    key: "u",
    cmd: Commands.NUDGE,
    desc: "nudge the agent to read new reviews / CI",
    help: "nudge",
    relevant: (c) => c.coding,
  },
  {
    key: "d",
    cmd: Commands.DONE,
    desc: "mark done",
    help: "done",
    relevant: isWork,
  },
  {
    key: "r",
    cmd: Commands.REMIND,
    desc: "remind me later",
    help: "later",
    relevant: isWork,
  },
  {
    key: "w",
    cmd: Commands.WATCH,
    desc: "watch it / stop watching",
    relevant: isWork,
  },
  {
    key: "x",
    cmd: Commands.NOT_TASK,
    desc: "not a task / read / dismiss",
    help: "not a task",
    relevant: (c) => c.item !== null && c.item !== "project" && c.kind !== "home",
  },
  {
    key: "x",
    cmd: Commands.PROJECT_ARCHIVE,
    desc: "archive the project",
    help: "archive",
    relevant: (c) => c.item === "project",
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
    relevant: isWork,
  },
  {
    key: "t",
    cmd: Commands.KIND,
    desc: "change what kind of work it is",
    relevant: isWork,
  },
  {
    key: "shift+w",
    cmd: Commands.WAIT_ON,
    desc: "hand it to a person (waiting on them)",
    relevant: isWork,
  },
  {
    key: "o",
    cmd: Commands.OPEN_URL,
    desc: "open the link, a URL on the task, or a file the agent made",
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
      desc: "Home: ask the Assistant anything",
      help: "home",
    },
    {
      key: "n",
      cmd: Commands.WALK_NEXT,
      desc: "next (walk the rail)",
      help: "next",
    },
    { key: "b", cmd: Commands.WALK_BACK, desc: "back" },
    {
      key: "/",
      cmd: Commands.SEARCH_OPEN,
      desc: "search the rail: words, AUG-23, #412, @someone",
      help: "search",
    },
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
    {
      key: "space",
      cmd: Commands.FOLD,
      desc: "fold / unfold the project's tasks",
      help: "fold",
      relevant: (c) => c.item === "project",
    },
    ...taskActions,
  ],
  task: [
    ...(navBindings() as BindingSpec<HelpCtx>[]),
    { key: "escape", cmd: Commands.BACK_TO_RAIL, desc: "back to the rail" },
    ...quietWhileTyping(taskActions),
  ],
  input: [
    { key: "return", cmd: Commands.INPUT_SUBMIT, desc: "send (or take the @ suggestion)" },
    { key: "tab", cmd: Commands.INPUT_COMPLETE, desc: "@: take the suggestion" },
    { key: "up", cmd: Commands.INPUT_PICK_UP, desc: "@: previous suggestion" },
    { key: "down", cmd: Commands.INPUT_PICK_DOWN, desc: "@: next suggestion" },
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
    {
      key: "2",
      cmd: Commands.BOARD_TAB_2,
      desc: "live handoffs",
      help: "handoffs",
    },
    { key: "3", cmd: Commands.BOARD_TAB_3, desc: "hub", help: "hub" },
    { key: "4", cmd: Commands.BOARD_TAB_4, desc: "projects", help: "projects" },
    { key: "shift+a", cmd: Commands.PROJECT_ADOPT, desc: "projects: adopt a tmux session" },
    { key: "x", cmd: Commands.PROJECT_ARCHIVE, desc: "projects: archive the project" },
    { key: "shift+m", cmd: Commands.MOVE_TO_PROJECT, desc: "move the task to a project" },
    { key: "return", cmd: Commands.OPEN, desc: "open", help: "open" },
    {
      key: "c",
      cmd: Commands.BOARD_COMPOSE,
      desc: "write a note / hub entry",
      help: "write",
    },
    { key: "s", cmd: Commands.START, desc: "start / continue the agent" },
    { key: "shift+s", cmd: Commands.STOP, desc: "stop the agent and save" },
    { key: "shift+t", cmd: Commands.JUMP, desc: "jump to the agent's tmux window" },
    { key: "u", cmd: Commands.NUDGE, desc: "nudge the agent about new feedback" },
    { key: "d", cmd: Commands.DONE, desc: "mark done" },
  ],
};
