// $EDITOR in an embedded terminal on the table: a draft, a brief, a chat
// message or a doc. The file goes through core/drafts; what comes back is
// handed to the desk.

import { useFocus, useToast } from "@andycmaj/opentui-app";
import { useAug, ViewMode } from "../context/aug";
import { useTerminals } from "../context/terminals";
import { draftFile, readDraft, removeDraft, writeDraft } from "../core/drafts";
import { actionText } from "../core/outbound";
import * as store from "../core/store";
import type { TaskRow } from "../core/types";

export const EDITOR_ID = "editor";

export function useEditor() {
  const aug = useAug();
  const terminals = useTerminals();
  const { setActivePane } = useFocus();
  const { showToast } = useToast();
  const desk = aug.desk;

  // done runs when the editor exits, before the table comes back.
  function openEditor(
    file: string,
    title: string,
    done?: (code: number | null) => void,
  ) {
    aug.setMode(ViewMode.chat);
    terminals.close(EDITOR_ID);
    const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
    terminals.open({
      id: EDITOR_ID,
      title,
      kind: "editor",
      argv: ["sh", "-c", `${editor} "$1"`, "editor", file],
      onExit: (code) => {
        // Before close: closing gives the table back, and what comes back
        // may read what done leaves.
        done?.(code);
        terminals.close(EDITOR_ID);
        setActivePane("task");
      },
    });
    setTimeout(() => setActivePane("task"), 0);
  }

  function editDraft(task: TaskRow): false | void {
    const pending = store.pendingAction(task.id);
    if (!pending) return false;
    const ref = store.taskRef(task.id);
    const file = draftFile(ref);
    writeDraft(file, actionText(pending.action));
    openEditor(file, `draft for ${ref}`, () => {
      const text = readDraft(file);
      if (text && desk.editDraft(task.id, text)) showToast("Draft updated");
    });
  }

  // The brief in $EDITOR, while the agent has not started from it yet.
  function editBrief(task: TaskRow): false | void {
    if (!desk.briefEditable(task.id)) return false;
    const ref = store.taskRef(task.id);
    const file = draftFile(ref, "brief");
    writeDraft(file, task.summary ? `${task.summary}\n` : "");
    openEditor(file, `brief for ${ref}`, () => {
      const text = readDraft(file)?.trim();
      removeDraft(file);
      if (text === undefined || text === task.summary.trim()) return;
      if (desk.editBrief(task.id, text)) showToast(`${ref}: brief updated`);
      else if (!text) showToast("An empty brief was not saved", 3000, "error");
    });
  }

  // The chat box in $EDITOR. Save and quit sends; quitting empty or with an
  // error (vim's :cq) sends nothing and hands the text back to the box.
  function compose(
    task: TaskRow,
    initial: string,
    keep: (text: string) => void,
  ) {
    const ref = store.taskRef(task.id);
    const file = draftFile(ref, "message");
    writeDraft(file, initial);
    openEditor(file, `a message on ${ref}`, (code) => {
      const text = readDraft(file) ?? initial;
      removeDraft(file);
      if (code === 0 && text.trim()) {
        void desk.say(task.id, text);
        return;
      }
      keep(text);
      setTimeout(() => setActivePane("input"), 0);
    });
  }

  return { openEditor, editDraft, editBrief, compose, editorId: EDITOR_ID };
}
