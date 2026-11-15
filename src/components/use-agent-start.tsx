// Start (or continue) a task's agent. The desk says what a coding start
// still needs (a repo, where it is checked out, a branch); each need is one
// dialog here, and the answer starts again. Nothing here decides the order.

import { useFocus, useToast } from "@andycmaj/opentui-app";
import { useAug, ViewMode } from "../context/aug";
import { useTerminals } from "../context/terminals";
import { inTmux, type StartOptions } from "../core/driver";
import { errorMessage } from "../core/log";
import { describeProblem, type PathNeed } from "../core/repos";
import { taskRef } from "../core/rows";
import { Kind, type TaskRow } from "../core/types";
import type { Dialogs } from "./actions";
import { ChoiceModal, PromptModal } from "./modals";
import { useRepos } from "./use-repos";

export function useAgentStart(
  dialogs: Dialogs,
  attachViewer: (taskId: number) => Promise<boolean>,
) {
  const aug = useAug();
  const terminals = useTerminals();
  const { setActivePane } = useFocus();
  const { showToast } = useToast();
  const desk = aug.desk;
  const { pathChoices } = useRepos(dialogs);

  function showTask(taskId: number) {
    if (aug.mode() === ViewMode.chat) {
      aug.selectTask(taskId);
      setActivePane("task");
    }
  }

  async function startAgent(taskId: number, opts: StartOptions = {}) {
    const task = aug.task(taskId);
    if (!task) return;
    const coding = inTmux(task);
    if (coding && terminals.forTask(taskId)?.running) return showTask(taskId);
    if (coding) showToast(`Starting ${taskRef(taskId)}...`);
    const result = await desk.startAgent(taskId, opts);
    switch (result.type) {
      case "needs":
        switch (result.need.what) {
          case "repo":
            return askRepo(task, result.need.choices, opts);
          case "path":
            return askRepoPath(task, result.need, opts);
          case "branch":
            return askBranch(task, result.need.suggested, opts);
        }
      // falls through: every need returned above
      case "failed":
        showToast(`Could not start: ${result.error}`, 4000, "error");
        return;
      case "queued":
        showToast(`${taskRef(taskId)}: ${result.reason}`);
        return;
      case "started":
        if (!coding) {
          showToast(`${taskRef(taskId)}: agent started`);
          return;
        }
        // Shown first: a viewer of a task that is not shown is closed.
        showTask(taskId);
        await attachViewer(taskId);
    }
  }

  // A coding task you made has no repo: pick one, then the usual questions
  // (where it is checked out, which branch) follow.
  function askRepo(task: TaskRow, choices: string[], opts: StartOptions) {
    const use = (repo: string) => {
      try {
        desk.setTaskRepo(task.id, repo);
      } catch (err) {
        showToast(errorMessage(err), 4000, "error");
        return;
      }
      void startAgent(task.id, opts);
    };
    dialogs.show(() => (
      <ChoiceModal
        title={`Which repo is ${taskRef(task.id)} in?`}
        hint="It gets a worktree and a branch there."
        choices={[
          ...choices.map((repo) => ({ label: repo, run: () => use(repo) })),
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
            run: () => void startAgent(task.id, { ...opts, noWorktree: true }),
          },
        ]}
        onClose={dialogs.close}
      />
    ));
  }

  // The repo's checkout will not do (none yet, gone, a worktree, another
  // repo's): say why and offer what was found on disk, a clone, a typed
  // path or scratch. Start asks again if what was picked still will not do.
  function askRepoPath(task: TaskRow, need: PathNeed, opts: StartOptions) {
    const { repo, problem } = need;
    const choices = pathChoices(
      { ...need, mapped: false },
      () => void startAgent(task.id, opts),
    );
    choices.push({
      label: "No worktree: a scratch folder",
      run: () => void startAgent(task.id, { ...opts, noWorktree: true }),
    });
    dialogs.show(() => (
      <ChoiceModal
        title={problem.kind === "unmapped" ? `Where is ${repo} checked out?` : `${repo}: ${describeProblem(repo, problem)}`}
        hint="Its worktrees are made from this checkout."
        choices={choices}
        wide
        onClose={dialogs.close}
      />
    ));
  }

  function askBranch(task: TaskRow, suggested: string, opts: StartOptions) {
    dialogs.show(() => (
      <PromptModal
        title={`Branch for ${taskRef(task.id)}`}
        hint="A new branch gets a worktree of its own. An existing branch or pr:N works too."
        initial={suggested}
        onSubmit={(branch) =>
          void startAgent(task.id, {
            ...opts,
            branch: branch.trim() || suggested,
          })
        }
        onClose={dialogs.close}
      />
    ));
  }

  return { startAgent };
}
