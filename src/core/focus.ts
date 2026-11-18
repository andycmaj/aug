// Leaving the table (detach, escape, a go-to jump) lands on the rail. A
// hidden rail isn't mounted, and opentui-app's focusPane then waits for a
// mount that never comes while the old focus is destroyed: nothing holds
// focus, and every binding (quit included) is focus-within. So show it first;
// showing it focuses it once it mounts.
export type RailFocus = {
  panes: string[];
  sidebarVisible: () => boolean;
  toggleSidebar: () => void;
  setActivePane: (pane: string) => void;
};

export function toRail(focus: RailFocus): void {
  if (focus.sidebarVisible()) focus.setActivePane(focus.panes[0]!);
  else focus.toggleSidebar();
}

// The focused pane can unmount under the owner too (the chat box, when a
// go-to lands on a project). With no modal open and no pane holding focus,
// fall back to the rail.
export type FocusGuard = RailFocus & {
  activePaneTarget: () => unknown;
  isModalOpen: () => boolean;
};

export function focusLost(focus: FocusGuard): boolean {
  return !focus.isModalOpen() && !focus.activePaneTarget();
}
