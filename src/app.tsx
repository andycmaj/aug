// The provider stack and the two modes. Each mode gets its own focus
// provider (its own panes); terminals, the store view and the Assistant's
// conversation sit above them and survive the switch.

import { Match, Switch } from "solid-js";
import {
  FocusProvider,
  KeymapProvider,
  ThemeProvider,
  Toast,
  ToastProvider,
  type ThemeName,
} from "@andycmaj/opentui-app";
import { AugProvider, useAug, ViewMode } from "./context/aug";
import { TerminalsProvider } from "./context/terminals";
import type { Engine } from "./core/engine";
import { BoardMode } from "./components/board-mode";
import { ChatMode } from "./components/chat-mode";
import { BOARD_PANES, CHAT_PANES, keymap } from "./keymap";
import type { KeymapTable } from "@andycmaj/opentui-app";

function Modes() {
  const aug = useAug();
  return (
    <Switch>
      <Match when={aug.mode() === ViewMode.chat}>
        <FocusProvider panes={CHAT_PANES}>
          <ChatMode />
        </FocusProvider>
      </Match>
      <Match when={aug.mode() === ViewMode.board}>
        <FocusProvider panes={BOARD_PANES}>
          <BoardMode />
        </FocusProvider>
      </Match>
    </Switch>
  );
}

export function App(props: { engine: Engine; theme?: ThemeName }) {
  return (
    <ThemeProvider name={props.theme}>
      <AugProvider engine={props.engine}>
        <TerminalsProvider>
          <ToastProvider>
            <KeymapProvider keymap={keymap as KeymapTable}>
              <Modes />
              <Toast />
            </KeymapProvider>
          </ToastProvider>
        </TerminalsProvider>
      </AugProvider>
    </ThemeProvider>
  );
}
