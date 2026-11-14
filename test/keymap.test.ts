import { expect, test } from "bun:test";
import {
  filterRelevant,
  getHelpItems,
  getScopeBindings,
} from "@andycmaj/opentui-app";
import { RAIL_FILTERS } from "../src/core/rail";
import { keymap, type HelpCtx } from "../src/keymap";

const ITEMS: HelpCtx["item"][] = ["task", "fyi", "idea", "project", null];
const KINDS = ["home", "system", "coding", "task", "chat", null];
const FLAGS = ["hasDraft", "live", "coding", "watching", "started", "pr"] as const;

function* contexts(): Generator<HelpCtx> {
  for (const item of ITEMS)
    for (const kind of item === "task" ? KINDS : [null])
      // Only a task carries drafts, agents and the rest (see chat-mode's ctx).
      for (let bits = 0; bits < (item === "task" ? 1 << FLAGS.length : 1); bits++) {
        const ctx: HelpCtx = {
          item,
          kind,
          hasDraft: false,
          live: false,
          coding: false,
          watching: false,
          started: false,
          pr: false,
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
          clashes.add(`${scope} ${ctx.item}/${ctx.kind}: ${key} = ${[...cmds].join(", ")}`);
    }
  expect([...clashes]).toEqual([]);
});

// The table's own hint words for FYIs and Advisor ideas say the same thing.
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
  expect(words("fyi")).toEqual({ x: "read", m: "make task" });
  expect(words("idea")).toEqual({ x: "dismiss", m: "make task" });
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
  const digits = getScopeBindings(keymap, "rail").filter((b) => /^[1-9]$/.test(b.keys));
  expect(digits.length).toBe(RAIL_FILTERS.length);
  expect(new Set(digits.map((b) => b.cmd)).size).toBe(RAIL_FILTERS.length);
});
