// What both modes share: the app-wide keys, and the modals they open
// (palette, help, connections, and whatever dialog an action asked for). Each mode has its own FocusProvider, so this runs once per mode.

import { Show, type Accessor, type JSX } from "solid-js";
import type { Renderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import {
  CommandPalette,
  PaletteMode,
  useFocus,
  useKeymap,
  useScope,
  useToast,
  useTheme,
  type PaletteAction,
} from "@andycmaj/opentui-app";
import { Commands } from "../commands";
import { useAug, ViewMode } from "../context/aug";
import { DOC_PURPOSE, DocName, docPath } from "../core/docs";
import { BoardTab, type HelpCtx } from "../keymap";
import { useActions, useDialogs, type Actions, type Dialogs } from "./actions";
import { FocusHelp } from "./focus-help";
import { INBOX_KEY, setBoardTab } from "./board-tab";
import { SearchModal, StatusModal } from "./modals";
import { RailLegend } from "./rail";
import { useFocusBindings } from "./footer";
import { logger } from "../core/log";
import { paletteEntries, type PaletteExtra } from "../palette";

export interface ShellApi {
  dialogs: Dialogs;
  actions: Actions;
  // Spread onto the mode's layout box: app keys apply while focus is in it.
  layoutRef: (r: Renderable) => void;
  // `ctx` is what the focused pane is on, for the ? help; `subject` names it
  // for the palette's title (a row's ref and title, or the Board's tab).
  Modals: (props: {
    ctx: Accessor<HelpCtx>;
    subject?: Accessor<string | null>;
  }) => JSX.Element;
}

const log = logger("shell");

export function useShell(opts: {
  typing: Accessor<boolean>;
  extraPalette?: () => PaletteExtra[];
}): ShellApi {
  const renderer = useRenderer();
  const aug = useAug();
  const focus = useFocus();
  const { activeModal, openModal, closeModal, toggleSidebar } = focus;
  const { showToast } = useToast();
  const theme = useTheme();
  const dialogs = useDialogs();
  const actions = useActions(dialogs);
  const keymap = useKeymap();
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
  // A row found from the Board opens in Chat, where the Canvas is. A jump
  // lands on the rail, never attached: the row it picks may be another
  // agent's terminal, and keys must not start going to it unasked.
  const openFromSearch = (key: string) => {
    if (key === INBOX_KEY) {
      setBoardTab(BoardTab.inbox);
      aug.setMode(ViewMode.board);
      return;
    }
    if (focus.isPaneFocused("canvas")) focus.setActivePane("rail");
    aug.goTo(key);
  };
  const history = (direction: 1 | -1) => {
    if (!aug.history(direction))
      showToast(direction < 0 ? "Nowhere further back" : "Nowhere further forward");
  };
  // Newest move first; one that cannot be undone, or whose task changed
  // since, says so and leaves the stack, so ctrl+z again reaches the one
  // before it.
  const undo = () =>
    void aug.desk.undo().then(
      (r) => showToast(r.text, r.ok ? 3000 : 5000, r.ok ? "info" : "error"),
      (err) => showToast(`Could not undo: ${err instanceof Error ? err.message : String(err)}`, 5000, "error"),
    );
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
      [Commands.FOCUS_NEXT]: focus.cyclePane,
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
      [Commands.UNDO]: unlessTyping(undo),
    },
    { target: () => layout },
  );

  // Moves with no key of their own; everything with a key comes from the
  // keymap (palette.ts).
  const paletteExtras = (): PaletteExtra[] => [
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
  ];

  // Runs the command as its key would, from the pane the palette was opened
  // over (a modal holds focus while it is open).
  const runCommand = (cmd: string) => {
    const result = keymap.dispatchCommand(cmd, {
      focused: focus.activePaneTarget() ?? null,
    });
    if (!result.ok) log.info(`palette: ${cmd} did not run (${result.reason})`);
  };

  function Palette(props: {
    ctx: Accessor<HelpCtx>;
    subject?: Accessor<string | null>;
  }) {
    const bindings = useFocusBindings(() => props.ctx());
    const entries = (): PaletteAction[] =>
      paletteEntries(bindings(), props.ctx(), [
        ...paletteExtras(),
        ...(opts.extraPalette?.() ?? []),
      ]).map((e) => ({
        id: e.id,
        label: e.label,
        hint: e.hint,
        // Context is a short list about one row: no headers.
        group: aug.paletteMode() === PaletteMode.ALL ? e.group : undefined,
        inContext: e.inContext,
        run: () => {
          const cmd = e.cmd;
          if (cmd) runCommand(cmd);
          else e.run?.();
        },
      }));
    const title = () => {
      if (aug.paletteMode() === PaletteMode.ALL) return "All commands";
      const subject = props.subject?.();
      return subject ? `Commands · ${subject}` : "Commands";
    };
    return (
      <CommandPalette
        actions={entries()}
        title={title()}
        mode={aug.paletteMode()}
        onModeChange={aug.setPaletteMode}
        onClose={closeModal}
      />
    );
  }

  function Modals(props: {
    ctx: Accessor<HelpCtx>;
    subject?: Accessor<string | null>;
  }) {
    return (
      <>
        <Show when={activeModal() === "palette"}>
          <Palette ctx={props.ctx} subject={props.subject} />
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
