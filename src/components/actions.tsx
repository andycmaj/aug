// Every action the owner takes on a row, once: the rail, the table, the
// Board and the palette all call these. They ask the desk, open dialogs,
// toast the outcome, and keep the table moving (a row that leaves the rail
// hands the table to the next). Starting an agent, the editor and the
// embedded viewer each have a hook of their own beside this one.

import { createSignal, type Accessor, type JSX } from "solid-js";
import { existsSync } from "node:fs";
import { useFocus, useToast } from "@andycmaj/opentui-app";
import { Commands } from "../commands";
import { useAug, ViewMode } from "../context/aug";
import { useTerminals } from "../context/terminals";
import { DOC_PURPOSE, DocName, docPath } from "../core/docs";
import {
  formatBytes,
  openerArgv,
  openTarget,
  parseFiles,
  type MadeFile,
} from "../core/files";
import { infoTitle, itemInfo } from "../core/info";
import { errorMessage } from "../core/log";
import { claudeSettingsPath, hooksInstalled, installHooks } from "../core/adopt";
import { loadConfig } from "../core/config";
import { neighborKey, type RailItem } from "../core/rail";
import * as store from "../core/store";
import { Kind, Priority, type TaskRow } from "../core/types";
import {
  ChoiceModal,
  ConfirmSendModal,
  InfoModal,
  PromptModal,
} from "./modals";
import type { TaskActions } from "./task-actions";
import { useAgentStart } from "./use-agent-start";
import { useEditor } from "./use-editor";
import { useViewer } from "./use-viewer";

export interface Dialogs {
  dialog: Accessor<(() => JSX.Element) | null>;
  show: (render: () => JSX.Element) => void;
  close: () => void;
}

export function useDialogs(): Dialogs {
  const { openModal, closeModal } = useFocus();
  const [dialog, setDialog] = createSignal<(() => JSX.Element) | null>(null);
  return {
    dialog,
    show: (render) => {
      setDialog(() => render);
      openModal("dialog");
    },
    close: () => {
      closeModal();
      setDialog(null);
    },
  };
}

export function useActions(dialogs: Dialogs) {
  const aug = useAug();
  const terminals = useTerminals();
  const { showToast } = useToast();
  const desk = aug.desk;
  const editor = useEditor();
  const { attachViewer } = useViewer();
  const { startAgent } = useAgentStart(dialogs, attachViewer);

  // A row is about to leave the rail. On the table: the table walks on.
  // Only under the cursor: the cursor steps to a neighbor, the table stays.
  function advanceFrom(key: string) {
    if (aug.selectedKey() === key) {
      const next = aug.walk(1) ?? aug.walk(-1);
      if (!next) aug.select(null);
      return;
    }
    if (aug.cursorKey() === key) {
      aug.moveCursor(
        neighborKey(
          aug.shownItems().map((i) => i.key),
          key,
        ),
      );
    }
  }

  // ── projects ──────────────────────────────────────────────────────────

  // The first project you make or adopt offers the hooks that pick up
  // claudes you start by hand. Asked once; `aug hooks` is there after.
  function offerHooks() {
    if (desk.offline || hooksInstalled() || store.kvGet("hooks.offered"))
      return;
    store.kvSet("hooks.offered", "1");
    dialogs.show(() => (
      <ChoiceModal
        title="Pick up claudes you start by hand?"
        hint={`Adds hooks to ${claudeSettingsPath()} that only act inside a project's tmux session. Undo with: aug hooks uninstall`}
        choices={[
          {
            label: "Yes, install the hooks",
            run: () => {
              try {
                showToast(`Hooks added to ${installHooks()}`);
              } catch (err) {
                showToast(`Could not install: ${errorMessage(err)}`, 4000, "error");
              }
            },
          },
          { label: "Not now", run: () => {} },
        ]}
        onClose={dialogs.close}
      />
    ));
  }

  function newProject(then?: (projectId: number) => void) {
    const repos = Object.keys(loadConfig().github.repos);
    const create = (name: string, repo: string | null) =>
      void desk.createProject(name, repo).then(
        (p) => {
          showToast(`Project ${p.name}: tmux session ${p.tmux_session}`);
          then?.(p.id);
          offerHooks();
        },
        (err) => showToast(`Could not create: ${errorMessage(err)}`, 4000, "error"),
      );
    dialogs.show(() => (
      <PromptModal
        title="New project"
        hint="One tmux session; each task in it gets a window and a worktree."
        placeholder="billing-migration"
        onSubmit={(name) => {
          if (repos.length === 0) return create(name.trim(), null);
          dialogs.show(() => (
            <ChoiceModal
              title={`Main repo for ${name.trim()}`}
              hint="Where the session opens. Tasks can use any repo."
              choices={[
                ...repos.map((repo) => ({
                  label: repo,
                  run: () => create(name.trim(), repo),
                })),
                { label: "none", run: () => create(name.trim(), null) },
              ]}
              onClose={dialogs.close}
            />
          ));
        }}
        onClose={dialogs.close}
      />
    ));
  }

  async function adoptProject() {
    let sessions: Awaited<ReturnType<typeof desk.adoptableSessions>>;
    try {
      sessions = await desk.adoptableSessions();
    } catch (err) {
      showToast(`tmux: ${errorMessage(err)}`, 4000, "error");
      return;
    }
    if (sessions.length === 0) {
      showToast("Every tmux session is a project already (or none is running)");
      return;
    }
    dialogs.show(() => (
      <ChoiceModal
        title="Adopt a tmux session as a project"
        hint="aug tags it; its name and windows stay as they are."
        choices={sessions.map((s) => ({
          label: s.name,
          run: () =>
            void desk.adoptSession(s.id).then(
              (p) => {
                showToast(`Project ${p.name}`);
                offerHooks();
              },
              (err) => showToast(`Could not adopt: ${errorMessage(err)}`, 4000, "error"),
            ),
        }))}
        onClose={dialogs.close}
      />
    ));
  }

  function moveToProject(task: TaskRow) {
    const move = (projectId: number) =>
      void desk.moveTask(task.id, projectId).then(
        () => showToast(`${store.taskRef(task.id)} moved`),
        (err) => showToast(`Could not move: ${errorMessage(err)}`, 4000, "error"),
      );
    const others = store.listProjects().filter((p) => p.id !== task.project_id);
    dialogs.show(() => (
      <ChoiceModal
        title={`Move ${store.taskRef(task.id)} to a project`}
        hint="Its window moves with it; the claude keeps running."
        choices={[
          ...others.map((p) => ({ label: p.name, run: () => move(p.id) })),
          { label: "New project...", run: () => newProject(move) },
        ]}
        onClose={dialogs.close}
      />
    ));
  }

  function archiveProject(projectId: number) {
    const project = store.getProject(projectId);
    if (!project) return;
    const open = store
      .tasksForProject(projectId)
      .filter((t) => t.status === "open" || t.status === "later").length;
    dialogs.show(() => (
      <ChoiceModal
        title={`Archive ${project.name}?`}
        hint={`Kills tmux session ${project.tmux_session}${open ? ` and the windows of its ${open} open task${open === 1 ? "" : "s"}` : ""}. Tasks and worktrees stay.`}
        choices={[
          {
            label: "Archive it",
            run: () =>
              void desk.archiveProject(projectId).then(
                () => showToast(`${project.name} archived`),
                (err) => showToast(`Could not archive: ${errorMessage(err)}`, 4000, "error"),
              ),
          },
          { label: "Keep it", run: () => {} },
        ]}
        onClose={dialogs.close}
      />
    ));
  }

  async function jumpToProject(projectId: number) {
    try {
      await desk.jumpToProject(projectId);
    } catch (err) {
      showToast(`Could not jump: ${errorMessage(err)}`, 4000, "error");
    }
  }

  async function nudge(taskId: number) {
    try {
      showToast(
        (await desk.nudge(taskId))
          ? `${store.taskRef(taskId)}: nudged`
          : "Its window is gone; s starts it again",
      );
    } catch (err) {
      showToast(`Could not nudge: ${errorMessage(err)}`, 4000, "error");
    }
  }

  async function jumpTo(taskId: number) {
    try {
      if (!(await desk.jumpToTask(taskId)))
        showToast("Its window is gone; s starts it again");
    } catch (err) {
      showToast(`Could not jump: ${errorMessage(err)}`, 4000, "error");
    }
  }

  // ── on a task ─────────────────────────────────────────────────────────

  function start(task: TaskRow) {
    if (task.kind === Kind.home) return;
    void startAgent(task.id);
  }

  function stop(task: TaskRow) {
    const live = terminals.forTask(task.id);
    if (live?.running) terminals.close(live.id);
    void desk.stopAgent(task.id).then(
      () => showToast(`${store.taskRef(task.id)}: stopped and saved`),
      (err) => showToast(`Could not stop: ${errorMessage(err)}`, 4000, "error"),
    );
  }

  function done(task: TaskRow) {
    const live = terminals.forTask(task.id);
    if (live?.running) terminals.close(live.id);
    advanceFrom(`t${task.id}`);
    void desk.close(task.id).then(
      (r) =>
        showToast(
          r.warnings.length
            ? `${store.taskRef(task.id)} done; ${r.warnings.join("; ")}`
            : `${store.taskRef(task.id)} done${r.archived ? ", project archived" : ""}`,
          r.warnings.length ? 5000 : 2000,
          r.warnings.length ? "error" : "info",
        ),
      (err) => showToast(`Closing: ${errorMessage(err)}`, 4000, "error"),
    );
  }

  function remind(task: TaskRow) {
    const pick = (label: string, days: number) => ({
      label,
      run: () => {
        advanceFrom(`t${task.id}`);
        const at = desk.remind(task.id, days);
        showToast(`Back ${new Date(at).toDateString()}`);
      },
    });
    const toMonday = (8 - new Date().getDay()) % 7 || 7;
    dialogs.show(() => (
      <ChoiceModal
        title={`Remind me about ${store.taskRef(task.id)}`}
        hint="Put away until the day you pick, then back on your rail that morning."
        choices={[
          pick("Tomorrow", 1),
          pick("In 2 days", 2),
          pick("Next Monday", toMonday),
          pick("Next week", 7),
          pick("In 2 weeks", 14),
        ]}
        onClose={dialogs.close}
      />
    ));
  }

  function watch(task: TaskRow) {
    desk.watch(task.id, !task.watching);
    showToast(
      task.watching ? "Back in Tasks" : "Watching: not yours, kept open",
    );
  }

  function notATask(task: TaskRow) {
    advanceFrom(`t${task.id}`);
    desk.notATask(task.id);
    showToast("Not a task: triage will learn from it");
  }

  function cyclePriority(task: TaskRow) {
    const order: Priority[] = [
      Priority.regular,
      Priority.important,
      Priority.urgent,
    ];
    const next = order[(order.indexOf(task.priority) + 1) % order.length];
    desk.setPriority(task.id, next);
    showToast(`${store.taskRef(task.id)} is ${next}`);
  }

  function changeKind(task: TaskRow) {
    const pick = (kind: Kind, hint: string) => ({
      label: kind,
      hint,
      run: () => desk.setKind(task.id, kind),
    });
    dialogs.show(() => (
      <ChoiceModal
        title="What kind of work is it?"
        hint="Correcting it teaches triage."
        choices={[
          pick(Kind.general, "worth thinking about: an agent in a chat"),
          pick(Kind.reply, "a sentence settles it"),
          pick(Kind.coding, "an agent at a keyboard in a repo"),
          pick(Kind.task, "yours to do"),
        ]}
        onClose={dialogs.close}
      />
    ));
  }

  function waitOn(task: TaskRow) {
    dialogs.show(() => (
      <PromptModal
        title="Hand it to a person"
        hint="The task waits on them, and comes back when they answer. Empty clears it."
        placeholder="Who is it waiting on?"
        initial={task.waiting_on ?? ""}
        onSubmit={(who) => desk.waitOn(task.id, who)}
        onClose={dialogs.close}
      />
    ));
  }

  function send(task: TaskRow) {
    const pending = store.pendingAction(task.id);
    if (!pending) {
      showToast("Nothing waits to be sent");
      return;
    }
    dialogs.show(() => (
      <ConfirmSendModal
        action={pending.action}
        onClose={dialogs.close}
        onSend={() => {
          desk
            .send(task.id)
            .then((receipt) => showToast(`Sent: ${receipt}`, 3000))
            .catch((err: unknown) =>
              showToast(`Not sent: ${errorMessage(err)}`, 6000, "error"),
            );
        }}
      />
    ));
  }

  function redraft(task: TaskRow) {
    dialogs.show(() => (
      <PromptModal
        title="Ask for a different draft"
        placeholder="What should change? (shorter, mention the deadline...)"
        onSubmit={(text) => desk.redraft(task.id, text)}
        onClose={dialogs.close}
      />
    ));
  }

  // The engine records the line and hands it on; a coding claude gets it
  // typed into its tmux window, which the embedded viewer shows.
  function say(task: TaskRow, text: string) {
    void desk.say(task.id, text);
  }

  // ── on an FYI / an idea ───────────────────────────────────────────────

  function makeTask(item: RailItem) {
    if (item.type === "fyi") {
      const task = desk.fyiToTask(item.message.id);
      if (task) {
        aug.selectTask(task.id);
        showToast(`${store.taskRef(task.id)}: it was work; triage will learn`);
      }
    } else if (item.type === "idea") {
      const task = desk.ideaToTask(item.idea.id);
      if (task) {
        aug.selectTask(task.id);
        showToast(`${store.taskRef(task.id)} on your list`);
      }
    }
  }

  function dismiss(item: RailItem) {
    advanceFrom(item.key);
    if (item.type === "fyi") desk.readFyi(item.message.id);
    if (item.type === "idea") desk.dismissIdea(item.idea.id);
  }

  function walk(direction: 1 | -1) {
    const current = aug.selected();
    if (direction === 1 && current) {
      if (current.type === "fyi") desk.readFyi(current.message.id);
      if (current.type === "idea") desk.dismissIdea(current.idea.id);
      if (current.type === "task" && current.task.unread_result)
        desk.readResult(current.task.id);
    }
    const key = aug.walk(direction);
    if (!key)
      showToast(
        direction === 1
          ? "That's everything. All walked."
          : "Nothing before this",
      );
  }

  function newTask() {
    const ask = (kind: Kind, label: string) => ({
      label,
      run: () =>
        dialogs.show(() => (
          <PromptModal
            title={label}
            placeholder={
              kind === Kind.task ? "What do you need to do?" : "What's the job?"
            }
            onSubmit={(title) => {
              const task = desk.newTask(title, kind);
              aug.setMode(ViewMode.chat);
              aug.selectTask(task.id);
              if (kind === Kind.general)
                void desk.startAgent(task.id, { note: title });
            }}
            onClose={dialogs.close}
          />
        )),
    });
    dialogs.show(() => (
      <ChoiceModal
        title="New"
        choices={[
          ask(Kind.general, "Give an agent a job"),
          ask(Kind.coding, "A coding job (press s to start it)"),
          ask(Kind.task, "A to-do of my own"),
        ]}
        onClose={dialogs.close}
      />
    ));
  }

  function docs() {
    dialogs.show(() => (
      <ChoiceModal
        title="Docs: what the models are told"
        hint="Opens in $EDITOR. SOUL.md always outranks LEARNED.md."
        choices={Object.values(DocName).map((name) => ({
          label: name,
          hint: DOC_PURPOSE[name],
          run: () => editor.openEditor(docPath(name), name),
        }))}
        onClose={dialogs.close}
      />
    ));
  }

  // Files the task's agent turns made, newest first, still on disk.
  function madeFiles(item: RailItem): MadeFile[] {
    if (item.type !== "task") return [];
    const seen = new Set<string>();
    const out: MadeFile[] = [];
    for (const turn of [...store.turnsForTask(item.task.id)].reverse()) {
      for (const f of parseFiles(turn.files)) {
        if (seen.has(f.path) || !existsSync(f.path)) continue;
        seen.add(f.path);
        out.push(f);
      }
    }
    return out;
  }

  function open(target: string) {
    try {
      openTarget(target);
    } catch (err) {
      showToast(`Could not open: ${errorMessage(err)}`, 5000, "error");
    }
  }

  // o: the link, or a pick of the thread, the links attached to the task,
  // and what the agent made.
  function openLink(item: RailItem) {
    const url =
      item.type === "task"
        ? item.task.url
        : item.type === "fyi"
          ? item.message.url
          : null;
    const links = item.type === "task" ? store.linksForTask(item.task.id) : [];
    const short = (u: string) => u.replace(/^https?:\/\//, "").slice(0, 30);
    const choices = [
      ...(url
        ? [{ label: "The thread", hint: short(url), run: () => open(url) }]
        : []),
      ...links.map((l) => ({
        label: l.title ?? short(l.url),
        hint: l.title ? short(l.url) : undefined,
        run: () => open(l.url),
      })),
      ...madeFiles(item).map((f) => ({
        label: f.name,
        hint: formatBytes(f.bytes),
        run: () => open(f.path),
      })),
    ];
    if (choices.length === 0) {
      showToast("No link on this one");
      return;
    }
    if (choices.length === 1) {
      choices[0].run();
      return;
    }
    dialogs.show(() => (
      <ChoiceModal
        title="Open"
        hint={`With ${openerArgv("…").slice(0, -1).join(" ")} (set "opener" in config).`}
        choices={choices}
        onClose={dialogs.close}
      />
    ));
  }

  // O: a file the agent made, in $EDITOR on the table.
  function editFile(item: RailItem) {
    const files = madeFiles(item);
    if (files.length === 0) {
      showToast("The agent has not made any files here");
      return;
    }
    const edit = (f: MadeFile) => editor.openEditor(f.path, f.name);
    if (files.length === 1) {
      edit(files[0]);
      return;
    }
    dialogs.show(() => (
      <ChoiceModal
        title="Edit in $EDITOR"
        choices={files.map((f) => ({
          label: f.name,
          hint: formatBytes(f.bytes),
          run: () => edit(f),
        }))}
        onClose={dialogs.close}
      />
    ));
  }

  function info(item: RailItem) {
    dialogs.show(() => (
      <InfoModal
        title={infoTitle(item)}
        sections={itemInfo(item)}
        onCopied={(label, ok) =>
          ok
            ? showToast(`Copied the ${label}`)
            : showToast("No clipboard here", 3000, "error")
        }
        onOpen={open}
        onClose={dialogs.close}
      />
    ));
  }

  // The key handlers for a row, given how to find it.
  function taskActions(
    get: () => RailItem | null,
    typeInto: () => void,
  ): TaskActions {
    // Home is a conversation, not work: only typing, start/stop and info
    // reach it.
    const onTask =
      (fn: (t: TaskRow) => false | void, home = false) =>
      () => {
        const item = get();
        if (item?.type !== "task") return false;
        const fresh = store.getTask(item.task.id);
        if (!fresh || (fresh.kind === Kind.home && !home)) return false;
        return fn(fresh);
      };
    return {
      [Commands.SEND]: onTask(send),
      // Share e; each declines when the other applies.
      [Commands.EDIT_DRAFT]: onTask(editor.editDraft),
      [Commands.EDIT_BRIEF]: onTask(editor.editBrief),
      [Commands.REDRAFT]: onTask(redraft),
      [Commands.START]: onTask(start, true),
      [Commands.STOP]: onTask(stop, true),
      [Commands.JUMP]: () => {
        const item = get();
        if (item?.type === "project") return void jumpToProject(item.project.id);
        return onTask((task) => void jumpTo(task.id))();
      },
      [Commands.NUDGE]: onTask((task) => void nudge(task.id)),
      [Commands.MOVE_TO_PROJECT]: onTask(moveToProject),
      [Commands.DONE]: onTask(done),
      [Commands.REMIND]: onTask(remind),
      [Commands.WATCH]: onTask(watch),
      [Commands.PRIORITY]: onTask(cyclePriority),
      [Commands.KIND]: onTask(changeKind),
      [Commands.WAIT_ON]: onTask(waitOn),
      [Commands.TYPE]: onTask(() => typeInto(), true),
      [Commands.NOT_TASK]: () => {
        const item = get();
        if (!item) return false;
        if (item.type === "task" && item.task.kind === Kind.home) return false;
        if (item.type === "project") return false;
        if (item.type === "task") notATask(item.task);
        else dismiss(item);
      },
      // Shares x with not-a-task; each declines the other's rows.
      [Commands.PROJECT_ARCHIVE]: () => {
        const item = get();
        if (item?.type !== "project") return false;
        archiveProject(item.project.id);
      },
      [Commands.MAKE_TASK]: () => {
        const item = get();
        if (item && item.type !== "task") makeTask(item);
      },
      [Commands.EDIT_FILE]: () => {
        const item = get();
        if (item) editFile(item);
      },
      [Commands.OPEN_URL]: () => {
        const item = get();
        if (item) openLink(item);
      },
      [Commands.INFO]: () => {
        const item = get();
        if (!item) return false;
        info(item);
      },
    };
  }

  return {
    startAgent,
    jumpTo,
    nudge,
    newProject,
    adoptProject,
    moveToProject,
    archiveProject,
    jumpToProject,
    openEditor: editor.openEditor,
    start,
    stop,
    done,
    send,
    say,
    compose: editor.compose,
    walk,
    newTask,
    docs,
    taskActions,
    editorId: editor.editorId,
  };
}

export type Actions = ReturnType<typeof useActions>;
