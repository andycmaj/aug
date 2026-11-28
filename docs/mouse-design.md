# Mouse

The keyboard stays the way to do everything; the mouse is a shortcut for
pointing at what is on screen. A click does what moving there and pressing
the key would, through the same handlers, so nothing the mouse does needs a
second code path or its own undo.

## What works already

opentui turns mouse reporting on by default (`useMouse`), hit-tests every
event to the deepest renderable under it and bubbles it up the tree, and on
a left press focuses the nearest focusable ancestor (`autoFocus`). Every
`Pane` is focusable (`usePane`), and opentui-app's `activePane` follows the
renderer's focus. So today, checked in `bun run demo` with SGR presses sent
through tmux:

- A click anywhere in the rail, the Canvas or the chat box focuses that
  pane (the focus border and the footer follow).
- Clicking a live agent's terminal focuses the Canvas, which attaches it.
- The wheel scrolls whatever scrollbox is under the pointer (the rail, a
  chat, a list, a modal), and on a terminal it goes to the program when it
  tracks the mouse (tmux with `mouse on`, Claude Code fullscreen), else
  arrows on the alternate screen, else our own scrollback
  (`TerminalModes.wheel`).

What is missing is everything a click should *mean* beyond focus, and any
click reaching the program in an agent's pane.

## What a click does

All on a left press (`down`): a row reacts as the button goes down, as
lists do in most TUIs, and opentui focuses the pane right after the
handler, so the pane and the row change together.

| Where | Click | Same as |
| --- | --- | --- |
| Rail row (task, project, Home, Win copy) | select it | j/k there, then the selection follows |
| Rail filter pill | toggle that filter | f, then the pill's key |
| Board tab title | switch tab | 1-6 |
| Board Columns card | cursor to it | h/j/k/l |
| Inbox / Wins / Docs row (`ExpandList`) | cursor to it; on the cursor row, open/close it | j/k, enter |
| Filter pills on those tabs | toggle | the pill's key |
| Knowledge entry | cursor to it | j/k |
| Go-to list, palette, picker rows (modals) | pick it | enter |
| Outside an open modal | close it | esc |
| Footer `chat \| board` | switch view | v |
| Canvas header link | open it | o |

A click on a rail row only ever selects it; enter stays the way into an
agent or the chat box (or a click on the Canvas or the chat box itself).

The wheel stays as it is: it scrolls the view under the pointer and never
moves the cursor or the selection.

## Into an agent's pane

The terminal is the one place a click must reach another program. While
attached, the Canvas's `TerminalHost` forwards presses, releases and drags
to the PTY when the program asked for them, the same way the wheel goes
today:

- `TerminalModes` already tracks 1000/1002/1003 and SGR (1006). It keeps
  which ones are set, so motion goes only under 1002 (with a button held)
  or 1003 (any), and a program that asked for none gets no clicks.
- Coordinates are cells relative to the terminal's view (as the wheel's
  are), buttons and shift/alt/ctrl in the xterm encoding, SGR when asked,
  else X10 clamped at 223.
- opentui captures a drag on the renderable it started on, so a drag that
  leaves the terminal still ends in it with its release.
- Detached, a click attaches and goes no further: the press that focuses
  the pane is not also a click inside it (no surprise tmux pane switch or
  Claude Code cursor move). The next one goes in.
- The editor and ghdash terminals get the same forwarding; nothing about
  it is agent-only.

In the owner's tmux (`mouse on`) that gives click-to-select-pane in a split
(revdiff beside claude), drag to copy through tmux's copy mode and its own
`MouseDragEnd1Pane` binding, and the wheel it already has.

## Selecting text

With mouse reporting on, the outer terminal no longer selects on a plain
drag; most terminals still do with shift (or option on macOS) held. opentui
has its own selection on selectable text, but nothing copies it. A drag
over chat text that ends with a selection copies it (OSC 52, as the
terminal's clipboard replies already do) and toasts "copied". Inside an
attached terminal, tmux's copy mode handles it, as above.

## Turning it off

Config `mouse: false` (read at start, like `motion`) starts the renderer
with `useMouse: false`, for anyone who wants the terminal's own plain-drag
selection back. Default on, since opentui already has it on today.

## How it is built

- One helper in `components/ui.tsx`, `onPress(fn)`, giving a renderable a
  left-press handler that calls `fn` and leaves everything else (wheel,
  other buttons, focus) alone. Rows, tabs, pills and the footer use it.
  No manual hit-testing: opentui's hit test and bubbling find the row, and
  a scrolled rail or list is already accounted for.
- A row's handler calls the same function its key does (`riker.select`,
  `setBoardTab`, the list cursor's `set`, the pill's toggle), so nav
  history, undo and the Canvas follow without anything new.
- The terminal forwarding is `TerminalModes.mouse(event, x, y)` beside
  `wheel`, returning bytes or null, and one `onMouse` on the view in
  `context/terminals.tsx`, which already owns `onMouseScroll`.
- No keymap entries: a click is not a binding, so the footer, `?` help,
  the palette and `docs/keyboard.html` are unchanged. The help card gets
  one line saying the mouse works and what `mouse: false` does.

## Proof

- Unit: `TerminalModes.mouse` encodings (SGR and X10, each button,
  modifiers, motion only under 1002/1003, nothing with no mode set).
- Render tests with `testRender`'s `mockMouse`: click a rail row selects it
  and focuses the rail; click a
  Board tab switches; click an Inbox row moves the cursor then opens it;
  click outside a modal closes it; click a detached terminal attaches
  without writing to the PTY, and the next click writes SGR bytes.
- In `bun run demo` driven through tmux with SGR bytes, captured before and
  after, as above; and once by hand on a real agent in tmux with `mouse on`.

## Order

1. Rail rows and pills, Board tabs, footer view switch.
2. `ExpandList` rows, Columns cards, Knowledge, modal rows, click outside.
3. Forwarding into terminals.
4. Copy on selection, `mouse: false`.

Each step is a commit with its tests.
