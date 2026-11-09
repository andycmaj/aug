// What both modes share: the app-wide keys, and the modals they open
// (palette, help, connections, and whatever dialog a move asked for). Each mode has its own FocusProvider, so this runs once per mode.

import { Show, type Accessor, type JSX } from "solid-js";
import type { Renderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import {
  CommandPalette,
  KeyboardHelp,
  useFocus,
  useScope,
  useToast,
  useTheme,
  type PaletteAction,
} from "@andycmaj/opentui-app";
import { Commands } from "../commands";
import { useAug, ViewMode } from "../context/aug";
import { DOC_PURPOSE, DocName, docPath } from "../core/docs";
import { useActions, useDialogs, type Actions, type Dialogs } from "./actions";
import { StatusModal } from "./modals";
import { RailLegend } from "./rail";

export interface ShellApi {
  dialogs: Dialogs;
  actions: Actions;
  // Spread onto the mode's layout box: app keys apply while focus is in it.
  layoutRef: (r: Renderable) => void;
  Modals: () => JSX.Element;
}

export function useShell(opts: {
  typing: Accessor<boolean>;
  extraPalette?: () => PaletteAction[];
}): ShellApi {
  const renderer = useRenderer();
  const aug = useAug();
  const { activeModal, openModal, closeModal, toggleSidebar, cyclePane } =
    useFocus();
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
      [Commands.FOCUS_NEXT]: cyclePane,
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

  function Modals() {
    return (
      <>
        <Show when={activeModal() === "palette"}>
          <CommandPalette actions={paletteActions()} onClose={closeModal} />
        </Show>
        <Show when={activeModal() === "help"}>
          <KeyboardHelp
            onClose={closeModal}
            scopeLabels={{
              app: "Anywhere",
              rail: "The rail",
              task: "The table",
              input: "The chat box",
              terminal: "An agent's terminal",
              board: "The Board",
            }}
            footer={
              <box flexDirection="column">
                <RailLegend />
                <text fg={theme.textMuted} marginTop={1}>
                  Nothing goes out until you press y and confirm.
                </text>
              </box>
            }
          />
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
