import { expect, test } from "bun:test";
import {
  filterRelevant,
  getHelpItems,
  getScopeBindings,
} from "@andycmaj/opentui-app";
import { Commands } from "../src/commands";
import { RAIL_FILTERS } from "../src/core/rail";
import {
  BoardTab,
  buildKeymap,
  helpBindings,
  keymap,
  type HelpCtx,
} from "../src/keymap";

const ITEMS: HelpCtx["item"][] = ["task", "message", "fyi", "idea", "project", null];
const KINDS = ["home", "system", "coding", "task", "chat", null];
const FLAGS = [
  "hasDraft",
  "live",
  "coding",
  "watching",
  "started",
  "pr",
] as const;

function* contexts(): Generator<HelpCtx> {
  for (const item of ITEMS)
    for (const kind of item === "task" ? KINDS : [null])
      // Only a task carries drafts, agents and the rest (see chat-mode's ctx).
      for (
        let bits = 0;
        bits < (item === "task" ? 1 << FLAGS.length : 1);
        bits++
      )
        for (const board of [undefined, ...Object.values(BoardTab)])
        for (const inbox of [0, 1, 2, 3]) {
          const ctx: HelpCtx = {
            item,
            kind,
            hasDraft: false,
            live: false,
            coding: false,
            watching: false,
            started: false,
            pr: false,
            board,
            inboxTask: (inbox & 1) !== 0,
            handled: (inbox & 2) !== 0,
          };
          FLAGS.forEach((flag, i) => {
            ctx[flag] = (bits & (1 << i)) !== 0;
          });
          yield ctx;
        }
}

// What a pane's footer would show for this item: its own keys, then the app's.
function footer(scope: string, ctx: HelpCtx): Map<string, string> {
  const bindings = [
    ...getScopeBindings(keymap, scope),
    ...getScopeBindings(keymap, "app"),
  ];
  // Already filtered: drop the predicate getHelpItems has no ctx for.
  const relevant = filterRelevant(bindings, ctx).map((b) => ({
    ...b,
    relevant: undefined,
  }));
  const items = getHelpItems(relevant);
  return new Map(items.map((item) => [item.keys, item.text]));
}

// A key that means two things at once is a key whose footer lies about one.
test("in each pane, a key means one thing for any item", () => {
  const clashes = new Set<string>();
  for (const scope of ["rail", "task", "board"])
    for (const ctx of contexts()) {
      const bindings = filterRelevant(
        [
          ...getScopeBindings(keymap, scope),
          ...getScopeBindings(keymap, "app"),
        ],
        ctx,
      );
      const byKey = new Map<string, Set<string>>();
      for (const b of bindings)
        byKey.set(b.keys, (byKey.get(b.keys) ?? new Set()).add(b.cmd));
      for (const [key, cmds] of byKey)
        if (cmds.size > 1)
          clashes.add(
            `${scope} ${ctx.item}/${ctx.kind}: ${key} = ${[...cmds].join(", ")}`,
          );
    }
  expect([...clashes]).toEqual([]);
});

// The table's own hint words say the same thing as the footer.
test("the footer names what x and m do to the row on the table", () => {
  const base: HelpCtx = {
    item: null,
    kind: null,
    hasDraft: false,
    live: false,
    coding: false,
    watching: false,
    started: false,
    pr: false,
  };
  const words = (item: HelpCtx["item"], kind: string | null = null) => {
    const f = footer("rail", { ...base, item, kind });
    return { x: f.get("x"), m: f.get("m") };
  };
  expect(words("task", "task")).toEqual({ x: "not a task", m: undefined });
  expect(words("project")).toEqual({ x: "archive", m: undefined });
  expect(words("task", "home").x).toBeUndefined();
});

test("the footer offers ghdash only on a task with a PR", () => {
  const ctx: HelpCtx = {
    item: "task",
    kind: "coding",
    hasDraft: false,
    live: false,
    coding: true,
    watching: false,
    started: true,
    pr: false,
  };
  expect(footer("rail", ctx).get("P")).toBeUndefined();
  expect(footer("rail", { ...ctx, pr: true }).get("P")).toBe("PR");
});

test("each rail filter pill has its digit", () => {
  const digits = getScopeBindings(keymap, "rail").filter((b) =>
    /^[1-9]$/.test(b.keys),
  );
  expect(digits.length).toBe(RAIL_FILTERS.length);
  expect(new Set(digits.map((b) => b.cmd)).size).toBe(RAIL_FILTERS.length);
});

const keyFor = (table: typeof keymap, scope: string, cmd: string) =>
  (table[scope] ?? []).filter((b) => b.cmd === cmd).map((b) => b.key);

// The go-to chord must be in the terminal's own table: that is what lets it
// past an attached agent (useKeyPassthrough lets a scope's keys through).
test("the go-to chord works anywhere, an attached terminal too", () => {
  expect(keyFor(keymap, "app", Commands.GO_TO)).toEqual(["ctrl+\\"]);
  expect(keyFor(keymap, "terminal", Commands.GO_TO)).toEqual(["ctrl+\\"]);
});

test("config moves the navigation keys in every scope that binds them", () => {
  const table = buildKeymap({ goTo: "ctrl+o", back: "alt+left" });
  expect(keyFor(table, "app", Commands.GO_TO)).toEqual(["ctrl+o"]);
  expect(keyFor(table, "terminal", Commands.GO_TO)).toEqual(["ctrl+o"]);
  expect(keyFor(table, "app", Commands.HISTORY_BACK)).toEqual(["alt+left"]);
  expect(keyFor(table, "app", Commands.HISTORY_FORWARD)).toEqual(["]"]);
  expect(buildKeymap({})).toBe(keymap);
});

const quiet: HelpCtx = {
  item: "task",
  kind: "coding",
  hasDraft: false,
  live: true,
  coding: true,
  watching: false,
  started: true,
  pr: true,
};

// What the footer and ? help list from a pane: its layers innermost first,
// as the keymap reports them.
function shown(scopes: string[], ctx: HelpCtx): Map<string, string> {
  const reachable = scopes.flatMap((scope) => getScopeBindings(keymap, scope));
  return new Map(helpBindings(reachable, ctx).map((b) => [b.keys, b.cmd]));
}

test("attached to a terminal, only its own keys are listed", () => {
  const keys = shown(["terminal", "task", "app"], { ...quiet, attached: true });
  // Detach and the go-to chord: the two keys an attached terminal lets past.
  expect([...keys.values()].sort()).toEqual(
    [Commands.GO_TO, Commands.TERMINAL_DETACH].sort(),
  );
});

test("typing in the chat box lists the box's keys, not the table's", () => {
  const keys = shown(["input", "task", "app"], { ...quiet, typing: true });
  expect(keys.get("escape")).toBe(Commands.INPUT_LEAVE);
  for (const k of ["j", "s", "d", "?", "q", "v"])
    expect(keys.has(k)).toBe(false);
  // These still act while typing.
  expect(keys.has("Tab")).toBe(true);
  expect(keys.has("^r")).toBe(true);
});

test("a key's relevant binding wins over one that declines this row", () => {
  const work: HelpCtx = { ...quiet, item: "task", kind: "task", coding: false };
  expect(shown(["rail", "app"], work).get("x")).toBe(Commands.NOT_TASK);
  const project: HelpCtx = { ...work, item: "project", kind: null };
  expect(shown(["rail", "app"], project).get("x")).toBe(
    Commands.PROJECT_ARCHIVE,
  );
});

test("the Board lists each tab's own keys", () => {
  const board = (tab: HelpCtx["board"], item: HelpCtx["item"] = null) =>
    shown(["board", "app"], {
      ...quiet,
      item,
      kind: null,
      coding: false,
      live: false,
      pr: false,
      board: tab,
    });
  expect(board(BoardTab.notes).get("c")).toBe(Commands.BOARD_COMPOSE);
  expect(board(BoardTab.knowledge).get("c")).toBe(
    Commands.BOARD_COMPOSE_KNOWLEDGE,
  );
  expect(board(BoardTab.projects).get("c")).toBe(Commands.PROJECT_NEW);
  expect(board(BoardTab.notes).has("x")).toBe(false);
  expect(board(BoardTab.notes).has("h")).toBe(false);
  expect(board(BoardTab.columns).has("h")).toBe(true);
  expect(board(BoardTab.projects, "project").get("x")).toBe(
    Commands.PROJECT_ARCHIVE,
  );
  expect(board(BoardTab.columns, null).has("Enter")).toBe(false);
});

test("Home's row does not offer the key that goes Home", () => {
  const home: HelpCtx = { ...quiet, kind: "home", coding: false, live: false };
  expect(shown(["rail", "app"], home).has("a")).toBe(false);
  expect(shown(["rail", "app"], { ...home, kind: "task" }).get("a")).toBe(
    Commands.ASK_OPEN,
  );
});

test("the Inbox's keys say what they do to each row", () => {
  const inbox = (item: HelpCtx["item"], extra: Partial<HelpCtx> = {}) =>
    footer("board", {
      ...base(),
      item,
      board: BoardTab.inbox,
      ...extra,
    });
  const idea = inbox("idea");
  expect([idea.get("x"), idea.get("m"), idea.get("Enter")]).toEqual(["dismiss", "make task", "chain"]);
  expect(inbox("idea", { handled: true }).has("x")).toBe(false);
  const fyi = inbox("fyi");
  expect([fyi.get("x"), fyi.get("m"), fyi.get("F"), fyi.get("U")]).toEqual([
    "read",
    "make task",
    "noise filter",
    "re-triage",
  ]);
  const made = inbox("message", { inboxTask: true });
  expect([made.get("x"), made.get("t"), made.get("s"), made.get("m"), made.get("U")]).toEqual([
    "not a task",
    "go to task",
    "start",
    undefined,
    undefined,
  ]);
  expect(inbox(null).get("/")).toBe("search");
  expect(inbox(null).get("f")).toBe("filter");
  // Off the Inbox, / is the rail search and Enter opens.
  expect(footer("board", { ...base(), item: "task", kind: "task", board: BoardTab.columns }).get("Enter")).toBe("open");
});

function base(): HelpCtx {
  return {
    item: null,
    kind: null,
    hasDraft: false,
    live: false,
    coding: false,
    watching: false,
    started: false,
    pr: false,
  };
}
