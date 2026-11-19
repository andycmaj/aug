// The command palette's entries: the same bindings the footer and the ?
// help show (`helpBindings`), one entry per command, plus the few moves that
// have no key. So the palette never lists what the footer would not, and a
// new key shows up in it without a second list to keep.

import type { HelpBinding } from "@andycmaj/opentui-app";
import { Commands } from "./commands";
import { FILTER_COMMANDS, type HelpCtx } from "./keymap";

// Moving around is what the keys are for; the palette lists things to do.
const SKIP = new Set<string>([
  Commands.PALETTE_OPEN,
  Commands.FOCUS_NEXT,
  Commands.NAV_DOWN,
  Commands.NAV_UP,
  Commands.NAV_TOP,
  Commands.NAV_BOTTOM,
  Commands.SCROLL_PAGEUP,
  Commands.SCROLL_PAGEDOWN,
  Commands.BOARD_LEFT,
  Commands.BOARD_RIGHT,
  ...FILTER_COMMANDS,
]);

export const PaletteGroup = {
  row: "This row",
  pane: "This pane",
  anywhere: "Anywhere",
} as const;

export interface PaletteEntry {
  id: string;
  label: string;
  hint?: string;
  group: string;
  // Applies to the focused pane or the row under it, not just anywhere:
  // what the palette's context mode lists.
  inContext: boolean;
  // A key's command, run through the keymap; an extra runs itself.
  cmd?: string;
  run?: () => void;
}

// A move with no key: listed in All, under its own group.
export interface PaletteExtra {
  id: string;
  label: string;
  hint?: string;
  group: string;
  relevant?: (ctx: HelpCtx) => boolean;
  run: () => void;
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// A binding about the row says so by declining when there is none.
function aboutRow(b: HelpBinding<HelpCtx>, ctx: HelpCtx): boolean {
  return b.relevant !== undefined && !b.relevant({ ...ctx, item: null });
}

// `bindings` are what applies here, in dispatch order (`helpBindings`), keys
// already worded for a hint line.
export function paletteEntries(
  bindings: HelpBinding<HelpCtx>[],
  ctx: HelpCtx,
  extras: PaletteExtra[] = [],
): PaletteEntry[] {
  const byCmd = new Map<string, PaletteEntry>();
  for (const b of bindings) {
    if (SKIP.has(b.cmd)) continue;
    const seen = byCmd.get(b.cmd);
    if (seen) {
      seen.hint = `${seen.hint}/${b.keys}`;
      continue;
    }
    const app = b.scope === "app";
    byCmd.set(b.cmd, {
      id: b.cmd,
      label: capitalize(b.desc),
      hint: b.keys,
      group: app
        ? PaletteGroup.anywhere
        : aboutRow(b, ctx)
          ? PaletteGroup.row
          : PaletteGroup.pane,
      inContext: !app,
      cmd: b.cmd,
    });
  }
  const order = [PaletteGroup.row, PaletteGroup.pane, PaletteGroup.anywhere];
  const keyed = [...byCmd.values()].sort(
    (a, b) =>
      order.indexOf(a.group as (typeof order)[number]) -
      order.indexOf(b.group as (typeof order)[number]),
  );
  const loose = extras
    .filter((e) => e.relevant?.(ctx) ?? true)
    .map(
      (e): PaletteEntry => ({
        id: e.id,
        label: e.label,
        hint: e.hint,
        group: e.group,
        inContext: false,
        run: e.run,
      }),
    );
  return [...keyed, ...loose];
}
