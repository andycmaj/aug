// Text selected with the mouse. opentui's text has no selection colors by
// default and draws a selection by swapping the cell's own colors, so on a
// lit row (the cursor's dark text on its band) the selection came out dark
// on dark. Every <text> gets the theme's selection band instead, so what you
// select reads the same wherever it is.

import {
  TextRenderable,
  type RenderContext,
  type TextOptions,
} from "@opentui/core";
import { extend } from "@opentui/solid";
import {
  contrastingForeground,
  useTheme,
  type ThemeColor,
} from "@andycmaj/opentui-app";

let selection: { bg?: string; fg?: ThemeColor } = {};

class SelectionText extends TextRenderable {
  constructor(ctx: RenderContext, options: TextOptions) {
    super(ctx, {
      ...options,
      selectionBg: options.selectionBg ?? selection.bg,
      selectionFg: options.selectionFg ?? selection.fg,
    });
  }
}

extend({ text: SelectionText });

// Before anything with text renders: a <text> reads them as it is made.
export function SelectionColors() {
  const theme = useTheme();
  selection = {
    bg: theme.selectionBg,
    fg: theme.selectionFg ?? contrastingForeground(theme.selectionBg),
  };
  return null;
}
