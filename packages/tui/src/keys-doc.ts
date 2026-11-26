// The data behind docs/keyboard.html: what the footer and ? help would list
// in each place (the same `helpBindings` over the same table), and every
// binding by scope. `bun run docs:keys` writes it into the page, and
// keys-doc.test.ts fails while the page lags the keymap.

import {
  getScopeBindings,
  ModalCommands,
  type HelpBinding,
} from "@andycmaj/opentui-app";
import { Commands } from "./commands";
import {
  BoardTab,
  helpBindings,
  keymap,
  SCOPE_LABELS,
  type HelpCtx,
} from "./keymap";

export interface KeyRow {
  keys: string;
  desc: string;
  cmd: string;
}

export interface KeyPlace {
  id: string;
  title: string;
  where: string;
  rows: KeyRow[];
}

export interface KeyScope {
  scope: string;
  title: string;
  rows: (KeyRow & { sometimes: boolean })[];
}

export interface KeysDoc {
  places: KeyPlace[];
  scopes: KeyScope[];
}

const task: HelpCtx = {
  item: "task",
  kind: "task",
  hasDraft: false,
  live: false,
  coding: false,
  watching: false,
  started: true,
  pr: false,
};
const coding: HelpCtx = {
  ...task,
  kind: "coding",
  coding: true,
  live: true,
  pr: true,
};
const quiet: HelpCtx = { ...task, item: null, kind: null, started: false };

// One place per thing the owner can be looking at, with the panes whose
// keys reach it, innermost first, as the app layers them.
const PLACES: {
  id: string;
  title: string;
  where: string;
  scopes: string[];
  ctx: HelpCtx;
}[] = [
  {
    id: "rail-task",
    title: "Rail · a task with a draft",
    where:
      "Chat, the rail's cursor on a chat task whose reply waits for your y",
    scopes: ["rail", "app"],
    ctx: { ...task, hasDraft: true },
  },
  {
    id: "rail-coding",
    title: "Rail · a coding task",
    where:
      "Chat, the rail's cursor on a coding task with a live agent and a PR",
    scopes: ["rail", "app"],
    ctx: coding,
  },
  {
    id: "rail-project",
    title: "Rail · a project",
    where: "Chat, the rail's cursor on a project heading",
    scopes: ["rail", "app"],
    ctx: { ...quiet, item: "project" },
  },
  {
    id: "home",
    title: "Home",
    where: "Chat, Home selected (the Assistant), focus on the Canvas",
    scopes: ["canvas", "app"],
    ctx: { ...task, kind: "home" },
  },
  {
    id: "canvas-coding",
    title: "Canvas · a coding task",
    where: "Chat, a stopped coding task selected, focus on the Canvas",
    scopes: ["canvas", "app"],
    ctx: { ...coding, live: false },
  },
  {
    id: "typing",
    title: "The chat box",
    where: "Typing in the box under a task",
    scopes: ["input", "canvas", "app"],
    ctx: { ...task, typing: true },
  },
  {
    id: "attached",
    title: "Attached to an agent",
    where:
      "The Canvas shows a live agent and has focus: every other key goes to the agent",
    scopes: ["terminal", "canvas", "app"],
    ctx: { ...coding, attached: true },
  },
  {
    id: "board-wins",
    title: "Board · Wins",
    where: "Board, tab 1, on a won task",
    scopes: ["board", "app"],
    ctx: { ...task, board: BoardTab.wins, winsToday: true, closed: true },
  },
  {
    id: "board-columns",
    title: "Board · Columns",
    where: "Board, tab 2, on a task",
    scopes: ["board", "app"],
    ctx: { ...task, board: BoardTab.columns },
  },
  {
    id: "board-inbox",
    title: "Board · Inbox",
    where: "Board, tab 4, on a message triage held",
    scopes: ["board", "app"],
    ctx: { ...quiet, item: "message", board: BoardTab.inbox },
  },
  {
    id: "board-docs",
    title: "Board · Docs",
    where: "Board, tab 6, on a link someone attached",
    scopes: ["board", "app"],
    ctx: {
      ...quiet,
      item: "doc",
      board: BoardTab.docs,
      docOwned: true,
      docRemovable: true,
    },
  },
  {
    id: "board-cost",
    title: "Board · Cost",
    where: "Board, tab 5",
    scopes: ["board", "app"],
    ctx: { ...quiet, board: BoardTab.cost },
  },
];

// The footer's word for Esc.
const label = (keys: string) => (keys === "escape" ? "esc" : keys);

// One row per command, its keys in binding order (j / down), as ? help
// merges them; commands that read the same (the rail's nine filter digits)
// share a row.
function rows(bindings: HelpBinding<HelpCtx>[]): KeyRow[] {
  const byDesc = new Map<string, KeyRow>();
  for (const b of bindings) {
    const row = byDesc.get(b.desc);
    if (row) {
      row.keys += ` / ${label(b.keys)}`;
    } else {
      byDesc.set(b.desc, { keys: label(b.keys), desc: b.desc, cmd: b.cmd });
    }
  }
  return [...byDesc.values()];
}

export function keysDoc(): KeysDoc {
  const places = PLACES.map((p) => {
    const reachable = p.scopes.flatMap((s) => getScopeBindings(keymap, s));
    // kittyKeys: the page shows ctrl+[ and says where it is only Esc.
    return {
      id: p.id,
      title: p.title,
      where: p.where,
      rows: rows(helpBindings(reachable, { ...p.ctx, kittyKeys: true })),
    };
  });
  // A dialog (help, the palette, go to, a confirm) holds focus in a layer of
  // its own: its own keys, Esc to close, and the two chords that reach past
  // every layer (shell.tsx).
  const anywhere = getScopeBindings(keymap, "app").filter(
    (b) => b.cmd === Commands.GO_BACK || b.cmd === Commands.GO_HOME,
  );
  places.push({
    id: "dialog",
    title: "A dialog",
    where: "Help, the palette, go to, a confirm: its own keys are listed in it",
    rows: [
      { keys: "esc", desc: "close", cmd: ModalCommands.MODAL_CLOSE },
      ...rows(anywhere),
    ],
  });
  const scopes = Object.keys(keymap).map((scope) => {
    const bindings = getScopeBindings(keymap, scope);
    return {
      scope,
      title: SCOPE_LABELS[scope] ?? scope,
      rows: rows(bindings).map((r) => ({
        ...r,
        sometimes: bindings.some(
          (b) => b.desc === r.desc && b.relevant !== undefined,
        ),
      })),
    };
  });
  return { places, scopes };
}

const OPEN = '<script type="application/json" id="keys-data">';
const CLOSE = "</script>";

// The page with its data block replaced. `<` is escaped so a key like
// `shift+<` can never close the script early.
export function withKeysData(html: string, doc: KeysDoc = keysDoc()): string {
  const start = html.indexOf(OPEN);
  const end = html.indexOf(CLOSE, start);
  if (start < 0 || end < 0) {
    throw new Error("keyboard.html has no keys-data block");
  }
  const json = JSON.stringify(doc).replaceAll("<", "\\u003c");
  return html.slice(0, start + OPEN.length) + json + html.slice(end);
}
