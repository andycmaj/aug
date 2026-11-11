// Every move the owner makes, once: the rail row, the table, the Board and
// the palette all call these. They talk to the engine, open dialogs, and keep
// the table moving (a row that leaves the rail hands the table to the next).

import { createEffect, createSignal, type Accessor, type JSX } from "solid-js";
import { writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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
import { actionText } from "../core/outbound";
import { paths } from "../core/paths";
import * as projects from "../core/projects";
import { claudeSettingsPath, hooksInstalled, installHooks } from "../core/adopt";
import { loadConfig } from "../core/config";
import { neighborKey, type RailItem } from "../core/rail";
import * as store from "../core/store";
import {
  AgentState,
  Kind,
  Priority,
  SessionKind,
  type TaskRow,
} from "../core/types";
import {
  ChoiceModal,
  ConfirmSendModal,
  InfoModal,
  PromptModal,
} from "./modals";
import type { ItemMoves } from "./moves";

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

const EDITOR_ID = "editor";

// Both modes mount the actions; one viewer attach per task at a time.
const attaching = new Set<number>();
// Tasks whose window aug runs in (no viewer for those), told once.
const refused = new Set<number>();

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function useActions(dialogs: Dialogs) {
  const aug = useAug();
  const terminals = useTerminals();
  const { setActivePane } = useFocus();
  const { showToast } = useToast();
  const engine = aug.engine;

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

  // ── coding terminals ──────────────────────────────────────────────────

  function startCoding(taskId: number, note?: string) {
    const task = store.getTask(taskId);
    if (!task) return;
    const show = () => {
      if (aug.mode() === ViewMode.chat) {
        aug.selectTask(taskId);
        setActivePane("task");
      }
    };
    if (terminals.forTask(taskId)?.running) return show();
    // Resuming never asks again: the first start settled repo and branch.
    const resuming = store.latestSession(taskId)?.kind === SessionKind.tmux;
    if (!engine.makesWorktrees || resuming)
      return void launchCoding(taskId, { note });
    if (!task.repo && !task.worktree) return askRepo(task, note);
    const repoPath = projects.repoPath(task.repo);
    if (task.repo && !repoPath && !task.worktree) return askRepoPath(task, note);
    if (task.repo && repoPath && !task.worktree) {
      dialogs.show(() => (
        <PromptModal
          title={`Branch for ${store.taskRef(taskId)}`}
          hint="A new branch gets a worktree of its own. An existing branch or pr:N works too."
          initial={task.branch ?? projects.defaultBranch(task)}
          onSubmit={(branch) => void launchCoding(taskId, { note, branch })}
          onClose={dialogs.close}
        />
      ));
      return;
    }
    void launchCoding(taskId, { note });
  }

  // A coding task you made has no repo: pick one, then the usual questions
  // (where it is checked out, which branch) follow.
  function askRepo(task: TaskRow, note?: string) {
    const use = (repo: string) => {
      try {
        engine.setTaskRepo(task.id, repo);
      } catch (err) {
        showToast(errText(err), 4000, "error");
        return;
      }
      startCoding(task.id, note);
    };
    dialogs.show(() => (
      <ChoiceModal
        title={`Which repo is ${store.taskRef(task.id)} in?`}
        hint="It gets a worktree and a branch there."
        choices={[
          ...projects.repoChoices(task).map((repo) => ({
            label: repo,
            run: () => use(repo),
          })),
          {
            label: "Another repo (owner/repo)...",
            run: () =>
              dialogs.show(() => (
                <PromptModal
                  title="Which repo?"
                  hint="As GitHub names it: owner/repo."
                  placeholder="andycmaj/aug"
                  onSubmit={use}
                  onClose={dialogs.close}
                />
              )),
          },
          {
            label: "No repo: a scratch folder",
            run: () => void launchCoding(task.id, { note, noWorktree: true }),
          },
        ]}
        onClose={dialogs.close}
      />
    ));
  }

  // An unmapped repo: ask once where it lives; Esc works in scratch instead.
  function askRepoPath(task: TaskRow, note?: string) {
    let submitted = false;
    dialogs.show(() => (
      <PromptModal
        title={`Where is ${task.repo} checked out?`}
        hint="Saved to config. Esc starts it in a scratch folder with no worktree."
        placeholder="/path/to/checkout"
        onSubmit={(path) => {
          submitted = true;
          projects.mapRepo(task.repo!, path.trim().replace(/^~/, homedir()));
          startCoding(task.id, note);
        }}
        onClose={() => {
          dialogs.close();
          // onSubmit runs right after onClose; only a bare Esc gets here.
          queueMicrotask(() => {
            if (!submitted) void launchCoding(task.id, { note, noWorktree: true });
          });
        }}
      />
    ));
  }

  async function launchCoding(
    taskId: number,
    opts: { note?: string; branch?: string; noWorktree?: boolean },
  ) {
    const prior = store.latestSession(taskId);
    const resume =
      prior?.kind === SessionKind.pty || prior?.kind === SessionKind.tmux
        ? prior.id
        : undefined;
    showToast(`Starting ${store.taskRef(taskId)}...`);
    const result = await engine.startCoding(taskId, {
      ...opts,
      branch: opts.branch?.trim() || undefined,
      resume,
    });
    if (result.type === "needs-repo-path") {
      const task = store.getTask(taskId);
      if (task) askRepoPath(task, opts.note);
      return;
    }
    if (result.type === "failed") {
      showToast(`Could not start: ${result.error}`, 4000, "error");
      return;
    }
    await attachViewer(taskId);
    if (aug.mode() === ViewMode.chat) {
      aug.selectTask(taskId);
      setActivePane("task");
    }
  }

  // The embedded terminal is a tmux client on the task's window; closing it
  // detaches, and the claude keeps running.
  async function attachViewer(taskId: number): Promise<boolean> {
    if (terminals.forTask(taskId)?.running) return true;
    if (attaching.has(taskId)) return false;
    attaching.add(taskId);
    try {
      const viewer = await projects.viewerArgv(taskId);
      if (viewer && "refused" in viewer) {
        if (!refused.has(taskId)) showToast(viewer.refused, 6000, "error");
        refused.add(taskId);
        return false;
      }
      if (!viewer || terminals.forTask(taskId)?.running) return Boolean(viewer);
      const { argv } = viewer;
      const id = `view-${taskId}`;
      terminals.close(id);
      terminals.open({
        id,
        title: store.taskRef(taskId),
        kind: "agent",
        taskId,
        argv,
      });
      return true;
    } finally {
      attaching.delete(taskId);
    }
  }

  // ── projects ──────────────────────────────────────────────────────────

  // The first project you make or adopt offers the hooks that pick up
  // claudes you start by hand. Asked once; `aug hooks` is there after.
  function offerHooks() {
    if (engine.offline || hooksInstalled() || store.kvGet("hooks.offered"))
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
                showToast(`Could not install: ${errText(err)}`, 4000, "error");
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
      void engine.createProject(name, repo).then(
        (p) => {
          showToast(`Project ${p.name}: tmux session ${p.tmux_session}`);
          then?.(p.id);
          offerHooks();
        },
        (err) => showToast(`Could not create: ${errText(err)}`, 4000, "error"),
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
    let sessions: Awaited<ReturnType<typeof engine.adoptableSessions>>;
    try {
      sessions = await engine.adoptableSessions();
    } catch (err) {
      showToast(`tmux: ${errText(err)}`, 4000, "error");
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
            void engine.adoptSession(s.id).then(
              (p) => {
                showToast(`Project ${p.name}`);
                offerHooks();
              },
              (err) => showToast(`Could not adopt: ${errText(err)}`, 4000, "error"),
            ),
        }))}
        onClose={dialogs.close}
      />
    ));
  }

  function moveToProject(task: TaskRow) {
    const move = (projectId: number) =>
      void engine.moveTask(task.id, projectId).then(
        () => showToast(`${store.taskRef(task.id)} moved`),
        (err) => showToast(`Could not move: ${errText(err)}`, 4000, "error"),
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
              void engine.archiveProject(projectId).then(
                () => showToast(`${project.name} archived`),
                (err) => showToast(`Could not archive: ${errText(err)}`, 4000, "error"),
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
      await engine.jumpToProject(projectId);
    } catch (err) {
      showToast(`Could not jump: ${errText(err)}`, 4000, "error");
    }
  }

  async function nudge(taskId: number) {
    try {
      showToast(
        (await engine.nudge(taskId))
          ? `${store.taskRef(taskId)}: nudged`
          : "Its window is gone; s starts it again",
      );
    } catch (err) {
      showToast(`Could not nudge: ${errText(err)}`, 4000, "error");
    }
  }

  async function jumpTo(taskId: number) {
    try {
      if (!(await projects.jump(taskId)))
        showToast("Its window is gone; s starts it again");
    } catch (err) {
      showToast(`Could not jump: ${errText(err)}`, 4000, "error");
    }
  }

  // $EDITOR in an embedded terminal on the table; done runs when it exits.
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

  // ── on a task ─────────────────────────────────────────────────────────

  function start(task: TaskRow) {
    if (task.kind === Kind.home) return;
    if (task.kind === Kind.coding) startCoding(task.id);
    else {
      engine.startGeneral(task.id);
      showToast(`${store.taskRef(task.id)}: agent started`);
    }
  }

  function stop(task: TaskRow) {
    const live = terminals.forTask(task.id);
    if (live?.running) terminals.close(live.id);
    if (task.kind === Kind.coding) {
      void engine
        .stopCoding(task.id)
        .catch((err) => showToast(`Could not stop: ${errText(err)}`, 4000, "error"));
    } else engine.stopAgent(task.id);
    showToast(`${store.taskRef(task.id)}: stopped and saved`);
  }

  function done(task: TaskRow) {
    const live = terminals.forTask(task.id);
    if (live?.running) terminals.close(live.id);
    advanceFrom(`t${task.id}`);
    if (task.kind !== Kind.coding) {
      engine.markDone(task.id);
      showToast(`${store.taskRef(task.id)} done`);
      return;
    }
    void engine.closeCoding(task.id).then(
      (r) =>
        showToast(
          r.warnings.length
            ? `${store.taskRef(task.id)} done; ${r.warnings.join("; ")}`
            : `${store.taskRef(task.id)} done${r.archived ? ", project archived" : ""}`,
          r.warnings.length ? 5000 : 2000,
          r.warnings.length ? "error" : "info",
        ),
      (err) => showToast(`Closing: ${errText(err)}`, 4000, "error"),
    );
  }

  // Keeps the table's terminal in step with tmux: a live claude on the
  // selected task gets a viewer, and a viewer whose claude ended goes.
  createEffect(() => {
    aug.version();
    const item = aug.selected();
    const task = item?.type === "task" ? item.task : null;
    for (const term of terminals.list()) {
      if (!term.id.startsWith("view-") || term.taskId === undefined) continue;
      const latest = store.latestSession(term.taskId);
      if (latest?.ended_at) terminals.close(term.id);
    }
    if (!task || task.kind !== Kind.coding) return;
    const latest = store.latestSession(task.id);
    if (latest?.kind !== SessionKind.tmux || latest.ended_at) return;
    void attachViewer(task.id);
  });

  function remind(task: TaskRow) {
    const pick = (label: string, days: number) => ({
      label,
      run: () => {
        advanceFrom(`t${task.id}`);
        const at = engine.remind(task.id, days);
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
    engine.watch(task.id, !task.watching);
    showToast(
      task.watching ? "Back in Tasks" : "Watching: not yours, kept open",
    );
  }

  function notATask(task: TaskRow) {
    advanceFrom(`t${task.id}`);
    engine.notATask(task.id);
    showToast("Not a task: triage will learn from it");
  }

  function cyclePriority(task: TaskRow) {
    const order: Priority[] = [
      Priority.regular,
      Priority.important,
      Priority.urgent,
    ];
    const next = order[(order.indexOf(task.priority) + 1) % order.length];
    engine.setPriority(task.id, next);
    showToast(`${store.taskRef(task.id)} is ${next}`);
  }

  function changeKind(task: TaskRow) {
    const pick = (kind: Kind, hint: string) => ({
      label: kind,
      hint,
      run: () => engine.setKind(task.id, kind),
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
        onSubmit={(who) => engine.waitOn(task.id, who)}
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
          engine
            .send(task.id)
            .then((receipt) => showToast(`Sent: ${receipt}`, 3000))
            .catch((err: unknown) =>
              showToast(`Not sent: ${errText(err)}`, 6000, "error"),
            );
        }}
      />
    ));
  }

  function editDraft(task: TaskRow): false | void {
    const pending = store.pendingAction(task.id);
    if (!pending) return false;
    const file = join(paths.drafts(), `${store.taskRef(task.id)}.md`);
    writeFileSync(file, actionText(pending.action));
    openEditor(file, `draft for ${store.taskRef(task.id)}`, () => {
      if (!existsSync(file)) return;
      const text = readFileSync(file, "utf8").trimEnd();
      if (text && engine.editDraft(task.id, text)) showToast("Draft updated");
    });
  }

  // The brief in $EDITOR, while the agent has not started from it yet.
  function editBrief(task: TaskRow): false | void {
    if (!engine.briefEditable(task.id)) return false;
    const ref = store.taskRef(task.id);
    const file = join(paths.drafts(), `${ref}-brief.md`);
    writeFileSync(file, task.summary ? `${task.summary}\n` : "");
    openEditor(file, `brief for ${ref}`, () => {
      if (!existsSync(file)) return;
      const text = readFileSync(file, "utf8").trim();
      rmSync(file, { force: true });
      if (text === task.summary.trim()) return;
      if (engine.editBrief(task.id, text)) showToast(`${ref}: brief updated`);
      else if (!text) showToast("An empty brief was not saved", 3000, "error");
    });
  }

  function redraft(task: TaskRow) {
    dialogs.show(() => (
      <PromptModal
        title="Ask for a different draft"
        placeholder="What should change? (shorter, mention the deadline...)"
        onSubmit={(text) => engine.redraft(task.id, text)}
        onClose={dialogs.close}
      />
    ));
  }

  function say(task: TaskRow, text: string) {
    const live = terminals.forTask(task.id);
    if (live?.running) {
      // Tell the agent: the line goes to its prompt as if typed.
      terminals.write(live.id, text.replace(/\n/g, " "));
      setTimeout(() => terminals.write(live.id, "\r"), 30);
      store.addTurn({
        taskId: task.id,
        role: "you",
        author: "you",
        body: text,
      });
      return;
    }
    void engine.say(task.id, text);
  }

  // ── on an FYI / an idea ───────────────────────────────────────────────

  function makeTask(item: RailItem) {
    if (item.type === "fyi") {
      const task = engine.fyiToTask(item.message.id);
      if (task) {
        aug.selectTask(task.id);
        showToast(`${store.taskRef(task.id)}: it was work; triage will learn`);
      }
    } else if (item.type === "idea") {
      const task = engine.ideaToTask(item.idea.id);
      if (task) {
        aug.selectTask(task.id);
        showToast(`${store.taskRef(task.id)} on your list`);
      }
    }
  }

  function dismiss(item: RailItem) {
    advanceFrom(item.key);
    if (item.type === "fyi") engine.readFyi(item.message.id);
    if (item.type === "idea") engine.dismissIdea(item.idea.id);
  }

  // Next on an FYI, an idea or an agent's finished result reads it: off the rail.
  // The chat box in $EDITOR. Save and quit sends; quitting empty or with an
  // error (vim's :cq) sends nothing and hands the text back to the box.
  function compose(
    task: TaskRow,
    initial: string,
    keep: (text: string) => void,
  ) {
    const file = join(paths.drafts(), `${store.taskRef(task.id)}-message.md`);
    writeFileSync(file, initial);
    openEditor(file, `a message on ${store.taskRef(task.id)}`, (code) => {
      const text = existsSync(file)
        ? readFileSync(file, "utf8").trimEnd()
        : initial;
      rmSync(file, { force: true });
      if (code === 0 && text.trim()) {
        say(task, text);
        return;
      }
      keep(text);
      setTimeout(() => setActivePane("input"), 0);
    });
  }

  function walk(direction: 1 | -1) {
    const current = aug.selected();
    if (direction === 1 && current) {
      if (current.type === "fyi") engine.readFyi(current.message.id);
      if (current.type === "idea") engine.dismissIdea(current.idea.id);
      if (current.type === "task" && current.task.unread_result)
        engine.readResult(current.task.id);
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
              const task = engine.newTask(title, kind);
              aug.setMode(ViewMode.chat);
              aug.selectTask(task.id);
              if (kind === Kind.general) engine.startGeneral(task.id, title);
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
          run: () => openEditor(docPath(name), name),
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
      showToast(`Could not open: ${errText(err)}`, 5000, "error");
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
    const edit = (f: MadeFile) => openEditor(f.path, f.name);
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
        onClose={dialogs.close}
      />
    ));
  }

  // The key handlers for an item, given how to find it.
  function itemMoves(
    get: () => RailItem | null,
    typeInto: () => void,
  ): ItemMoves {
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
      [Commands.EDIT_DRAFT]: onTask(editDraft),
      [Commands.EDIT_BRIEF]: onTask(editBrief),
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
    startCoding,
    jumpTo,
    nudge,
    newProject,
    adoptProject,
    moveToProject,
    archiveProject,
    jumpToProject,
    openEditor,
    start,
    stop,
    done,
    send,
    say,
    compose,
    walk,
    newTask,
    docs,
    itemMoves,
    editorId: EDITOR_ID,
  };
}

export type Actions = ReturnType<typeof useActions>;
