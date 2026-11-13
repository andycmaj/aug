// Start (or continue) a task's agent. The desk says what a coding start
// still needs (a repo, where it is checked out, a branch); each need is one
// dialog here, and the answer starts again. Nothing here decides the order.

import { homedir } from "node:os";
import { useFocus, useToast } from "@andycmaj/opentui-app";
import { useAug, ViewMode } from "../context/aug";
import { useTerminals } from "../context/terminals";
import type { StartOptions } from "../core/driver";
import { errorMessage } from "../core/log";
import { mapRepo } from "../core/repos";
import * as store from "../core/store";
import { Kind, type TaskRow } from "../core/types";
import type { Dialogs } from "./actions";
import { ChoiceModal, PromptModal } from "./modals";

export function useAgentStart(
  dialogs: Dialogs,
  attachViewer: (taskId: number) => Promise<boolean>,
) {
  const aug = useAug();
  const terminals = useTerminals();
  const { setActivePane } = useFocus();
  const { showToast } = useToast();
  const desk = aug.desk;

  function showTask(taskId: number) {
    if (aug.mode() === ViewMode.chat) {
      aug.selectTask(taskId);
      setActivePane("task");
    }
  }

  async function startAgent(taskId: number, opts: StartOptions = {}) {
    const task = store.getTask(taskId);
    if (!task) return;
    const coding = task.kind === Kind.coding;
    if (coding && terminals.forTask(taskId)?.running) return showTask(taskId);
    if (coding) showToast(`Starting ${store.taskRef(taskId)}...`);
    const result = await desk.startAgent(taskId, opts);
    switch (result.type) {
      case "needs":
        switch (result.need.what) {
          case "repo":
            return askRepo(task, result.need.choices, opts);
          case "path":
            return askRepoPath(task, result.need.repo, opts);
          case "branch":
            return askBranch(task, result.need.suggested, opts);
        }
      // falls through: every need returned above
      case "failed":
        showToast(`Could not start: ${result.error}`, 4000, "error");
        return;
      case "started":
        if (!coding) {
          showToast(`${store.taskRef(taskId)}: agent started`);
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
        title={`Which repo is ${store.taskRef(task.id)} in?`}
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

  // An unmapped repo: ask once where it lives; Esc works in scratch instead.
  function askRepoPath(task: TaskRow, repo: string, opts: StartOptions) {
    let submitted = false;
    dialogs.show(() => (
      <PromptModal
        title={`Where is ${repo} checked out?`}
        hint="Saved to config. Esc starts it in a scratch folder with no worktree."
        placeholder="/path/to/checkout"
        onSubmit={(path) => {
          submitted = true;
          mapRepo(repo, path.trim().replace(/^~/, homedir()));
          void startAgent(task.id, opts);
        }}
        onClose={() => {
          dialogs.close();
          // onSubmit runs right after onClose; only a bare Esc gets here.
          queueMicrotask(() => {
            if (!submitted)
              void startAgent(task.id, { ...opts, noWorktree: true });
          });
        }}
      />
    ));
  }

  function askBranch(task: TaskRow, suggested: string, opts: StartOptions) {
    dialogs.show(() => (
      <PromptModal
        title={`Branch for ${store.taskRef(task.id)}`}
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
