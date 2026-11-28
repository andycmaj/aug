# Mouse

You can do everything from the keyboard. The mouse is a shortcut for
pointing at what is on screen. A click does what moving there and pressing
the key would, through the same handlers, so nav history, undo and the
Canvas follow, and the mouse has no code path or undo of its own.

## What opentui gives

opentui turns mouse reporting on (`useMouse`). It hit-tests every event to
the deepest renderable under the pointer, bubbles the event up the tree,
and on a left press focuses the nearest focusable ancestor (`autoFocus`).
Every `Pane` is focusable (`usePane`), and opentui-app's `activePane`
follows the renderer's focus. So with nothing of Riker's own:

- A click anywhere in the rail, the Canvas or the chat box focuses that
  pane. Clicking a live agent's terminal focuses the Canvas, which
  attaches it. Clicking the rail from an attached agent detaches it.
- The wheel scrolls whatever scrollbox is under the pointer: the rail, a
  chat, a list or a modal. It scrolls the view and never moves the cursor
  or the selection.

## What a click does

Rows, tabs and pills act on a left press (`onPress` in `components/ui.tsx`),
as the button goes down. opentui then focuses the pane under the pointer,
so the pane and the row change together.

| Where | Click | Same as |
| --- | --- | --- |
| Rail row (task, project, Home, a Win's copy) | select it; the rail keeps focus | j/k there, enter |
| Rail filter pill | toggle that filter | its digit |
| Board tab title | switch tab | 1-6 |
| Columns card | cursor to it | h/j/k/l |
| Inbox, Wins or Docs row (`ExpandList`) | cursor to it; on the cursor's row, open or close it | j/k, enter |
| Inbox or Docs pill | that filter | f |
| Knowledge entry | cursor to it | j/k |
| Go-to row, a choice in a picker | pick it | enter |
| An Info line | select it | j/k |
| Footer `chat \| board` | switch view | v |

A click on a rail row only selects it. To go into an agent or the chat box,
press enter or click the Canvas or the chat box.

The palette's rows take no clicks, and a click outside a modal does
nothing. Both live in opentui-app (`CommandPalette`, `Modal`'s backdrop),
not in Riker.

## Into a terminal

A terminal is the one place where a click must reach another program
(`context/terminals.tsx`, `TerminalModes.click`):

- Clicks go in only while that terminal is attached (`claimKeys`), and only
  the kinds the program asked for: 9 is presses only, 1000 adds releases,
  1002 adds drags with a button held, and 1003 adds any motion. A program
  that asked for none gets none.
- Clicks are encoded the way xterm does it. A click is in cells relative to
  the terminal's view, with the button plus 4 for shift, 8 for alt and 16
  for ctrl, and 32 more for motion. It is sent as SGR (1006) when the
  program asked for that, else in the legacy encoding, which ends at cell
  223.
- The press that attaches a detached terminal goes no further: it is a
  click on Riker, not in the program, so there is no surprise tmux pane
  switch. A release or a drag goes in only after a press that went in, so
  the program never sees half a click. A drag that leaves the terminal is
  held at its edge, and opentui keeps sending it to the terminal it
  started on.
- The wheel goes to a program that tracks the mouse. On the alternate
  screen without tracking it sends arrow keys, and otherwise it scrolls our
  own scrollback (`TerminalModes.wheel`).

The agent's viewer is a tmux client, so with `mouse on` in your tmux
config, a click picks a pane in a split (a diff viewer beside claude), and
a drag copies through tmux's copy mode and your own `MouseDragEnd1Pane`
binding.

## Copying text

While Riker has the mouse, a plain drag no longer selects text in your
terminal. Most terminals still select with shift held (option in some
macOS terminals). Riker selects text you drag over itself (chats, briefs,
lists). When the button comes up it copies the text to the system clipboard
and says "Copied". A click with no drag copies nothing.

## Turning it off

Config `mouse: false`, read at start, hands the mouse back to the terminal:
no clicks, wheel or copying in Riker, and a plain drag selects in the
terminal again. The `?` help card says so.

## Proof

- `packages/tui/src/terminal/modes.test.ts`: the click encodings (SGR and
  legacy, each button, modifiers, motion only under 1002 and 1003, presses
  only under 9, nothing with no mode set).
- `packages/tui/test/mouse.test.tsx`: the real App under `testRender`'s
  `mockMouse`. It checks rail rows and pills, the view switch, Board tabs,
  Inbox rows and pills, cards, Knowledge, go-to, and an agent's terminal
  (a click attaches it with no bytes in, the next click goes in as exact
  SGR, a 1002 drag as press, motion and release, nothing to a program that
  asked for no clicks, a rail click detaches). It also checks drag to copy,
  a click that copies nothing, and `mouse: false`.
