// What both modes share: the app-wide keys, and the modals they open
// (palette, help, connections, and whatever dialog an action asked for). Each mode has its own FocusProvider, so this runs once per mode.

import { Show, type Accessor, type JSX } from "solid-js";
import type { Renderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import {
  CommandPalette,
  useFocus,
  useScope,
  useToast,
  useTheme,
  type PaletteAction,
} from "@andycmaj/opentui-app";
import { Commands } from "../commands";
import { useAug, ViewMode } from "../context/aug";
import { DOC_PURPOSE, DocName, docPath } from "../core/docs";
import { focusNext } from "../core/focus";
import type { HelpCtx } from "../keymap";
import { useActions, useDialogs, type Actions, type Dialogs } from "./actions";
import { FocusHelp } from "./focus-help";
import { SearchModal, StatusModal } from "./modals";
import { RailLegend } from "./rail";

export interface ShellApi {
  dialogs: Dialogs;
  actions: Actions;
  // Spread onto the mode's layout box: app keys apply while focus is in it.
  layoutRef: (r: Renderable) => void;
  // `ctx` is what the focused pane is on, for the ? help.
  Modals: (props: { ctx: Accessor<HelpCtx> }) => JSX.Element;
}

export function useShell(opts: {
  typing: Accessor<boolean>;
  extraPalette?: () => PaletteAction[];
}): ShellApi {
  const renderer = useRenderer();
  const aug = useAug();
  const focus = useFocus();
  const { activeModal, openModal, closeModal, toggleSidebar } = focus;
  const { showToast } = useToast();
  const theme = useTheme();
  const dialogs = useDialogs();
  const actions = useActions(dialogs);
  let layout: Renderable | undefined;

  // App keys decline while a text box has focus, so typing reaches it.
  const unlessTyping = (fn: () => unknown) => () =>
    opts.typing() ? false : fn();

  const quit = () => {
    aug.engine.stop();
    renderer.destroy();
    process.exit(0);
  };

  const toggleView = () =>
    aug.setMode(aug.mode() === ViewMode.chat ? ViewMode.board : ViewMode.chat);
  const pollNow = () => {
    showToast("Checking GitHub and Slack...");
    void aug.engine.pollNow();
  };
  // A row found from the Board opens in Chat, where the table is. A jump
  // lands on the rail, never attached: the row it picks may be another
  // agent's terminal, and keys must not start going to it unasked.
  const openFromSearch = (key: string) => {
    if (focus.isPaneFocused("task")) focus.setActivePane("rail");
    aug.goTo(key);
  };
  const history = (direction: 1 | -1) => {
    if (!aug.history(direction))
      showToast(direction < 0 ? "Nowhere further back" : "Nowhere further forward");
  };
  const advisor = () => {
    showToast("The Advisor is reading your work...");
    void aug.engine.advisorNow();
  };

  useScope(
    "app",
    {
      [Commands.APP_QUIT]: unlessTyping(quit),
      [Commands.PALETTE_OPEN]: unlessTyping(() => openModal("palette")),
      [Commands.HELP_OPEN]: unlessTyping(() => openModal("help")),
      [Commands.SIDEBAR_TOGGLE]: toggleSidebar,
      [Commands.FOCUS_NEXT]: () => focusNext(focus),
      [Commands.VIEW_TOGGLE]: unlessTyping(toggleView),
      [Commands.ASK_OPEN]: unlessTyping(aug.goHome),
      [Commands.NEW_TASK]: unlessTyping(actions.newTask),
      [Commands.POLL_NOW]: pollNow,
      [Commands.DOCS_OPEN]: unlessTyping(actions.docs),
      [Commands.STATUS_OPEN]: unlessTyping(() => openModal("status")),
      [Commands.WALK_NEXT]: unlessTyping(() => {
        aug.setMode(ViewMode.chat);
        actions.walk(1);
      }),
      [Commands.WALK_BACK]: unlessTyping(() => actions.walk(-1)),
      [Commands.SEARCH_OPEN]: unlessTyping(() => openModal("search")),
      // A control chord: from the chat box too.
      [Commands.GO_TO]: () => openModal("search"),
      [Commands.HISTORY_BACK]: unlessTyping(() => history(-1)),
      [Commands.HISTORY_FORWARD]: unlessTyping(() => history(1)),
    },
    { target: () => layout },
  );

  const paletteActions = (): PaletteAction[] => [
    {
      id: "walk",
      group: "Work",
      label: "Walk me through my tasks",
      hint: "n",
      run: () => actions.walk(1),
    },
    {
      id: "search",
      group: "Work",
      label: "Go to: search the rail, or a recent row",
      hint: "/",
      run: () => openModal("search"),
    },
    {
      id: "history-back",
      group: "Work",
      label: "Back to where you were",
      hint: aug.desk.config().keys?.back ?? "[",
      run: () => history(-1),
    },
    {
      id: "history-forward",
      group: "Work",
      label: "Forward again",
      hint: aug.desk.config().keys?.forward ?? "]",
      run: () => history(1),
    },
    {
      id: "new",
      group: "Work",
      label: "New task / give an agent a job",
      hint: "N",
      run: actions.newTask,
    },
    {
      id: "ask",
      group: "Work",
      label: "Ask the Assistant (Home)",
      hint: "a",
      run: aug.goHome,
    },
    {
      id: "view",
      group: "Work",
      label:
        aug.mode() === ViewMode.chat ? "Switch to the Board" : "Switch to Chat",
      hint: "v",
      run: toggleView,
    },
    ...(opts.extraPalette?.() ?? []),
    {
      id: "poll",
      group: "Connections",
      label: "Check GitHub and Slack now",
      hint: "^r",
      run: pollNow,
    },
    {
      id: "status",
      group: "Connections",
      label: "Connections and Advisor status",
      hint: "C",
      run: () => openModal("status"),
    },
    {
      id: "advisor",
      group: "Connections",
      label: "Run the Advisor now",
      run: advisor,
    },
    ...Object.values(DocName).map((name) => ({
      id: `doc-${name}`,
      group: "Docs",
      label: `Edit ${name}`,
      hint: DOC_PURPOSE[name].slice(0, 24),
      run: () => actions.openEditor(docPath(name), name),
    })),
    { id: "quit", group: "App", label: "Quit", hint: "q", run: quit },
  ];

  function Modals(props: { ctx: Accessor<HelpCtx> }) {
    return (
      <>
        <Show when={activeModal() === "palette"}>
          <CommandPalette actions={paletteActions()} onClose={closeModal} />
        </Show>
        <Show when={activeModal() === "help"}>
          <FocusHelp
            ctx={() => props.ctx()}
            onClose={closeModal}
            footer={
              <box flexDirection="column">
                <Show when={aug.mode() === ViewMode.chat}>
                  <RailLegend />
                </Show>
                <text fg={theme.textMuted} marginTop={1}>
                  Nothing goes out until you press y and confirm.
                </text>
              </box>
            }
          />
        </Show>
        <Show when={activeModal() === "search"}>
          <SearchModal onClose={closeModal} onPick={openFromSearch} />
        </Show>
        <Show when={activeModal() === "status"}>
          <StatusModal
            onClose={closeModal}
            onAdvisor={advisor}
            onPoll={pollNow}
          />
        </Show>
        <Show when={activeModal() === "dialog" && dialogs.dialog()}>
          {(render: Accessor<() => JSX.Element>) => render()()}
        </Show>
      </>
    );
  }

  return { dialogs, actions, layoutRef: (r) => (layout = r), Modals };
}
