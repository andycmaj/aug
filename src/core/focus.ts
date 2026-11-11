// opentui-app's cyclePane walks the pane list blindly, so tab onto a pane that
// isn't mounted (the chat input, on anything but a task) parks focus nowhere.
// The first pane is the sidebar: cycling to it shows it, and it mounts after.

export type PaneCycle = {
  panes: string[];
  cyclePane: () => void;
  activePaneTarget: () => unknown;
  isPaneFocused: (pane: string) => boolean;
};

export function focusNext(focus: PaneCycle): void {
  for (let i = 0; i < focus.panes.length; i++) {
    focus.cyclePane();
    if (focus.activePaneTarget() || focus.isPaneFocused(focus.panes[0]!))
      return;
  }
}
