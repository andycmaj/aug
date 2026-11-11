import { expect, test } from "bun:test";
import { focusNext, type PaneCycle } from "../src/core/focus";

// Mirrors opentui-app's FocusProvider: cyclePane moves to the next pane in
// order whether or not it mounted, and showing the hidden sidebar mounts it.
function fakeFocus(panes: string[], mounted: string[], active: string) {
  const state = { active, sidebar: true };
  const focus: PaneCycle = {
    panes,
    cyclePane() {
      const next = panes[(panes.indexOf(state.active) + 1) % panes.length]!;
      if (next === panes[0]) state.sidebar = true;
      state.active = next;
    },
    activePaneTarget: () =>
      mounted.includes(state.active) &&
      (state.active !== panes[0] || state.sidebar)
        ? {}
        : undefined,
    isPaneFocused: (pane) => state.active === pane,
  };
  return { focus, state };
}

const PANES = ["rail", "task", "input"];

test("tab on a pane with no chat input goes back to the rail", () => {
  const { focus, state } = fakeFocus(PANES, ["rail", "task"], "task");
  focusNext(focus);
  expect(state.active).toBe("rail");
});

test("tab still reaches the chat input when it is there", () => {
  const { focus, state } = fakeFocus(PANES, ["rail", "task", "input"], "task");
  focusNext(focus);
  expect(state.active).toBe("input");
  focusNext(focus);
  expect(state.active).toBe("rail");
});

test("tab to a hidden rail shows it rather than skipping it", () => {
  const { focus, state } = fakeFocus(PANES, ["task"], "task");
  state.sidebar = false;
  focusNext(focus);
  expect(state.active).toBe("rail");
  expect(state.sidebar).toBe(true);
});

test("a single pane stays put", () => {
  const { focus, state } = fakeFocus(["board"], ["board"], "board");
  focusNext(focus);
  expect(state.active).toBe("board");
});
