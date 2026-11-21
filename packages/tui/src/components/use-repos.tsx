// Repos and where they are checked out: the Repos list (every repo Riker
// knows, its checkout's state, checkouts on disk it has no path for), and
// the choices for one repo's checkout, which a coding Start offers too when
// the checkout will not do. Nothing is mapped unless the owner picks it.

import { useToast } from "@andycmaj/opentui-app";
import { useRiker } from "../context/riker";
import { errorMessage } from "@riker/core/log";
import {
  describeProblem,
  problemFix,
  tildePath,
  type Candidate,
  type CheckoutProblem,
  type RepoState,
} from "@riker/core/repos";
import type { Dialogs } from "./actions";
import { ChoiceModal, PromptModal, type Choice } from "./modals";

export interface PathPick {
  repo: string;
  // Null: the checkout is good; the owner is changing it anyway.
  problem: CheckoutProblem | null;
  candidates: Candidate[];
  clone: string;
  mapped: boolean;
}

export function useRepos(dialogs: Dialogs) {
  const riker = useRiker();
  const { showToast } = useToast();
  const desk = riker.desk;

  // What can be done about one repo's checkout. `done` runs after a change
  // took (a Start starts again, the Repos list shows again).
  function pathChoices(pick: PathPick, done: () => void): Choice[] {
    const { repo, problem } = pick;
    const act = (what: () => void) => {
      try {
        what();
      } catch (err) {
        showToast(errorMessage(err), 4000, "error");
        return;
      }
      done();
    };
    const usePath = (path: string) => act(() => desk.mapRepo(repo, path));
    const fix = problem ? problemFix(problem) : null;
    const choices: Choice[] = [];
    if (problem?.kind === "mismatch") {
      const remote = problem.remotes[0];
      choices.push(
        {
          label: `Call it ${remote}`,
          hint: "renames it in config, projects, open tasks",
          run: () =>
            act(() => showToast(`${repo} is now ${desk.renameRepo(repo, remote)}`)),
        },
        {
          label: `Use ${tildePath(problem.path)} anyway`,
          hint: "remembered",
          run: () => act(() => desk.allowMismatch(repo, problem.path)),
        },
      );
    }
    if (fix) choices.push({ label: `Use ${tildePath(fix)}`, run: () => usePath(fix) });
    for (const c of pick.candidates)
      if (c.path !== fix)
        choices.push({
          label: tildePath(c.path),
          hint: c.guess ? "folder name only, no GitHub remote" : "found on disk",
          run: () => usePath(c.path),
        });
    choices.push(
      {
        label: `Clone to ${tildePath(pick.clone)}`,
        hint: "gh repo clone",
        run: () => {
          showToast(`Cloning ${repo}...`);
          void desk.cloneRepo(repo).then(done, (err) =>
            showToast(`Could not clone: ${errorMessage(err)}`, 4000, "error"),
          );
        },
      },
      {
        label: "Type a path...",
        run: () =>
          dialogs.show(() => (
            <PromptModal
              title={`Where is ${repo} checked out?`}
              hint="Saved once it is a checkout. Worktrees are made from it."
              placeholder="~/workspace/owner/repo"
              onSubmit={usePath}
              onClose={dialogs.close}
            />
          )),
      },
    );
    if (pick.mapped)
      choices.push({
        label: "Forget its path",
        hint: "the checkout stays on disk",
        run: () => act(() => desk.unmapRepo(repo)),
      });
    return choices;
  }

  function stateHint(s: RepoState): string {
    if (!s.path) return s.others.length ? "no path; found on disk" : "no path";
    if (s.problem && s.problem.kind !== "unmapped")
      return `${tildePath(s.path)}: ${describeProblem(s.repo, s.problem).replace(`${tildePath(s.path)} `, "")}`;
    return tildePath(s.path);
  }

  async function showRepos(fresh = false) {
    let report: Awaited<ReturnType<typeof desk.repoReport>>;
    try {
      report = await desk.repoReport(fresh);
    } catch (err) {
      showToast(`Could not list repos: ${errorMessage(err)}`, 4000, "error");
      return;
    }
    const reopen = () => void showRepos();
    const one = (s: RepoState) =>
      dialogs.show(() => (
        <ChoiceModal
          title={s.problem && s.problem.kind !== "unmapped" ? `${s.repo}: ${describeProblem(s.repo, s.problem)}` : s.repo}
          hint={`${s.path ? `Checked out at ${tildePath(s.path)}.` : "No checkout yet."}${s.projects.length ? ` In ${s.projects.join(", ")}.` : ""}`}
          choices={pathChoices(
            {
              repo: s.repo,
              problem: s.problem,
              candidates: s.others,
              clone: s.clone,
              mapped: Boolean(s.path),
            },
            reopen,
          )}
          wide
          onClose={dialogs.close}
        />
      ));
    const choices: Choice[] = [
      ...report.repos.map((s) => ({
        label: `${s.problem ? "! " : "  "}${s.repo}`,
        hint: stateHint(s),
        run: () => one(s),
      })),
      ...report.unmapped.map((f) => ({
        label: `+ ${f.repos[0]}`,
        hint: tildePath(f.path),
        run: () => {
          try {
            desk.mapRepo(f.repos[0], f.path);
            showToast(`${f.repos[0]}: ${tildePath(f.path)}`);
          } catch (err) {
            showToast(errorMessage(err), 4000, "error");
          }
          reopen();
        },
      })),
      { label: "Look on disk again", run: () => void showRepos(true) },
    ];
    dialogs.show(() => (
      <ChoiceModal
        title="Repos"
        hint="! needs a checkout. + is on disk with no path in Riker: pick it to add it."
        choices={choices}
        wide
        onClose={dialogs.close}
      />
    ));
  }

  return { pathChoices, showRepos };
}
