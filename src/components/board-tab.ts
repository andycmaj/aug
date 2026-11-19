// Which Board tab shows. Its own module so the go-to list can open the
// Inbox without importing the Board.

import { createSignal } from "solid-js";
import { BoardTab } from "../keymap";

export const [boardTab, setBoardTab] = createSignal<BoardTab>(BoardTab.wins);

// The go-to list's key for the Inbox: not a rail row.
export const INBOX_KEY = "inbox";
