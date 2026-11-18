import { expect, test } from "bun:test";
import { focusLost, toRail, type FocusGuard } from "../src/core/focus";

const PANES = ["rail", "task", "input"];

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
