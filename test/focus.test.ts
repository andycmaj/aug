import { expect, test } from "bun:test";
import {
  focusLost,
  focusNext,
  toRail,
  type FocusGuard,
  type PaneCycle,
} from "../src/core/focus";

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

// Mirrors opentui-app's focusPane and toggleSidebar: asking for an unmounted
// pane only records it, and showing the sidebar focuses it once it mounts.
function fakeGuard(sidebar: boolean, active: string) {
  const state = { active, sidebar, modal: false };
  const mounted = () => (state.sidebar ? ["rail", "task"] : ["task"]);
  const focus: FocusGuard = {
    panes: PANES,
    sidebarVisible: () => state.sidebar,
    toggleSidebar() {
      state.sidebar = !state.sidebar;
      state.active = state.sidebar ? "rail" : "task";
    },
    setActivePane(pane) {
      state.active = pane;
    },
    activePaneTarget: () => (mounted().includes(state.active) ? {} : undefined),
    isModalOpen: () => state.modal,
  };
  return { focus, state };
}

test("leaving the table for a hidden rail shows it", () => {
  const { focus, state } = fakeGuard(false, "task");
  toRail(focus);
  expect(state).toMatchObject({ active: "rail", sidebar: true });
  expect(focusLost(focus)).toBe(false);
});

test("leaving the table for a shown rail focuses it", () => {
  const { focus, state } = fakeGuard(true, "task");
  toRail(focus);
  expect(state).toMatchObject({ active: "rail", sidebar: true });
});

test("focus on a pane that is not mounted is lost, unless a modal holds it", () => {
  const { focus, state } = fakeGuard(true, "input");
  expect(focusLost(focus)).toBe(true);
  state.modal = true;
  expect(focusLost(focus)).toBe(false);
});
