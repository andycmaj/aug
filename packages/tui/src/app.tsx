// The provider stack and the two modes. Each mode gets its own focus
// provider (its own panes); terminals, the store view and the Assistant's
// conversation sit above them and survive the switch.

import { Match, onCleanup, Switch } from "solid-js";
import { CliRenderEvents, type Selection } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import {
  copyToClipboard,
  FocusProvider,
  KeymapProvider,
  ThemeProvider,
  type ThemeName,
} from "@andycmaj/opentui-app";
import { RikerProvider, useRiker, ViewMode } from "./context/riker";
import { useToast } from "./context/toast";
import { TerminalsProvider } from "./context/terminals";
import { ToastProvider } from "./context/toast";
import { Toast } from "./components/toast";
import type { Engine } from "@riker/core/engine";
import { BoardMode } from "./components/board-mode";
import { ChatMode } from "./components/chat-mode";
import { logger } from "@riker/core/log";
import { keyedActions } from "@riker/core/task-actions";
import { actionKeys, BOARD_PANES, buildKeymap, CHAT_PANES } from "./keymap";
import type { KeymapTable } from "@andycmaj/opentui-app";

const log = logger("app");

function Modes() {
  const riker = useRiker();
  return (
    <Switch>
      <Match when={riker.mode() === ViewMode.chat}>
        <FocusProvider panes={CHAT_PANES}>
          <ChatMode />
        </FocusProvider>
      </Match>
      <Match when={riker.mode() === ViewMode.board}>
        <FocusProvider panes={BOARD_PANES}>
          <BoardMode />
        </FocusProvider>
      </Match>
    </Switch>
  );
}

// The mouse is opentui's, on by default; config `mouse: false` hands it back
// to the terminal. Text dragged over (a chat, a brief) is copied once the
// button comes up, since with the mouse ours the terminal's own drag to
// select is gone.
function Mouse(props: {
  on: boolean;
  clipboard: (text: string) => Promise<boolean>;
}) {
  const renderer = useRenderer();
  const { showToast } = useToast();
  renderer.useMouse = props.on;
  const copy = (selection: Selection) => {
    const text = selection.getSelectedText();
    if (!text.trim()) {
      return;
    }
    void props
      .clipboard(text)
      .then((ok) =>
        ok ? showToast("Copied") : showToast("Could not copy", 4000, "error"),
      );
  };
  renderer.on(CliRenderEvents.SELECTION, copy);
  onCleanup(() => renderer.off(CliRenderEvents.SELECTION, copy));
  return null;
}

export function App(props: {
  engine: Engine;
  theme?: ThemeName;
  // Tests copy somewhere other than the system clipboard.
  clipboard?: (text: string) => Promise<boolean>;
}) {
  // Config's navigation and action keys are read once: the keymap engine
  // binds at start.
  const config = props.engine.desk.config();
  const keymap = buildKeymap(config.keys, keyedActions(config));
  for (const r of actionKeys(keyedActions(config), buildKeymap(config.keys))
    .refused) {
    log.warn("action key refused", r);
  }
  return (
    <ThemeProvider name={props.theme}>
      <RikerProvider engine={props.engine}>
        <TerminalsProvider>
          <ToastProvider>
            <KeymapProvider keymap={keymap as KeymapTable}>
              <Modes />
              <Toast />
              <Mouse
                on={config.mouse !== false}
                clipboard={props.clipboard ?? copyToClipboard}
              />
            </KeymapProvider>
          </ToastProvider>
        </TerminalsProvider>
      </RikerProvider>
    </ThemeProvider>
  );
}
