// Every action the owner takes on a row, once: the rail, the Canvas, the
// Board and the palette all call these. They ask the desk, open dialogs,
// toast the outcome, and keep the selection moving (a row that leaves the
// rail hands the selection to the next). Starting an agent, the editor and the
// embedded viewer each have a hook of their own beside this one.

import { createSignal, type Accessor, type JSX } from "solid-js";
import { existsSync, readFileSync } from "node:fs";
import { copyToClipboard, useFocus, useToast } from "@andycmaj/opentui-app";
import { Commands } from "../commands";
import { useRiker, ViewMode } from "../context/riker";
import { useTerminals } from "../context/terminals";
import {
  ARCHIVE,
  DOC_PURPOSE,
  docBudget,
  DocName,
  docPath,
  docSize,
  overBudget,
} from "@riker/core/docs";
import {
  formatBytes,
  openerArgv,
  openTarget,
  parseFiles,
  type MadeFile,
} from "@riker/core/files";
import { journalSwitch, storySwitchOf, SwitchValue } from "@riker/core/digests";
import { infoTitle, itemInfo } from "@riker/core/info";
import { journalMarkdown } from "@riker/core/journal";
import { storyMarkdown } from "@riker/core/story";
import { errorMessage, logger } from "@riker/core/log";
import { claudeSettingsPath, hooksInstalled, installHooks } from "@riker/core/adopt";
import { strayLabel, type Stray } from "@riker/core/strays";
import { baseKey, neighborKey, type RailItem } from "@riker/core/rail";
import { actionAnswers, isClosed, taskRef } from "@riker/core/rows";
import { postComments } from "@riker/code-review-plannotator/guide";
import { OPEN_REVIEW_TITLE } from "@riker/core/guide-turn";
import type { ActionResult } from "@riker/core/run-action";
import {
  ActionOutput,
  ActionVia,
  actionNamed,
  actionsFor,
  keyedActions,
  makesCheckout,
} from "@riker/core/task-actions";
import { describeProblem } from "@riker/core/repos";
import { actionCommand, actionKeys, buildKeymap } from "../keymap";
import type { NoiseRule } from "@riker/core/config";
import { NoJump, type Jump } from "@riker/core/desk";
import { clip as inboxClip, InboxResult, rowMessages, type InboxRow } from "@riker/core/inbox";
import { messageMeta } from "@riker/core/meta";
import { Kind, Priority, type MessageRow, type TaskRow } from "@riker/core/types";
import {
  ActionAnswerModal,
  ChoiceModal,
  ConfirmSendModal,
  InfoModal,
  PromptModal,
  ReaderModal,
} from "./modals";
import { chatHidden } from "./canvas";
import { dayClock } from "./ui";
import { actionTermId, type TaskActions } from "./task-actions";
import { useAgentStart } from "./use-agent-start";
import { useEditor } from "./use-editor";
import { useDocReview } from "./use-doc-review";
import { usePrDash } from "./use-pr-dash";
import { useRepos } from "./use-repos";
import { useViewer } from "./use-viewer";

const log = logger("actions");

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
  const riker = useRiker();
  const terminals = useTerminals();
  const { showToast } = useToast();
  const { setActivePane } = useFocus();
  const desk = riker.desk;
  const editor = useEditor();
  const { attachViewer } = useViewer();
  const { togglePrDash } = usePrDash();
  const { reviewDocs } = useDocReview();
  const { startAgent } = useAgentStart(dialogs, attachViewer);
  const { showRepos, pathChoices } = useRepos(dialogs);

  // A task's rows are about to leave the rail. Selected: the selection
  // walks on. Only under the cursor: the cursor steps to a neighbor (not
  // the task's other row), the selection stays.
  function advanceFrom(key: string) {
    if (riker.selectedKey() === key) {
      const next = riker.walk(1) ?? riker.walk(-1);
      if (!next) riker.select(null);
      return;
    }
    const cursor = riker.cursorKey();
    if (cursor && baseKey(cursor) === key) {
      riker.moveCursor(
        neighborKey(
          riker
            .shownItems()
            .map((i) => i.key)
            .filter((k) => k === cursor || baseKey(k) !== key),
          cursor,
        ),
      );
    }
  }

  // ── projects ──────────────────────────────────────────────────────────

  // The first project you make or adopt offers the hooks that pick up
  // claudes you start by hand. Asked once; `riker hooks` is there after.
  function offerHooks() {
    if (desk.offline || hooksInstalled() || !desk.offerHooksOnce()) return;
    dialogs.show(() => (
      <ChoiceModal
        title="Pick up claudes you start by hand?"
        hint={`Adds hooks to ${claudeSettingsPath()} that only act inside a project's tmux session. Undo with: riker uninstall hooks`}
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
    const repos = Object.keys(desk.config().repos);
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

  // A tmux session becomes a project; a claude started outside Riker becomes
  // a task in one. The project it joins comes first when you are on it.
  async function adopt(projectId?: number) {
    let sessions: Awaited<ReturnType<typeof desk.adoptableSessions>>;
    let strays: Stray[];
    try {
      [sessions, strays] = await Promise.all([desk.adoptableSessions(), desk.strays()]);
    } catch (err) {
      showToast(`tmux: ${errorMessage(err)}`, 4000, "error");
      return;
    }
    if (sessions.length === 0 && strays.length === 0) {
      showToast("No stray claudes, and every tmux session is a project already");
      return;
    }
    dialogs.show(() => (
      <ChoiceModal
        title="Adopt"
        hint="A claude becomes a task (its window moves into the project). A session becomes a project."
        choices={[
          ...strays.map((s) => ({
            label: `claude  ${strayLabel(s)}`,
            run: () => adoptClaude(s, projectId),
          })),
          ...sessions.map((s) => ({
            label: `session ${s.name}`,
            run: () =>
              void desk.adoptSession(s.id).then(
                (p) => {
                  showToast(`Project ${p.name}`);
                  offerHooks();
                },
                (err) => showToast(`Could not adopt: ${errorMessage(err)}`, 4000, "error"),
              ),
          })),
        ]}
        onClose={dialogs.close}
      />
    ));
  }

  function adoptClaude(stray: Stray, projectId?: number) {
    const into = (id: number) =>
      void desk.adoptStray(stray, id).then(
        (task) => {
          showToast(
            stray.pane
              ? `${taskRef(task.id)} ${task.title}`
              : `${taskRef(task.id)}: quit that claude, then s continues it here`,
            stray.pane ? 3000 : 6000,
          );
          riker.selectTask(task.id);
          offerHooks();
        },
        (err) => showToast(`Could not adopt: ${errorMessage(err)}`, 4000, "error"),
      );
    const active = riker.projects().filter((p) => p.status === "active");
    const ordered = [
      ...active.filter((p) => p.id === projectId),
      ...active.filter((p) => p.id !== projectId),
    ];
    dialogs.show(() => (
      <ChoiceModal
        title={`Adopt ${strayLabel(stray)} into`}
        hint={stray.pane ? "Its claude keeps running." : "It is outside tmux: s resumes it in the project once you quit it."}
        choices={[
          ...ordered.map((p) => ({ label: p.name, run: () => into(p.id) })),
          { label: "new project…", run: () => newProject(into) },
        ]}
        onClose={dialogs.close}
      />
    ));
  }

  function moveToProject(task: TaskRow) {
    const move = (projectId: number) =>
      void desk.moveTask(task.id, projectId).then(
        () => showToast(`${taskRef(task.id)} moved`),
        (err) => showToast(`Could not move: ${errorMessage(err)}`, 4000, "error"),
      );
    const others = riker.projects().filter((p) => p.id !== task.project_id);
    dialogs.show(() => (
      <ChoiceModal
        title={`Move ${taskRef(task.id)} to a project`}
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
    const project = riker.project(projectId);
    if (!project) return;
    const open = riker
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

  // Riker with no client of the agents' server has none to move: why, where
  // else it shows, and the line that opens it (copied, to paste).
  function jumped(outcome: Jump, gone: string, here?: string) {
    if (outcome === "gone") return showToast(gone);
    if (outcome === "jumped") return;
    void copyToClipboard(outcome.attach).then((ok) => {
      const run = `In a terminal run${ok ? " (copied)" : ""}: ${outcome.attach}`;
      const also = here ? ` ${here}.` : "";
      const why =
        outcome.why === NoJump.outside
          ? "Riker is not in tmux, so it has no client to jump."
          : outcome.why === NoJump.lost
            ? `Riker's tmux server lost its socket (${outcome.socket}) to a newer server, where its agents run, so it cannot jump. To jump again, run Riker in a client of that server (tmux attach).`
            : `Riker runs in another tmux server (${outcome.socket}) than its agents, so it cannot jump.`;
      showToast(`${why}${also} ${run}`, 15000);
    });
  }

  async function jumpToProject(projectId: number) {
    try {
      jumped(await desk.jumpToProject(projectId), "That project is gone");
    } catch (err) {
      showToast(`Could not jump: ${errorMessage(err)}`, 4000, "error");
    }
  }

  async function nudge(taskId: number) {
    try {
      showToast(
        (await desk.nudge(taskId))
          ? `${taskRef(taskId)}: nudged`
          : "Its window is gone; s starts it again",
      );
    } catch (err) {
      showToast(`Could not nudge: ${errorMessage(err)}`, 4000, "error");
    }
  }

  async function jumpTo(taskId: number) {
    try {
      jumped(
        await desk.jumpToTask(taskId),
        "Its window is gone; s starts it again",
        "The Canvas shows the agent here",
      );
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
      () => showToast(`${taskRef(task.id)}: stopped; s resumes it`),
      (err) => showToast(`Could not stop: ${errorMessage(err)}`, 4000, "error"),
    );
  }

  // d on a done or dropped row reopens it instead (reopen below). Work
  // whose PR has not landed asks first, No under the cursor.
  function done(task: TaskRow) {
    if (isClosed(task)) return false;
    const unmerged = riker.unmergedPr(task);
    if (!unmerged) return closeDone(task);
    dialogs.show(() => (
      <ChoiceModal
        title={`Mark ${taskRef(task.id)} done?`}
        hint={`${unmerged}. Mark it done anyway?`}
        choices={[
          { label: "No, keep it open", run: () => {} },
          { label: "Yes, mark it done", run: () => closeDone(task) },
        ]}
        onClose={dialogs.close}
      />
    ));
  }

  function closeDone(task: TaskRow) {
    const live = terminals.forTask(task.id);
    if (live?.running) terminals.close(live.id);
    advanceFrom(`t${task.id}`);
    void desk.close(task.id).then(
      (r) =>
        showToast(
          r.warnings.length
            ? `${taskRef(task.id)} done; ${r.warnings.join("; ")}`
            : `${taskRef(task.id)} done${r.archived ? ", project archived" : ""}`,
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
        title={`Remind me about ${taskRef(task.id)}`}
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

  // J flips what the row says now: an unset switch takes the opposite of
  // what it follows. `move story|journal ... default` clears it.
  function flipStory(task: TaskRow) {
    const now = storySwitchOf(desk.config(), task, task.project_id ? riker.project(task.project_id) : null);
    showToast(desk.setStory(task.id, now.on ? SwitchValue.off : SwitchValue.on), 3000);
  }

  function flipJournal(projectId: number) {
    const project = riker.project(projectId);
    if (!project) return;
    const now = journalSwitch(desk.config(), project);
    showToast(desk.setProjectSwitch(projectId, "journal", now.on ? SwitchValue.off : SwitchValue.on), 3000);
  }

  function win(task: TaskRow) {
    const said = desk.toggleWin(task.id);
    showToast(said.text, 3000, said.ok ? undefined : "error");
  }

  function acceptDocs(task: TaskRow) {
    showToast(riker.desk.acceptDocs(task.id), 4000);
  }

  function rejectDocs(task: TaskRow) {
    showToast(riker.desk.rejectDocs(task.id), 4000);
  }

  function reopen(task: TaskRow) {
    if (!isClosed(task)) return false;
    showToast(desk.reopen(task.id), 3000);
  }

  function ignore(task: TaskRow) {
    advanceFrom(`t${task.id}`);
    void desk.ignore(task.id);
    showToast(`Ignored ${taskRef(task.id)} · ctrl+z undoes`, 4000);
  }

  function cyclePriority(task: TaskRow) {
    const order: Priority[] = [
      Priority.regular,
      Priority.important,
      Priority.urgent,
    ];
    const next = order[(order.indexOf(task.priority) + 1) % order.length];
    desk.setPriority(task.id, next);
    showToast(`${taskRef(task.id)} is ${next}`);
  }

  // A task action: started now, its answer a turn on the task; the toast
  // says when it is back. One that reads the change on a task with no
  // worktree yet (a review that just arrived) has it made first, with no
  // agent started; an unmapped repo asks where it is, as Start does.
  function runAction(task: TaskRow, name: string, opts: { whole?: boolean } = {}): void {
    void launchAction(task, name, opts);
  }

  async function launchAction(task: TaskRow, name: string, opts: { whole?: boolean }) {
    const spec = actionNamed(desk.config(), name);
    if (spec && makesCheckout(spec, task))
      showToast(`${taskRef(task.id)}: making its worktree${task.branch ? ` on ${task.branch}` : ""}...`);
    const ready = await desk.prepareAction(task.id, name);
    if (ready.type === "failed") {
      showToast(ready.error, 5000, "error");
      return;
    }
    if (ready.type === "needs") {
      const retry = () => runAction(riker.task(task.id) ?? task, name, opts);
      dialogs.show(() => (
        <ChoiceModal
          title={
            ready.need.problem.kind === "unmapped"
              ? `Where is ${ready.need.repo} checked out?`
              : `${ready.need.repo}: ${describeProblem(ready.need.repo, ready.need.problem)}`
          }
          hint={`${spec?.title ?? name} reads the change in a worktree made from this checkout.`}
          choices={pathChoices({ ...ready.need, mapped: false }, retry)}
          wide
          onClose={dialogs.close}
        />
      ));
      return;
    }
    const started = desk.runAction(task.id, name, opts);
    if ("error" in started) {
      showToast(started.error, 5000, "error");
      return;
    }
    showToast(`${started.title}: running on ${taskRef(task.id)}`, 3000);
    void started.done.then((r) => {
      showToast(r.text, r.ok ? 4000 : 6000, r.ok ? "info" : "error");
      // A pane action: shown where the owner can answer it.
      if (r.terminal) openActionTerminal(task, started.title, r.terminal);
      else if (r.pane) {
        goToTask(task.id);
        void attachViewer(task.id);
      }
      // Its answer is a turn in the chat; where the Canvas shows the agent
      // instead (a coding task's live window), it opens over it.
      else if (r.ok && started.turnId !== undefined && answerHidden(task.id))
        readAnswer(task.id, started.turnId);
    });
  }

  function answerHidden(taskId: number): boolean {
    const now = riker.task(taskId);
    return !!now && chatHidden(terminals, now);
  }

  // A task action's answer, over the Canvas: no run.
  function readAnswer(taskId: number, turnId: number) {
    dialogs.show(() => (
      <ActionAnswerModal
        taskId={taskId}
        turnId={turnId}
        onCopied={(ok) => showToast(ok ? "Answer copied" : "Copy failed", 2000, ok ? "info" : "error")}
        onClose={dialogs.close}
      />
    ));
  }

  // The last guide's review, with its findings posted again: no model run.
  function openGuideReview(task: TaskRow) {
    const opened = desk.guideReview(task.id);
    if ("error" in opened) {
      showToast(opened.error, 5000, "error");
      return;
    }
    showToast(opened.text, 4000);
    if (opened.terminal) openActionTerminal(task, OPEN_REVIEW_TITLE, opened.terminal);
  }

  // A pane action with no agent window: interactive claude on the Canvas,
  // closed when it exits.
  function openActionTerminal(
    task: TaskRow,
    title: string,
    run: NonNullable<ActionResult["terminal"]>,
  ) {
    const id = actionTermId(task.id);
    goToTask(task.id);
    terminals.close(id);
    terminals.open({
      id,
      title: `${taskRef(task.id)} ${title}`,
      kind: "review",
      taskId: task.id,
      argv: run.argv,
      cwd: run.cwd,
      env: run.env,
      onExit: () => {
        terminals.close(id);
        if (riker.selectedKey() === `t${task.id}`) setActivePane("canvas");
        if (run.feedback) afterReview(task, run.feedback, run.posts);
      },
    });
    setTimeout(() => setActivePane("canvas"), 0);
    if (run.comments)
      void postComments(run.comments.port, run.comments.list).then((r) => {
        if ("error" in r) showToast(`Review notes not posted to Plannotator: ${r.error}`, 6000, "error");
      });
  }

  // How the owner ended plannotator review (desk.finishReview): a review
  // posted to GitHub closes its task; notes go to the agent, resumed if its
  // session ended; a bare Approve sends nothing.
  function afterReview(task: TaskRow, file: string, posts: "github" | undefined) {
    const output = existsSync(file) ? readFileSync(file, "utf8") : "";
    desk.finishReview(task.id, posts, output).then(
      (said) => {
        if (said) showToast(said.text, 6000, said.failed ? "error" : undefined);
      },
      (err) => showToast(`Review notes not sent: ${errorMessage(err)}`, 5000, "error"),
    );
  }

  // The action keys bound at start (app.tsx builds the keymap from the same).
  const keys = (() => {
    const config = desk.config();
    const { bound } = actionKeys(keyedActions(config), buildKeymap(config.keys));
    return new Set(bound.map((a) => a.name));
  })();

  // .: the actions that apply to this task.
  function pickAction(task: TaskRow): false | void {
    const offered = actionsFor(desk.config(), task);
    const review = desk.hasGuideReview(task.id);
    // Each action's last answer, read again with no run: the guide's is
    // its review, and a pane action's turn says only where it opened.
    const answers = actionAnswers(riker.turns(task.id), (name) => {
      const spec = actionNamed(desk.config(), name);
      return spec?.via === ActionVia.pane || spec?.output === ActionOutput.guide;
    });
    if (offered.length === 0 && !review && answers.length === 0) {
      showToast("No actions apply here (config.json \"actions\")");
      return;
    }
    dialogs.show(() => (
      <ChoiceModal
        title={`Actions · ${taskRef(task.id)}`}
        hint="Each runs a skill on this task; its answer lands in the chat."
        choices={offered.flatMap((a) => [
          {
            label: a.title,
            hint: keys.has(a.name) ? `${a.name} · ${a.key}` : a.name,
            run: () => runAction(task, a.name),
          },
          // Asked again, the guide reviews what changed since your last
          // review; this one reviews all of it.
          ...(a.output === ActionOutput.guide && desk.askedReview(task.id)
            ? [{ label: `${a.title}, whole PR`, hint: "not only what changed since your last review", run: () => runAction(task, a.name, { whole: true }) }]
            : []),
        ]).concat(
          review
            ? [{ label: OPEN_REVIEW_TITLE, hint: "the last guide, no run", run: () => openGuideReview(task) }]
            : [],
          answers.map((t) => ({
            label: `Read: ${t.about || t.author}`,
            hint: `${dayClock(t.finished_at ?? t.started_at, riker.now())}, no run`,
            run: () => readAnswer(task.id, t.id),
          })),
        )}
        onClose={dialogs.close}
      />
    ));
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
    const pending = riker.pendingAction(task.id);
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
    desk.say(task.id, text).catch((err) => {
      log.error("say failed", { task: task.id, err });
      showToast(`Not sent: ${errorMessage(err)}`, 4000, "error");
    });
  }

  // ── on an Inbox row ───────────────────────────────────────────────────

  function goToTask(taskId: number) {
    riker.setMode(ViewMode.chat);
    riker.selectTask(taskId);
  }

  // m: a message triage did not make work becomes a task; an idea is
  // approved. Either way you stay on the Inbox.
  function inboxMakeTask(row: InboxRow) {
    if (row.type === "idea") {
      const task = desk.ideaToTask(row.idea.id);
      if (task) showToast(`${taskRef(task.id)} on your list`);
      return;
    }
    if (row.result === InboxResult.held) {
      const task = desk.heldToTask(row.message.id);
      if (task) showToast(`${taskRef(task.id)} on your list`);
      return;
    }
    const task = desk.fyiToTask(row.message.id);
    if (task) showToast(`${taskRef(task.id)}: it was work; triage will learn`);
  }

  function inboxDismiss(row: InboxRow) {
    if (row.type === "idea") desk.dismissIdea(row.idea.id);
    else for (const m of rowMessages(row)) desk.readMessage(m.id);
  }

  function inboxIgnore(row: InboxRow) {
    if (row.type !== "message" || row.taskId === null) return false;
    const task = riker.task(row.taskId);
    if (!task) return false;
    void desk.ignore(task.id);
    showToast(`Ignored ${taskRef(task.id)} · ctrl+z undoes`, 4000);
  }

  async function retriage(message: MessageRow) {
    showToast("Triaging it again…", 2000);
    try {
      const result = await desk.retriage(message.id);
      if (!result.ok) showToast(result.why, 4000, "error");
      else
        showToast(
          `Triage: ${result.outcome.verdict}${result.outcome.taskId ? ` · ${taskRef(result.outcome.taskId)}` : ""} (${result.outcome.reason})`,
          5000,
        );
    } catch (err) {
      log.error("retriage failed", { message: message.id, err });
      showToast(`Triage failed: ${errorMessage(err)}`, 5000, "error");
    }
  }

  function openMessage(message: MessageRow) {
    if (message.url) open(message.url);
    else showToast("No link on this one");
  }

  // Shift+F: what to match (the sender, the title, GitHub's reason), the
  // pattern as a regex you can loosen, then the reason you will read.
  function noiseFilter(message: MessageRow) {
    const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const meta = messageMeta(message);
    const githubReason = meta.channel === "github" ? meta.reason : null;
    const channel = message.channel === "github" || message.channel === "slack" ? message.channel : undefined;
    const save = (rule: NoiseRule) => {
      const error = desk.noiseFromMessage(message.id, { ...rule, channel });
      if (error) showToast(error, 5000, "error");
      else showToast(`Noise filter saved: ${rule.reason}`);
    };
    const askReason = (rule: Omit<NoiseRule, "reason">) =>
      dialogs.show(() => (
        <PromptModal
          title="Create noise filter: the reason"
          hint="What you will read on the messages it files as FYI."
          initial={`noise from ${message.author_name}`}
          onSubmit={(reason) => save({ ...rule, reason })}
          onClose={dialogs.close}
        />
      ));
    const askPattern = (field: "author" | "title", initial: string) =>
      dialogs.show(() => (
        <PromptModal
          title={`Create noise filter: ${field === "author" ? "sender" : "title"} pattern`}
          hint="A regex, matched without case. Loosen it to catch its like."
          initial={initial}
          onSubmit={(pattern) => askReason({ [field]: pattern })}
          onClose={dialogs.close}
        />
      ));
    dialogs.show(() => (
      <ChoiceModal
        title="Create noise filter"
        hint={`Messages like this one on ${message.channel} are filed as FYI, with no model call.`}
        choices={[
          {
            label: `Sender is ${message.author_name}`,
            hint: message.author,
            run: () => askPattern("author", `^${escape(message.author)}$`),
          },
          ...(message.title
            ? [
                {
                  label: "Title is like this one",
                  hint: inboxClip(message.title, 40),
                  run: () => askPattern("title", escape(message.title)),
                },
              ]
            : []),
          ...(githubReason
            ? [
                {
                  label: `GitHub's reason is ${githubReason}`,
                  run: () => askReason({ githubReason: [githubReason] }),
                },
              ]
            : []),
        ]}
        onClose={dialogs.close}
      />
    ));
  }

  function walk(direction: 1 | -1) {
    const current = riker.selected();
    if (direction === 1 && current) {
      if (current.type === "task" && current.task.unread_result)
        desk.readResult(current.task.id);
    }
    const key = riker.walk(direction);
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
              riker.setMode(ViewMode.chat);
              riker.selectTask(task.id);
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

  function kchars(n: number): string {
    return n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`;
  }

  function docs() {
    dialogs.show(() => (
      <ChoiceModal
        title="Docs: what the models are told"
        hint="Opens in $EDITOR. PERSONA.md always outranks LEARNED.md. Size is what a prompt pays, of its budget."
        choices={[
          ...Object.values(DocName).map((name) => ({
            label: name,
            hint: `${DOC_PURPOSE[name]} · ${kchars(docSize(name))} of ${kchars(docBudget(desk.config(), name))}${overBudget(desk.config(), name) ? " · over budget" : ""}`,
            run: () => editor.openEditor(docPath(name), name),
          })),
          {
            label: ARCHIVE,
            hint: "lessons that left LEARNED.md, and why (never in a prompt)",
            run: () => editor.openEditor(docPath(ARCHIVE), ARCHIVE),
          },
        ]}
        onClose={dialogs.close}
      />
    ));
  }

  // Files the task's agent turns made, newest first, still on disk.
  function madeFiles(item: RailItem): MadeFile[] {
    if (item.type !== "task") return [];
    const seen = new Set<string>();
    const out: MadeFile[] = [];
    for (const turn of [...riker.turns(item.task.id)].reverse()) {
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
      openTarget(target, desk.config().opener);
    } catch (err) {
      showToast(`Could not open: ${errorMessage(err)}`, 5000, "error");
    }
  }

  // o: the link, or a pick of the thread, the links attached to the task,
  // and what the agent made.
  function openLink(item: RailItem) {
    const url = item.type === "task" ? item.task.url : null;
    const links = item.type === "task" ? riker.taskLinks(item.task.id) : [];
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
        hint={`With ${openerArgv("…", desk.config().opener).slice(0, -1).join(" ")} (set "opener" in config).`}
        choices={choices}
        onClose={dialogs.close}
      />
    ));
  }

  // O: a file the agent made, in $EDITOR on the Canvas.
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

  const copied = (ok: boolean) =>
    showToast(ok ? "Copied" : "No clipboard here", 2000, ok ? "info" : "error");

  // V on a task: its story as markdown, read from the story as it is now.
  function readStory(task: TaskRow) {
    const ref = taskRef(task.id);
    const project = task.project_id ? riker.project(task.project_id) : null;
    const on = storySwitchOf(desk.config(), task, project).on;
    const v = riker.story(task.id);
    dialogs.show(() => (
      <ReaderModal
        title={`${ref} story`}
        note={v ? `as of ${v.at.slice(0, 16).replace("T", " ")}, by ${v.by} · ${task.title}` : task.title}
        text={() => {
          const now = riker.story(task.id);
          return now ? storyMarkdown(now) : null;
        }}
        empty={
          on
            ? "No story yet: one is written up when a session on this task finishes. e starts one in $EDITOR."
            : "No story: it is off for this task (J turns it on). e starts one in $EDITOR."
        }
        onEdit={() => {
          dialogs.close();
          editor.editStory(task);
        }}
        onCopied={copied}
        onClose={dialogs.close}
      />
    ));
  }

  // V on a project: its journal file as markdown, read when opened.
  function readJournal(projectId: number) {
    const project = riker.project(projectId);
    if (!project) return;
    const found = desk.journal(projectId);
    const on = journalSwitch(desk.config(), project).on;
    dialogs.show(() => (
      <ReaderModal
        title={`${project.name} journal`}
        note={found?.file.replace(process.env.HOME ?? "\0", "~")}
        text={() => (found ? journalMarkdown(found.text) : null)}
        empty={
          on
            ? "No journal yet: its first entry is written when a task here has news."
            : "No journal: it is off for this project (J turns it on)."
        }
        onEdit={
          found
            ? () => {
                dialogs.close();
                editor.editJournal(projectId);
              }
            : undefined
        }
        onCopied={copied}
        onClose={dialogs.close}
      />
    ));
  }

  function info(item: RailItem) {
    dialogs.show(() => (
      <InfoModal
        title={infoTitle(item)}
        sections={itemInfo(item, new Date(), desk.config())}
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
    // reach it. A System task has its own three keys (accept, reject,
    // review) and typing; everything else declines it.
    const onTask =
      (fn: (t: TaskRow) => false | void, home = false, system = false) =>
      () => {
        const item = get();
        if (item?.type !== "task") return false;
        const fresh = riker.task(item.task.id);
        if (!fresh || (fresh.kind === Kind.home && !home)) return false;
        if ((fresh.kind === Kind.system) !== system) return false;
        return fn(fresh);
      };
    const onSystem = (fn: (t: TaskRow) => false | void) => onTask(fn, false, true);
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
      [Commands.REOPEN]: onTask(reopen),
      [Commands.REMIND]: onTask(remind),
      [Commands.WATCH]: onTask(watch),
      [Commands.WIN]: onTask(win),
      [Commands.PRIORITY]: onTask(cyclePriority),
      [Commands.KIND]: onTask(changeKind),
      [Commands.WAIT_ON]: onTask(waitOn),
      [Commands.TYPE]: () => {
        if (get()?.type !== "task") return false;
        typeInto();
      },
      [Commands.DOC_ACCEPT]: onSystem(acceptDocs),
      [Commands.DOC_REJECT]: onSystem(rejectDocs),
      [Commands.DOC_REVIEW]: onSystem(reviewDocs),
      // x means one thing per row type; each declines the others' rows.
      [Commands.IGNORE]: () => {
        const item = get();
        if (
          item?.type !== "task" ||
          item.task.kind === Kind.home ||
          item.task.kind === Kind.system
        )
          return false;
        ignore(item.task);
      },
      [Commands.PROJECT_ARCHIVE]: () => {
        const item = get();
        if (item?.type !== "project") return false;
        archiveProject(item.project.id);
      },
      [Commands.PROJECT_EDIT]: () => {
        const item = get();
        if (item?.type !== "project") return false;
        return editor.editProject(item.project.id);
      },
      [Commands.EDIT_FILE]: () => {
        const item = get();
        if (item) editFile(item);
      },
      [Commands.OPEN_URL]: () => {
        const item = get();
        if (item) openLink(item);
      },
      [Commands.STORY_SWITCH]: () => {
        const item = get();
        if (item?.type !== "task" || item.task.kind === Kind.home || item.task.kind === Kind.system)
          return false;
        flipStory(item.task);
      },
      [Commands.JOURNAL_SWITCH]: () => {
        const item = get();
        if (item?.type !== "project") return false;
        flipJournal(item.project.id);
      },
      [Commands.STORY_READ]: () => {
        const item = get();
        if (item?.type !== "task" || item.task.kind === Kind.home || item.task.kind === Kind.system)
          return false;
        readStory(item.task);
      },
      [Commands.JOURNAL_READ]: () => {
        const item = get();
        if (item?.type !== "project") return false;
        readJournal(item.project.id);
      },
      [Commands.INFO]: () => {
        const item = get();
        if (!item) return false;
        info(item);
      },
      [Commands.PR_DASH]: onTask(togglePrDash),
      [Commands.ACTIONS]: onTask(pickAction),
      ...Object.fromEntries(
        [...keys].map((name) => [
          actionCommand(name),
          onTask((task) => runAction(task, name)),
        ]),
      ),
    };
  }

  return {
    startAgent,
    jumpTo,
    nudge,
    newProject,
    adopt,
    moveToProject,
    archiveProject,
    jumpToProject,
    openEditor: editor.openEditor,
    editProject: editor.editProject,
    showRepos,
    start,
    stop,
    done,
    reopen,
    send,
    say,
    compose: editor.compose,
    walk,
    newTask,
    goToTask,
    inboxMakeTask,
    inboxDismiss,
    inboxIgnore,
    retriage,
    openMessage,
    noiseFilter,
    docs,
    taskActions,
    runAction,
    pickAction,
    openGuideReview,
    togglePrDash,
    editorId: editor.editorId,
  };
}

export type Actions = ReturnType<typeof useActions>;
