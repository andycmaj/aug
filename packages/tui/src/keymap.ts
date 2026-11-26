// Declarative keymap: framework base bindings plus Riker's own, keyed by scope.
// "app" applies anywhere in a mode's pane layout; the rest while focus is
// within that pane. The footer and the ? help both show only what is
// reachable from the focused pane and `relevant` to what is under it
// (`helpBindings`), so neither lists a key that would do nothing here.

import {
  baseAppBindings,
  dropShadowed,
  navBindings,
  type BindingSpec,
  type HelpBinding,
  type KeymapTable,
} from "@andycmaj/opentui-app";
import { Commands } from "./commands";
import type { NavKeys } from "@riker/core/config";
import { RAIL_FILTERS } from "@riker/core/rail";

// What the footer needs to know to show only the moves that apply.
export interface HelpCtx {
  // message, fyi and idea are Inbox rows (the Board's tab), never the rail's.
  item: "task" | "message" | "fyi" | "idea" | "project" | "doc" | null;
  kind: string | null;
  hasDraft: boolean;
  live: boolean;
  coding: boolean;
  watching: boolean;
  // Its agent has run at least once: the brief is settled.
  started: boolean;
  // Done or dropped: d reopens it rather than marks it done.
  closed?: boolean;
  // The task has a pull request ghdash can show.
  pr: boolean;
  // The task actions offered on this row (actionsFor), so an action's own
  // key shows only where it runs. Unset: every work row.
  actions?: string[];
  // A text box has focus: only its own keys are worth showing.
  typing?: boolean;
  // The rail's status filter hides some rows.
  filtered?: boolean;
  // An embedded terminal owns the keyboard: only its scope's keys reach Riker.
  attached?: boolean;
  // The Board's tab, while focus is on the Board.
  board?: BoardTab;
  // An Inbox row: it made or joined a task (an idea: it is about one).
  inboxTask?: boolean;
  // An Inbox idea already approved or dismissed.
  handled?: boolean;
  // An Inbox message already read (dismissed): it has left "actionable".
  inboxRead?: boolean;
  // An Inbox message that made its task (not one that joined a task).
  inboxMade?: boolean;
  // An Inbox row's task Start and Move act on: the one a message made or
  // joined, or the one an approved idea made.
  inboxWork?: boolean;
  // The Wins tab shows today (l and 0 have nowhere to go).
  winsToday?: boolean;
  // A Docs row a task or project owns (t has somewhere to go).
  docOwned?: boolean;
  // A Docs row someone attached, so it can be taken off.
  docRemovable?: boolean;
  // The terminal sends ctrl+[ apart from Esc (the kitty keyboard protocol;
  // never inside tmux). Without it ctrl+[ is Esc, so back is not offered.
  kittyKeys?: boolean;
}

// In tab order (keys 1-6): Wins first.
export const BoardTab = {
  wins: "wins",
  columns: "columns",
  knowledge: "knowledge",
  inbox: "inbox",
  cost: "cost",
  docs: "docs",
} as const;
export type BoardTab = (typeof BoardTab)[keyof typeof BoardTab];

// Section titles for the ? help, one per scope.
export const SCOPE_LABELS: Record<string, string> = {
  toast: "An error toast (while one is up)",
  terminal: "The terminal (every other key goes to it)",
  input: "The chat box",
  rail: "The rail",
  canvas: "The Canvas",
  board: "The Board",
  app: "Anywhere",
};

// What the footer and help show from the bindings reachable from the focused
// pane (innermost layer first): the relevant ones, then the first per key,
// since that is the one that runs (`dropShadowed`). While a terminal is
// attached, every key but its own goes to it.
export function helpBindings<B extends HelpBinding<HelpCtx>>(
  reachable: B[],
  ctx: HelpCtx,
): B[] {
  const live = reachable.filter(
    (b) =>
      (!ctx.attached || b.scope === "terminal") && (b.relevant?.(ctx) ?? true),
  );
  // dropShadowed filters without copying; keep the caller's element type.
  const kept = new Set<HelpBinding<HelpCtx>>(dropShadowed(live));
  return live.filter((b) => kept.has(b));
}

// Keys whose handlers still act while the chat box has focus (shell.tsx
// wraps the rest in unlessTyping).
const WORK_WHILE_TYPING = new Set<string>([
  Commands.FOCUS_NEXT,
  Commands.GO_BACK,
  Commands.GO_HOME,
  Commands.SIDEBAR_TOGGLE,
  Commands.POLL_NOW,
]);

// Hide a binding from the footer and help while typing: its handler declines
// then, so the key types instead.
function quietWhileTyping(
  specs: BindingSpec<HelpCtx>[],
): BindingSpec<HelpCtx>[] {
  return specs.map((spec) =>
    WORK_WHILE_TYPING.has(spec.cmd)
      ? spec
      : {
          ...spec,
          relevant: (c: HelpCtx) => !c.typing && (spec.relevant?.(c) ?? true),
        },
  );
}

export const CHAT_PANES = ["rail", "canvas", "input"];
export const BOARD_PANES = ["board"];

const listNav = navBindings().filter(
  (b) => b.cmd !== Commands.SCROLL_PAGEUP && b.cmd !== Commands.SCROLL_PAGEDOWN,
);

// The rail's filter bar: a digit toggles its pill, as tilt-tui's resource
// filter does. Digits mean nothing else on the rail.
export const FILTER_COMMANDS = [
  Commands.FILTER_1,
  Commands.FILTER_2,
  Commands.FILTER_3,
  Commands.FILTER_4,
  Commands.FILTER_5,
  Commands.FILTER_6,
  Commands.FILTER_7,
  Commands.FILTER_8,
  Commands.FILTER_9,
] as const;

const railFilters: BindingSpec<HelpCtx>[] = [
  {
    key: "f",
    cmd: Commands.FILTER_CYCLE,
    desc: "filter by status: the next one with tasks",
    help: "filter",
  },
  {
    key: "0",
    cmd: Commands.FILTER_CLEAR,
    desc: "filter: show every status",
    help: "all",
    relevant: (c) => Boolean(c.filtered),
  },
  // One desc for all, so the ? help shows them as one "1-8" row; the rail's
  // filter bar names each pill beside its digit.
  ...RAIL_FILTERS.map((_, i) => ({
    key: `${i + 1}`,
    cmd: FILTER_COMMANDS[i],
    desc: "filter: toggle that status pill (the bar above the rail)",
  })),
];

const isTask = (c: HelpCtx) => c.item === "task";
// Home is a task row but not work: no done, later, kind or priority. Nor is
// a System task (Riker asking about its docs): it has its own keys.
const isWork = (c: HelpCtx) =>
  isTask(c) && c.kind !== "home" && c.kind !== "system";
const isSystem = (c: HelpCtx) => isTask(c) && c.kind === "system";
const onColumns = (c: HelpCtx) => c.board === BoardTab.columns;
const onInbox = (c: HelpCtx) => c.board === BoardTab.inbox;
const onWins = (c: HelpCtx) => c.board === BoardTab.wins;
const onDocs = (c: HelpCtx) => c.board === BoardTab.docs;
const onDoc = (c: HelpCtx) => onDocs(c) && c.item === "doc";
// An Inbox message (an FYI or not), not an idea.
const inboxMessage = (c: HelpCtx) =>
  onInbox(c) && (c.item === "message" || c.item === "fyi");

// The actions on a row, the same from the rail and from the Canvas.
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
  // d means done on an open row and reopen on a closed one.
  {
    key: "d",
    cmd: Commands.DONE,
    desc: "mark done",
    help: "done",
    relevant: (c) => isWork(c) && !c.closed,
  },
  {
    key: "d",
    cmd: Commands.REOPEN,
    desc: "reopen (done or dropped; its agent does not start)",
    help: "reopen",
    relevant: (c) => isWork(c) && Boolean(c.closed),
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
    key: "z",
    cmd: Commands.WIN,
    desc: "pin as one of today's Wins / unpin",
    help: "win",
    relevant: isWork,
  },
  // x clears the row off the rail, and what that means depends on the row:
  // one command per meaning, so the footer and help name the one that applies.
  {
    key: "x",
    cmd: Commands.IGNORE,
    desc: "ignore: not work, dropped (ctrl+z or d undoes)",
    help: "ignore",
    relevant: isWork,
  },
  // J flips a row's session write-up: a task's story, a project's journal.
  {
    key: "shift+j",
    cmd: Commands.STORY_SWITCH,
    desc: "story on/off: the task's state of play, kept from each finished session",
    help: "story",
    relevant: isWork,
  },
  {
    key: "shift+j",
    cmd: Commands.JOURNAL_SWITCH,
    desc: "journal on/off: the project's file of finished sessions and task events",
    help: "journal",
    relevant: (c) => c.item === "project",
  },
  // V reads it, rendered as markdown; e in the reader opens $EDITOR.
  {
    key: "shift+v",
    cmd: Commands.STORY_READ,
    desc: "read the task's story as markdown (e there rewrites it in $EDITOR)",
    help: "read story",
    relevant: isWork,
  },
  {
    key: "shift+v",
    cmd: Commands.JOURNAL_READ,
    desc: "read the project's journal as markdown (e there opens the file in $EDITOR)",
    help: "read journal",
    relevant: (c) => c.item === "project",
  },
  {
    key: "x",
    cmd: Commands.PROJECT_ARCHIVE,
    desc: "archive the project",
    help: "archive",
    relevant: (c) => c.item === "project",
  },
  // A System task's keys share y, e and x with the draft's and the work's;
  // a System task never has a draft and is never work.
  {
    key: "y",
    cmd: Commands.DOC_ACCEPT,
    desc: "System: accept (take the shipped doc, write the drafts, or start the interview)",
    help: "accept",
    relevant: (c) => isSystem(c) && !c.hasDraft,
  },
  {
    key: "x",
    cmd: Commands.DOC_REJECT,
    desc: "System: reject (keep your doc, or skip)",
    help: "reject",
    relevant: isSystem,
  },
  {
    key: "e",
    cmd: Commands.DOC_REVIEW,
    desc: "System: read the diff in revdiff (notes you leave redraft it)",
    help: "diff",
    relevant: (c) => isSystem(c) && !c.hasDraft,
  },
  // Shares e with the task's brief and draft; each declines the other's rows.
  {
    key: "e",
    cmd: Commands.PROJECT_EDIT,
    desc: "edit the project's brief, goals, repos and docs in $EDITOR",
    help: "brief",
    relevant: (c) => c.item === "project",
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
    key: "shift+p",
    cmd: Commands.PR_DASH,
    desc: "its PR in ghdash, on the Canvas (again to close)",
    help: "PR",
    relevant: (c) => c.pr,
  },
  {
    key: "shift+i",
    cmd: Commands.INFO,
    desc: "everything Riker knows about it",
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
  {
    key: "i",
    cmd: Commands.PROJECT_TALK,
    desc: "talk to the project's manager (made on your first line)",
    help: "talk",
    relevant: (c) => c.item === "project",
  },
  {
    key: ".",
    cmd: Commands.ACTIONS,
    desc: "actions: summarize the work, ... (pick one)",
    help: "actions",
    relevant: isWork,
  },
];

// Back has two chords. ctrl+o (vim's jump back) gets through tmux and a
// legacy terminal; ctrl+[ only where the terminal speaks the kitty protocol
// to Riker (elsewhere it is the Esc byte).
export const BACK_CHORD = "ctrl+o";
export const KITTY_BACK_CHORD = "ctrl+[";
export const HOME_CHORD = "ctrl+a";

// The navigation keys and the config field that moves each.
const NAV_DEFAULTS: Required<NavKeys> = {
  goTo: "ctrl+\\",
  back: "[",
  forward: "]",
};
const NAV_COMMANDS: Record<keyof NavKeys, string> = {
  goTo: Commands.GO_TO,
  back: Commands.HISTORY_BACK,
  forward: Commands.HISTORY_FORWARD,
};

const defaultKeymap: KeymapTable<HelpCtx> = {
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
      relevant: (c) => c.kind !== "home",
    },
    {
      key: "n",
      cmd: Commands.WALK_NEXT,
      desc: "next (walk the rail)",
      help: "next",
    },
    { key: "b", cmd: Commands.WALK_BACK, desc: "previous (walk the rail backwards)" },
    {
      key: "/",
      cmd: Commands.SEARCH_OPEN,
      desc: "search the rail: words, RIKER-23, #412, @someone",
      help: "search",
      // The Inbox's and Docs' / search their own lists.
      relevant: (c) => c.board !== BoardTab.inbox && c.board !== BoardTab.docs,
    },
    // The go-to chord works while typing and while attached (see terminal):
    // it is a control key, so it never reaches the box or the agent.
    {
      key: NAV_DEFAULTS.goTo,
      cmd: Commands.GO_TO,
      desc: "go to anything: search the rail from anywhere, recent rows first",
      help: "go to",
    },
    {
      key: NAV_DEFAULTS.back,
      cmd: Commands.HISTORY_BACK,
      desc: "back to where you were (history)",
    },
    {
      key: NAV_DEFAULTS.forward,
      cmd: Commands.HISTORY_FORWARD,
      desc: "forward again (history)",
    },
    // Control chords, bound in a layer of their own that no pane or modal
    // shadows (shell.tsx), and in the terminal's table so they get past an
    // attached agent. ctrl+[ is the Esc byte in a legacy terminal and inside
    // tmux, which folds it into Esc whatever extended-keys says: only a
    // terminal speaking the kitty protocol to Riker sends it apart. There
    // Esc keeps its own meaning (and still reaches the agent). ctrl+o works
    // in both, so it is the one the footer names.
    {
      key: BACK_CHORD,
      cmd: Commands.GO_BACK,
      desc: "back from anywhere: closes the dialog, leaves the box or the agent, then goes back",
      help: "back",
    },
    {
      key: KITTY_BACK_CHORD,
      cmd: Commands.GO_BACK,
      desc: "back from anywhere: closes the dialog, leaves the box or the agent, then goes back",
      relevant: (c) => c.kittyKeys !== false,
    },
    // The chat box loses ctrl+a (start of line); home still does it.
    {
      key: HOME_CHORD,
      cmd: Commands.GO_HOME,
      desc: "Home: the Assistant, from anywhere",
      relevant: (c) => c.kind !== "home",
    },
    { key: "shift+n", cmd: Commands.NEW_TASK, desc: "new task" },
    // Raw mode turns off the terminal's suspend, so ctrl+z reaches Riker. An
    // attached agent still gets it (not in the terminal scope), and the
    // chat box keeps it (quietWhileTyping).
    {
      key: "ctrl+z",
      cmd: Commands.UNDO,
      desc: "undo the last move (yours or the Assistant's)",
      help: "undo",
    },
    {
      key: "ctrl+r",
      cmd: Commands.POLL_NOW,
      desc: "check GitHub and Slack now",
    },
    {
      key: "shift+d",
      cmd: Commands.DOCS_OPEN,
      desc: "edit PERSONA / JOB / LEARNED ...",
    },
    {
      key: "shift+c",
      cmd: Commands.STATUS_OPEN,
      desc: "connections and Advisor status",
    },
  ]),
  rail: [
    ...(listNav as BindingSpec<HelpCtx>[]),
    { key: "return", cmd: Commands.OPEN, desc: "select it" },
    {
      key: "space",
      cmd: Commands.FOLD,
      desc: "fold / unfold the project's tasks",
      help: "fold",
      relevant: (c) => c.item === "project",
    },
    ...railFilters,
    ...taskActions,
  ],
  // The chat box sits inside the Canvas, so all of these are reachable from
  // it, and all decline while it has focus.
  canvas: quietWhileTyping([
    ...(navBindings() as BindingSpec<HelpCtx>[]),
    { key: "escape", cmd: Commands.BACK_TO_RAIL, desc: "back to the rail", help: "rail" },
    ...taskActions,
  ]),
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
  // While an error toast is up, over every pane and modal (its layer
  // exists only then): Esc dismisses the newest and does nothing else. An
  // attached agent still gets Esc; detach first.
  toast: [
    {
      key: "escape",
      cmd: Commands.TOAST_DISMISS,
      desc: "dismiss the error (the newest, one at a time)",
      help: "dismiss",
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
    {
      key: NAV_DEFAULTS.goTo,
      cmd: Commands.GO_TO,
      desc: "detach and go to anything",
      help: "go to",
    },
    // Reserved, so the agent never gets ctrl+t (claude's todo list): it
    // still has it in its own window, where this lands you. Detached, the
    // same jump is shift+t. A terminal with no agent (the editor) is sent
    // the key as typed.
    {
      key: "ctrl+t",
      cmd: Commands.TERMINAL_JUMP,
      desc: "detach and jump your tmux client to the agent's window (prefix L comes back)",
      help: "tmux",
    },
    // Reserved on an agent (a terminal with no agent, the editor, is sent
    // the key as typed): detach, then back or Home as anywhere else. The
    // agent loses ctrl+o (claude's transcript toggle; the owner's call,
    // RIKER-0223), ctrl+[ (Esc still reaches it) and ctrl+a (start of line
    // in claude's prompt, and tmux's prefix where that is C-a). Each back
    // chord has a command of its own here, so a terminal with no agent is
    // sent the byte of the key pressed.
    {
      key: BACK_CHORD,
      cmd: Commands.TERMINAL_BACK,
      desc: "detach and go back",
      help: "back",
    },
    {
      key: KITTY_BACK_CHORD,
      cmd: Commands.TERMINAL_KITTY_BACK,
      desc: "detach and go back",
      relevant: (c) => c.kittyKeys !== false,
    },
    {
      key: HOME_CHORD,
      cmd: Commands.GO_HOME,
      desc: "detach and go to the Assistant",
      help: "home",
    },
    // Reserved, so the rail toggles while attached as it does anywhere (the
    // owner's call, AUG-0176): the agent loses ctrl+e (end of line in
    // claude's prompt; End still works). You stay attached either way. A
    // terminal with no agent (the editor) is sent the key as typed.
    {
      key: "ctrl+e",
      cmd: Commands.SIDEBAR_TOGGLE,
      desc: "show / hide the rail (you stay attached)",
      help: "rail",
    },
  ],
  board: [
    ...(listNav as BindingSpec<HelpCtx>[]),
    { key: "h", cmd: Commands.BOARD_LEFT, desc: "column left", relevant: onColumns },
    { key: "left", cmd: Commands.BOARD_LEFT, desc: "column left", relevant: onColumns },
    { key: "l", cmd: Commands.BOARD_RIGHT, desc: "column right", relevant: onColumns },
    { key: "right", cmd: Commands.BOARD_RIGHT, desc: "column right", relevant: onColumns },
    // The footer folds the six into "1-6 tabs" (BOARD_HELP_OPTIONS).
    { key: "1", cmd: Commands.BOARD_TAB_1, desc: "tab: wins", help: "tabs" },
    { key: "2", cmd: Commands.BOARD_TAB_2, desc: "tab: columns" },
    { key: "3", cmd: Commands.BOARD_TAB_3, desc: "tab: knowledge" },
    { key: "4", cmd: Commands.BOARD_TAB_4, desc: "tab: inbox" },
    { key: "5", cmd: Commands.BOARD_TAB_5, desc: "tab: cost" },
    { key: "6", cmd: Commands.BOARD_TAB_6, desc: "tab: docs" },
    {
      key: "return",
      cmd: Commands.OPEN,
      desc: "open the task in Chat, or jump to the project's session",
      help: "open",
      relevant: (c) => c.item !== null && !onInbox(c) && !onWins(c) && !onDocs(c),
    },
    // Wins: a day's Wins and what else got done, the day before beside it.
    {
      key: "return",
      cmd: Commands.WINS_EXPAND,
      desc: "Wins: show or hide what happened to it that day",
      help: "details",
      relevant: (c) => onWins(c) && c.item !== null,
    },
    {
      key: "t",
      cmd: Commands.WINS_GO,
      desc: "Wins: go to the task",
      help: "go to task",
      relevant: (c) => onWins(c) && c.item !== null,
    },
    { key: "h", cmd: Commands.WINS_PREV_DAY, desc: "Wins: a day earlier", help: "earlier", relevant: onWins },
    { key: "left", cmd: Commands.WINS_PREV_DAY, desc: "Wins: a day earlier", relevant: onWins },
    {
      key: "l",
      cmd: Commands.WINS_NEXT_DAY,
      desc: "Wins: a day later (never past today)",
      help: "later",
      relevant: (c) => onWins(c) && !c.winsToday,
    },
    {
      key: "right",
      cmd: Commands.WINS_NEXT_DAY,
      desc: "Wins: a day later (never past today)",
      relevant: (c) => onWins(c) && !c.winsToday,
    },
    {
      key: "0",
      cmd: Commands.WINS_TODAY,
      desc: "Wins: back to today",
      help: "today",
      relevant: (c) => onWins(c) && !c.winsToday,
    },
    // Docs: every link and doc Riker holds, one row per address.
    {
      key: "return",
      cmd: Commands.DOCUMENTS_EXPAND,
      desc: "Docs: show or hide the address, who attached it and where",
      help: "details",
      relevant: onDoc,
    },
    {
      key: "o",
      cmd: Commands.DOCUMENTS_OPEN_LINK,
      desc: "Docs: open it (a web link in the browser, a file in $EDITOR)",
      help: "open",
      relevant: onDoc,
    },
    {
      key: "t",
      cmd: Commands.DOCUMENTS_GO,
      desc: "Docs: go to the task or project it belongs to",
      help: "go to",
      relevant: (c) => onDoc(c) && Boolean(c.docOwned),
    },
    { key: "y", cmd: Commands.DOCUMENTS_COPY, desc: "Docs: copy the address", help: "copy", relevant: onDoc },
    {
      key: "shift+l",
      cmd: Commands.DOCUMENTS_ATTACH,
      desc: "Docs: attach it to another task",
      help: "attach",
      relevant: onDoc,
    },
    {
      key: "x",
      cmd: Commands.DOCUMENTS_REMOVE,
      desc: "Docs: take it off where it was attached (asks first; nothing outside Riker changes)",
      help: "remove",
      relevant: (c) => onDoc(c) && Boolean(c.docRemovable),
    },
    { key: "f", cmd: Commands.DOCUMENTS_KIND, desc: "Docs: next kind (PR, issue, doc, thread, file, other)", help: "kind", relevant: onDocs },
    { key: "p", cmd: Commands.DOCUMENTS_PROJECT, desc: "Docs: next project", help: "project", relevant: onDocs },
    { key: "shift+p", cmd: Commands.DOCUMENTS_GROUP, desc: "Docs: group by project, or one list", help: "group", relevant: onDocs },
    { key: "/", cmd: Commands.DOCUMENTS_SEARCH, desc: "Docs: search title, address, kind, task and project", help: "search", relevant: onDocs },
    // The Inbox: every message triage saw and every Advisor idea.
    {
      key: "return",
      cmd: Commands.INBOX_EXPAND,
      desc: "Inbox: show or hide how triage routed it",
      help: "chain",
      relevant: (c) => onInbox(c) && c.item !== null,
    },
    { key: "f", cmd: Commands.INBOX_FILTER, desc: "Inbox: next filter", help: "filter", relevant: onInbox },
    { key: "/", cmd: Commands.INBOX_SEARCH, desc: "Inbox: search subject, sender and source", help: "search", relevant: onInbox },
    {
      key: "t",
      cmd: Commands.INBOX_GO,
      desc: "Inbox: go to the task it made or joined (an open idea: the task it is about)",
      help: "go to task",
      relevant: (c) => onInbox(c) && Boolean(c.inboxTask),
    },
    {
      key: "m",
      cmd: Commands.MAKE_TASK,
      desc: "Inbox: make it a task (an idea: approve it)",
      help: "make task",
      relevant: (c) =>
        onInbox(c) &&
        ((c.item === "idea" && !c.handled) || (inboxMessage(c) && !c.inboxTask)),
    },
    {
      key: "x",
      cmd: Commands.DISMISS_IDEA,
      desc: "Inbox: dismiss the Advisor idea",
      help: "dismiss",
      relevant: (c) => onInbox(c) && c.item === "idea" && !c.handled,
    },
    // x on any message clears it off "actionable" and changes nothing else:
    // the task it made or joined stays. Undoing that task is X, and only on
    // the message that made it, never one that joined someone else's.
    {
      key: "x",
      cmd: Commands.INBOX_READ,
      desc: "Inbox: dismiss it (marked read, it leaves actionable; its task stays)",
      help: "dismiss",
      relevant: (c) => inboxMessage(c) && !c.inboxRead,
    },
    {
      key: "shift+x",
      cmd: Commands.IGNORE,
      desc: "Inbox: ignore (drops the task it made; ctrl+z undoes)",
      help: "ignore",
      relevant: (c) => onInbox(c) && c.item === "message" && Boolean(c.inboxMade),
    },
    {
      key: "o",
      cmd: Commands.OPEN_URL,
      desc: "Inbox: open the message's link",
      help: "open link",
      relevant: inboxMessage,
    },
    {
      key: "shift+f",
      cmd: Commands.INBOX_NOISE,
      desc: "Inbox: create noise filter (triage files its like as FYI)",
      help: "noise filter",
      relevant: (c) => inboxMessage(c) && !c.inboxTask,
    },
    {
      key: "shift+u",
      cmd: Commands.INBOX_RETRIAGE,
      desc: "Inbox: re-run triage on it",
      help: "re-triage",
      relevant: (c) => inboxMessage(c) && !c.inboxTask,
    },
    {
      key: "shift+b",
      cmd: Commands.INBOX_BODY,
      desc: "Inbox: show the whole message, or cap it again",
      help: "body",
      relevant: inboxMessage,
    },
    {
      key: "c",
      cmd: Commands.BOARD_COMPOSE_KNOWLEDGE,
      desc: "write a knowledge entry",
      help: "write",
      relevant: (c) => c.board === BoardTab.knowledge,
    },
    // Strays are agents too: the agents' view adopts them.
    {
      key: "shift+a",
      cmd: Commands.PROJECT_ADOPT,
      desc: "adopt a tmux session or a stray claude as a project",
      help: "adopt",
      relevant: onColumns,
    },
    {
      key: "s",
      cmd: Commands.START,
      desc: "start / continue the agent",
      help: "start",
      relevant: (c) =>
        !c.live && (isWork(c) || (onInbox(c) && Boolean(c.inboxWork))),
    },
    { key: "shift+s", cmd: Commands.STOP, desc: "stop the agent and save", help: "stop", relevant: (c) => c.live },
    {
      key: "shift+t",
      cmd: Commands.JUMP,
      desc: "jump your tmux client to the agent's or project's window",
      help: "jump",
      relevant: (c) => c.coding || c.item === "project",
    },
    { key: "u", cmd: Commands.NUDGE, desc: "nudge the agent about new feedback", relevant: (c) => c.coding },
    { key: "d", cmd: Commands.DONE, desc: "mark done", help: "done", relevant: (c) => isWork(c) && !c.closed },
    {
      key: "d",
      cmd: Commands.REOPEN,
      desc: "reopen (done or dropped; its agent does not start)",
      help: "reopen",
      relevant: (c) => isWork(c) && Boolean(c.closed),
    },
    {
      key: ".",
      cmd: Commands.ACTIONS,
      desc: "actions: summarize the work, ... (pick one)",
      help: "actions",
      relevant: isWork,
    },
    {
      key: "shift+m",
      cmd: Commands.MOVE_TO_PROJECT,
      desc: "move the task to a project",
      relevant: (c) => isTask(c) || (onInbox(c) && Boolean(c.inboxWork)),
    },
    { key: "shift+p", cmd: Commands.PR_DASH, desc: "its PR in ghdash (in Chat)", help: "PR", relevant: (c) => c.pr && !onDocs(c) },
    { key: "shift+r", cmd: Commands.REPOS, desc: "repos: where each is checked out, and checkouts to add" },
  ],
};

// The binding table with config's navigation keys in place of the defaults, in every
// scope that binds them (the go-to chord is in the terminal's too, which is
// what lets it past an attached agent), and a key per task action that asks
// for one (config.json `actions.<name>.key`), on the rail and the Canvas.
export function buildKeymap(
  keys: NavKeys = {},
  actions: ActionKey[] = [],
): KeymapTable<HelpCtx> {
  const nav = withNavKeys(keys);
  const { bound } = actionKeys(actions, nav);
  if (bound.length === 0) return nav;
  const specs: BindingSpec<HelpCtx>[] = bound.map((a) => ({
    key: a.key,
    cmd: actionCommand(a.name),
    desc: `action: ${a.title}`,
    // In the footer too, on the rows it is offered on (a review that just
    // arrived offers its guide).
    help: a.name,
    relevant: (c: HelpCtx) => isWork(c) && (c.actions?.includes(a.name) ?? true),
  }));
  return {
    ...nav,
    rail: [...(nav.rail ?? []), ...specs],
    canvas: [...(nav.canvas ?? []), ...quietWhileTyping(specs)],
  };
}

function withNavKeys(keys: NavKeys): KeymapTable<HelpCtx> {
  const byCmd = new Map<string, string>();
  for (const [field, cmd] of Object.entries(NAV_COMMANDS) as [keyof NavKeys, string][]) {
    const key = keys[field];
    if (key && key !== NAV_DEFAULTS[field]) byCmd.set(cmd, key);
  }
  if (byCmd.size === 0) return defaultKeymap;
  return Object.fromEntries(
    Object.entries(defaultKeymap).map(([scope, specs]) => [
      scope,
      specs.map((spec) => {
        const key = byCmd.get(spec.cmd);
        return key ? { ...spec, key } : spec;
      }),
    ]),
  );
}

// A task action's own key: what config asks for, by the action's name.
export interface ActionKey {
  name: string;
  key: string;
  title: string;
}

export const actionCommand = (name: string) => `${Commands.ACTIONS}.${name}`;

// The scopes an action key lands in, and the app scope above them both.
const ACTION_KEY_SCOPES = ["app", "rail", "canvas"];

// Which asked-for keys are bound. A key Riker already uses where the rows are
// (on the rail, the Canvas or app-wide), or one an earlier action took, is
// refused rather than shadowing a move: the action stays in the . picker.
export function actionKeys(
  actions: ActionKey[],
  table: KeymapTable<HelpCtx> = defaultKeymap,
): { bound: ActionKey[]; refused: { name: string; key: string; why: string }[] } {
  const owner = new Map<string, string>();
  for (const scope of ACTION_KEY_SCOPES)
    for (const spec of table[scope] ?? [])
      if (!owner.has(spec.key)) owner.set(spec.key, spec.desc);
  const bound: ActionKey[] = [];
  const refused: { name: string; key: string; why: string }[] = [];
  for (const a of actions) {
    const taken = owner.get(a.key);
    if (taken) {
      refused.push({ name: a.name, key: a.key, why: `${a.key} is taken (${taken})` });
      continue;
    }
    owner.set(a.key, `action: ${a.title}`);
    bound.push(a);
  }
  return { bound, refused };
}

export const keymap = defaultKeymap;

// Footer folding for the Board's tab digits.
export const BOARD_HELP_OPTIONS = {
  combinedKeys: { [Commands.BOARD_TAB_1]: "1-6" },
};
