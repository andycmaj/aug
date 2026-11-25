// $EDITOR in an embedded terminal on the Canvas: a draft, a brief, a chat
// message or a doc. The file goes through core/drafts; what comes back is
// handed to the desk.

import { useFocus, useToast } from "@andycmaj/opentui-app";
import { useRiker, ViewMode } from "../context/riker";
import { useTerminals } from "../context/terminals";
import { draftFile, readDraft, removeDraft, writeDraft } from "@riker/core/drafts";
import { taskRef } from "@riker/core/rows";
import type { TaskRow } from "@riker/core/types";

export const EDITOR_ID = "editor";

export function useEditor() {
  const riker = useRiker();
  const terminals = useTerminals();
  const { setActivePane } = useFocus();
  const { showToast } = useToast();
  const desk = riker.desk;

  // done runs when the editor exits, before the Canvas comes back.
  function openEditor(
    file: string,
    title: string,
    done?: (code: number | null) => void,
  ) {
    riker.setMode(ViewMode.chat);
    terminals.close(EDITOR_ID);
    const editor = process.env.VISUAL ?? process.env.EDITOR ?? "vi";
    terminals.open({
      id: EDITOR_ID,
      title,
      kind: "editor",
      argv: ["sh", "-c", `${editor} "$1"`, "editor", file],
      onExit: (code) => {
        // Before close: closing gives the Canvas back, and what comes back
        // may read what done leaves.
        done?.(code);
        terminals.close(EDITOR_ID);
        setActivePane("canvas");
      },
    });
    setTimeout(() => setActivePane("canvas"), 0);
  }

  function editDraft(task: TaskRow): false | void {
    const pending = riker.pendingAction(task.id);
    if (!pending) return false;
    const ref = taskRef(task.id);
    const file = draftFile(ref);
    writeDraft(file, desk.drafts.text(pending.action));
    openEditor(file, `draft for ${ref}`, () => {
      const text = readDraft(file);
      if (text && desk.editDraft(task.id, text)) showToast("Draft updated");
    });
  }

  // The brief in $EDITOR, while the agent has not started from it yet.
  function editBrief(task: TaskRow): false | void {
    if (!desk.briefEditable(task.id)) return false;
    const ref = taskRef(task.id);
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

  // A project's brief, goals and docs in one file.
  function editProject(projectId: number): false | void {
    const text = desk.projectDoc(projectId);
    if (text === null) return false;
    const file = draftFile(`project-${projectId}`);
    writeDraft(file, text);
    openEditor(file, "project brief", () => {
      const next = readDraft(file);
      removeDraft(file);
      if (next === null) return;
      const said = desk.editProject(projectId, next);
      if (said) showToast(said);
    });
  }

  // The story in $EDITOR, every part's heading in it: saved, it is a new
  // version by the owner. A rewrite that does not read back keeps its file
  // and says where.
  function editStory(task: TaskRow): false | void {
    const ref = taskRef(task.id);
    const doc = desk.storyDoc(task.id, true);
    const file = draftFile(ref, "story");
    const head = `<!-- ${ref} story${doc ? `, as of ${doc.asOf}` : ""}. Each line under a heading is one item; save to keep it as a new version. -->`;
    const body = doc?.text ?? desk.storyTemplate();
    writeDraft(file, `${head}\n\n${body}\n`);
    openEditor(file, `story for ${ref}`, (code) => {
      const text = readDraft(file);
      if (code !== 0 || text === null) {
        removeDraft(file);
        return;
      }
      const said = desk.editStory(task.id, text);
      if (said.ok) removeDraft(file);
      showToast(said.ok ? said.text : `${said.text} (kept in ${file})`, said.ok ? 3000 : 8000, said.ok ? "info" : "error");
    });
  }

  // The journal on a copy: the engine may write an entry while it is open,
  // so saving lays the edit over the file as it is then. One that touched
  // the same lines keeps its copy and says where.
  function editJournal(projectId: number): false | void {
    const found = desk.journal(projectId);
    if (!found) return false;
    const file = draftFile(`project-${projectId}`, "journal");
    writeDraft(file, found.text);
    openEditor(file, "journal", (code) => {
      const text = readDraft(file);
      if (code !== 0 || text === null) {
        removeDraft(file);
        return;
      }
      const said = desk.saveJournal(projectId, found.text, text);
      if (said.ok) removeDraft(file);
      showToast(said.ok ? said.text : `${said.text}; your copy is in ${file}`, said.ok ? 3000 : 10000, said.ok ? "info" : "error");
    });
  }

  // The chat box in $EDITOR. Save and quit sends; quitting empty or with an
  // error (vim's :cq) sends nothing and hands the text back to the box.
  function compose(
    task: TaskRow,
    initial: string,
    keep: (text: string) => void,
  ) {
    const ref = taskRef(task.id);
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

  return {
    openEditor,
    editDraft,
    editBrief,
    editProject,
    editStory,
    editJournal,
    compose,
    editorId: EDITOR_ID,
  };
}
