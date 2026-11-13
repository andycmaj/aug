// Fixture mode: a fictional morning at Northwind, on the real interface. No
// network, no AI: the brain answers from canned lines, Send says it is the
// demo, and a coding agent is a small fake that fires the same hooks. Each
// run starts from a fresh scratch home, so its changes reset when you quit.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setBrain, type BrainCall, type BrainResult } from "../core/brain";
import { DEFAULT_CONFIG, setConfigForTest } from "../core/config";
import { openDb, useDb } from "../core/db";
import { DocName, ensureDocs, readDoc, writeDoc } from "../core/docs";
import { Engine } from "../core/engine";
import type { MadeFile } from "../core/files";
import { setSender } from "../core/outbound";
import { defaultHome, paths } from "../core/paths";
import * as store from "../core/store";
import {
  AgentState,
  Kind,
  SessionKind,
  TurnRole,
  type Channel,
  type Priority,
} from "../core/types";

const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();
const inDays = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SeedMessage {
  channel: Channel;
  id: string;
  thread: string;
  author: string;
  name: string;
  title: string;
  body: string;
  minutes: number;
  url?: string;
  meta?: Record<string, unknown>;
}

function message(m: SeedMessage): store.NewMessage {
  return {
    channel: m.channel,
    externalId: m.id,
    threadKey: m.thread,
    author: m.author,
    authorName: m.name,
    title: m.title,
    body: m.body,
    url: m.url ?? null,
    receivedAt: ago(m.minutes),
    meta: m.meta ?? {},
  };
}

function seedTask(
  m: SeedMessage,
  t: {
    title: string;
    summary: string;
    kind: Exclude<Kind, "home">;
    priority?: Priority;
    reason: string;
    repo?: string;
    watching?: boolean;
  },
): number {
  const msg = store.insertMessage(message(m))!;
  const task = store.createTask({
    title: t.title,
    summary: t.summary,
    kind: t.kind,
    priority: t.priority,
    watching: t.watching,
    repo: t.repo,
    threadKey: m.thread,
    channel: m.channel,
    url: m.url ?? null,
    triageReason: t.reason,
    createdAt: msg.received_at,
  });
  store.fileMessage(msg.id, t.watching ? "watch" : t.kind, t.reason, task.id);
  store.addTurn({
    taskId: task.id,
    role: TurnRole.incoming,
    author: m.name,
    body: m.body,
    messageId: msg.id,
    startedAt: msg.received_at,
  });
  return task.id;
}

function endedSession(id: string, taskId: number): void {
  store.createSession({
    id,
    taskId,
    kind: SessionKind.chat,
    cwd: "/tmp",
    startedBy: "aug",
  });
  store.updateSession(id, { state: AgentState.agentdone, ended_at: ago(30) });
}

function agentTurn(
  taskId: number,
  minutes: number,
  ran: number,
  a: { about: string; did: string; next: string; steps: string[] },
): number {
  const turn = store.addTurn({
    taskId,
    role: TurnRole.agent,
    author: "agent",
    startedAt: ago(minutes),
    sessionId: `demo-${taskId}`,
  });
  store.updateTurn(turn.id, {
    ...a,
    body: a.did,
    steps: JSON.stringify(a.steps),
    finished_at: ago(minutes - ran),
  });
  return turn.id;
}

// A file an agent "made", written where a real turn would leave it.
function madeFile(taskId: number, name: string, text: string): MadeFile {
  const dir = paths.work(taskId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, text);
  return { path, name, bytes: Buffer.byteLength(text) };
}

export function seedDemo(): void {
  store.batch(() => {
    // 1. A general ask the agent answered; the decision is yours.
    const sam = seedTask(
      {
        channel: "slack",
        id: "s:D01:1",
        thread: "slack:D01:dm",
        author: "U01",
        name: "Sam Delgado",
        title: "DM with Sam Delgado",
        minutes: 95,
        body: "Staff keep asking whether they can get paid the same day they work. Which payroll providers actually do that, and what would it cost us?",
        meta: { channel: "D01", ts: "1.1", dm: true },
      },
      {
        title: "Same-day pay - which payroll providers do it?",
        summary:
          "Sam wants providers offering same-day pay and the cost to Northwind.",
        kind: Kind.general,
        reason: "a direct question that needs research, not a one-line answer",
      },
    );
    endedSession(`demo-${sam}`, sam);
    agentTurn(sam, 92, 2, {
      about:
        "Sam wants to know which payroll providers offer same-day pay to staff, and what it would cost Northwind.",
      did: "Compared three ways to offer it to our 540 staff, cheapest to switch on first:\n\n- **Payworth Instant** - built into the payroll we already run. No cost to us; staff pay $1.99 per transfer.\n- **Spendly Pay** - a separate app fed from Payworth. Free to staff; $2.50 per enrolled employee a month (about $8,100 a year at half take-up).\n- **ShiftCash** - a pay card, free to both sides, but it needs a new bank file every pay run.",
      next: "For you to do: decide whether to offer same-day pay - it changes what staff pay, so it is yours, not mine. Say if I should ask Payworth for terms for 540 staff.",
      steps: [
        "WebSearch payroll same-day pay providers",
        "WebFetch payworth.example/instant",
        "WebFetch spendly.example/pay",
        "Read pricing.md",
      ],
    });
    store.updateTask(sam, { agent_state: AgentState.agentdone });

    // 2. A reply set up for one press.
    const ruth = seedTask(
      {
        channel: "slack",
        id: "s:C07:2",
        thread: "slack:C07:1730.2",
        author: "U02",
        name: "Ruth Okafor",
        title: "#renewals",
        minutes: 58,
        body: "@you before I sign the copier renewal - how many seats do we actually need? Vendor says 60.",
        meta: { channel: "C07", ts: "1730.2" },
      },
      {
        title: "Copier renewal - how many seats?",
        summary: "Ruth needs the seat count before signing.",
        kind: Kind.reply,
        reason: "a question to you a sentence settles",
        priority: "important",
      },
    );
    endedSession(`demo-${ruth}`, ruth);
    const ruthTurn = agentTurn(ruth, 55, 1, {
      about: "Ruth needs the copier seat count before she signs the renewal.",
      did: "**42 seats** are in use: the licence export lists 42 active users over the last 90 days, 18 fewer than the vendor's 60.",
      next: "The reply to Ruth is below, ready to send.",
      steps: ["Read licence-export.csv", "Grep active users"],
    });
    store.setTurnAction(ruthTurn, {
      type: "slack_reply",
      channel: "C07",
      thread_ts: "1730.2",
      to: "Ruth Okafor",
      text: "42 seats - that's everyone active in the last 90 days. I'd push back on 60.",
    });
    store.updateTask(ruth, { agent_state: AgentState.agentdone });

    // 3. Coding work, held for your Start.
    const exp = seedTask(
      {
        channel: "github",
        id: "gh:1:a",
        thread: "github:northwind/ledger#214",
        author: "erin",
        name: "erin",
        title:
          "northwind/ledger#214 issue: Export drops inter-company transfers (mentioned you)",
        minutes: 140,
        url: "https://github.com/northwind/ledger/issues/214",
        body: "@you the month-end export is short by 4,180. Looks like inter-company transfers are filtered out somewhere in tools/gl_export.py. Can an agent take a look?",
        meta: {
          repo: "northwind/ledger",
          number: 214,
          type: "Issue",
          reason: "mention",
        },
      },
      {
        title: "Export drops inter-company transfers",
        summary:
          "Month-end export is short by 4,180; transfers filtered in gl_export.",
        kind: Kind.coding,
        reason: "a bug in a repository: an agent at a keyboard",
        repo: "northwind/ledger",
        priority: "urgent",
      },
    );
    store.updateTask(exp, {
      agent_state: AgentState.queued,
      queue_reason: "held for you: press Start",
    });

    // 4. A review that is yours.
    const review = seedTask(
      {
        channel: "github",
        id: "gh:2:a",
        thread: "github:northwind/web#88",
        author: "priya",
        name: "priya",
        title: "northwind/web#88 PR: Add dark mode toggle (review requested)",
        minutes: 300,
        url: "https://github.com/northwind/web/pull/88",
        body: "Adds a dark mode toggle to settings. Screenshots in the description. Would love a review before Friday's release.",
        meta: {
          repo: "northwind/web",
          number: 88,
          type: "PullRequest",
          reason: "review_requested",
        },
      },
      {
        title: "Review: Add dark mode toggle (web#88)",
        summary: "Priya wants a review before Friday's release.",
        kind: Kind.task,
        reason: "a review requested from you is yours to do",
      },
    );
    store.setPrStatus({
      task_id: review,
      repo: "northwind/web",
      number: 88,
      url: "https://github.com/northwind/web/pull/88",
      state: "open",
      checks: "pending",
      review: "required",
      mergeable: "clean",
      fetched_at: ago(5),
    });

    // 5. An agent asking you something.
    const erin = seedTask(
      {
        channel: "slack",
        id: "s:D03:1",
        thread: "slack:D03:dm",
        author: "U03",
        name: "Erin Blake",
        title: "DM with Erin Blake",
        minutes: 40,
        body: "Can you send me September overtime by site before 3? Need it for the ops review.",
        meta: { channel: "D03", ts: "3.1", dm: true },
      },
      {
        title: "September overtime by site, before 3",
        summary: "Erin needs overtime by site for the ops review.",
        kind: Kind.general,
        reason: "from your manager, with a deadline today",
        priority: "urgent",
      },
    );
    endedSession(`demo-${erin}`, erin);
    const erinTurn = agentTurn(erin, 36, 1, {
      about: "Erin wants September overtime broken out by site before 3pm.",
      did: "Found the September timesheet export; it has overtime for **five sites**, and two of them (Harbor, Westgate) closed mid-month.",
      next: "Which sites - all five, or only the three still open?",
      steps: ["Glob **/timesheets/2026-09*", "Read timesheets-2026-09.csv"],
    });
    store.updateTurn(erinTurn, {
      files: JSON.stringify([
        madeFile(
          erin,
          "overtime-sep-by-site.csv",
          'site,hours,cost,open\nFairhaven,412,"$18,540",yes\nDockside,288,"$12,960",yes\nNorthgate,167,"$7,515",yes\nHarbor,94,"$4,230",closed 9/14\nWestgate,51,"$2,295",closed 9/20\n',
        ),
      ]),
    });
    store.updateTask(erin, {
      agent_state: AgentState.blocked,
      agent_says:
        "asked you: which sites - all five, or only the three still open?",
    });

    // 6. A coding agent finished on its own: stays until you read it.
    const csv = seedTask(
      {
        channel: "github",
        id: "gh:3:a",
        thread: "github:northwind/ledger#201",
        author: "marcus",
        name: "marcus",
        title:
          "northwind/ledger#201 issue: CSV import fails on a BOM (assigned you)",
        minutes: 600,
        url: "https://github.com/northwind/ledger/issues/201",
        body: "Importing the bank CSV fails with 'unknown column \\ufeffdate'. Assigning to you.",
        meta: {
          repo: "northwind/ledger",
          number: 201,
          type: "Issue",
          reason: "assign",
        },
      },
      {
        title: "CSV import fails on a BOM",
        summary: "Bank CSV import chokes on a byte-order mark.",
        kind: Kind.coding,
        reason: "a bug assigned to you",
        repo: "northwind/ledger",
      },
    );
    store.createSession({
      id: `demo-pty-${csv}`,
      taskId: csv,
      kind: SessionKind.tmux,
      cwd: "/tmp",
      startedBy: "aug",
    });
    store.updateSession(`demo-pty-${csv}`, {
      state: AgentState.agentdone,
      ended_at: ago(30),
      result:
        "Strip a UTF-8 BOM before parsing; added a regression test. 14 tests green.",
    });
    // Its agent opened PR #219; CI went red after a rebase.
    store.linkThread(csv, "github:northwind/ledger#219");
    store.setPrStatus({
      task_id: csv,
      repo: "northwind/ledger",
      number: 219,
      url: "https://github.com/northwind/ledger/pull/219",
      state: "open",
      checks: "fail",
      review: "approved",
      mergeable: "clean",
      fetched_at: ago(5),
    });
    const csvTurn = agentTurn(csv, 80, 50, {
      about: "CSV import fails on a byte-order mark.",
      did: "Strip a UTF-8 BOM before parsing the header (`ledger/importers/bank.py`); added a regression test. **14 tests green.** Branch `fix/csv-bom`, PR #219.",
      next: "The close-out is below: comment and close #201.",
      steps: [
        "Read ledger/importers/bank.py",
        "Edit ledger/importers/bank.py",
        "Bash pytest tests/importers -q",
      ],
    });
    store.updateTurn(csvTurn, { author: "coding agent" });
    store.setTurnAction(csvTurn, {
      type: "github_comment",
      repo: "northwind/ledger",
      number: 201,
      body: "Fixed in #219: the importer now strips a UTF-8 BOM before reading the header. Regression test added.",
      close: "issue",
    });
    store.updateTask(csv, {
      agent_state: AgentState.agentdone,
      unread_result: 1,
    });

    // 7. Waiting on someone, gone quiet: slipped.
    const marcus = seedTask(
      {
        channel: "slack",
        id: "s:C09:1",
        thread: "slack:C09:1720.1",
        author: "U04",
        name: "Marcus Reed",
        title: "#facilities",
        minutes: 60 * 24 * 5,
        body: "I'll get you the badge printer quote by Tuesday.",
        meta: { channel: "C09", ts: "1720.1" },
      },
      {
        title: "Badge printer quote from Marcus",
        summary: "Marcus promised the quote by Tuesday.",
        kind: Kind.task,
        reason: "a promise owed to you",
      },
    );
    store.updateTask(marcus, { waiting_on: "Marcus Reed" });

    // 8. Watching: someone else handles it.
    seedTask(
      {
        channel: "github",
        id: "gh:4:a",
        thread: "github:northwind/infra#12",
        author: "devon",
        name: "devon",
        title: "northwind/infra#12 issue: Rotate staging certs (team mention)",
        minutes: 200,
        url: "https://github.com/northwind/infra/issues/12",
        body: "Staging certs expire on the 14th. I'll rotate them Thursday unless someone objects.",
        meta: {
          repo: "northwind/infra",
          number: 12,
          type: "Issue",
          reason: "team_mention",
        },
      },
      {
        title: "Rotate staging certs",
        summary: "Devon will rotate staging certs Thursday.",
        kind: Kind.task,
        reason: "Devon is handling it; you only care that it happens",
        watching: true,
      },
    );

    // 9. For later.
    const later = store.createTask({
      title: "Quarterly vendor spend review",
      kind: Kind.task,
      channel: "owner",
      createdAt: ago(60 * 24 * 3),
    });
    store.remindAt(later.id, inDays(2));

    // FYI
    for (const [i, m] of [
      {
        channel: "github" as const,
        author: "github-actions[bot]",
        name: "github-actions",
        title: "northwind/web: CI passed on main",
        body: "All checks have passed on main (a41f9c2).",
        reason: "a bot wrote it",
        minutes: 20,
      },
      {
        channel: "slack" as const,
        author: "U05",
        name: "Gail Moreno",
        title: "#general",
        body: "Heads up: the office is closed Monday for the floor refit. Remote day for everyone.",
        reason: "an announcement; nothing to do",
        minutes: 75,
      },
      {
        channel: "github" as const,
        author: "dependabot[bot]",
        name: "dependabot",
        title: "northwind/ledger#220 PR: Bump lodash from 4.17.20 to 4.17.21",
        body: "Bumps lodash. Release notes in the PR.",
        reason: "a bot wrote it",
        minutes: 180,
      },
    ].entries()) {
      const row = store.insertMessage({
        channel: m.channel,
        externalId: `fyi:${i}`,
        threadKey: `fyi:${i}`,
        author: m.author,
        authorName: m.name,
        title: m.title,
        body: m.body,
        receivedAt: ago(m.minutes),
      })!;
      store.fileMessage(row.id, "fyi", m.reason, null);
    }

    store.addIdea(
      "Ruth's renewal is waiting on your seat count",
      "The copier renewal signs this week and the reply is drafted. Sending it today keeps Ruth from signing for 60.",
      ruth,
    );

    store.addNote(
      "agent AUG-0006",
      "ready to push",
      "CSV BOM fix on fix/csv-bom, 14 tests green - safe to build on",
      csv,
    );
    store.addNote(
      "agent AUG-0006",
      "note",
      "the bank feed keeps inter-company transfers; the export drops them. That is the 4,180.",
      csv,
    );
    store.addNote(
      "you",
      "note",
      "the census sync is behind a VPN and will not run from a laptop",
    );
    store.addKnowledge(
      "ledger",
      "Bank CSVs carry a UTF-8 BOM",
      "The bank's CSV export starts with a byte-order mark. Strip it before reading the header (`encoding='utf-8-sig'`), or the first column is named `\\ufeffdate`.",
      "agent AUG-0006",
    );
    store.addKnowledge(
      "ledger",
      "Inter-company transfers",
      "Transfers between Northwind entities post on both sides. The GL export must keep them; the consolidation step removes the pair.",
      "agent AUG-0006",
    );

    // A project holding both ledger fixes, so the rail has one to show.
    const ledger = store.createProject({
      name: "ledger fixes",
      tmuxSession: "ledger-fixes",
      repos: ["northwind/ledger"],
    });
    store.updateProject(ledger.id, {
      brief:
        "Month-end close runs from the ledger export without hand fixes.\nThe export must match the GL to the cent, and bank imports must load as they come.",
    });
    const exportGoal = store.addGoal(ledger.id, "Export matches the GL to the cent");
    const importGoal = store.addGoal(ledger.id, "Bank CSVs import as they come");
    store.addGoal(ledger.id, "Close checklist runs without hand steps");
    store.addProjectLink(
      ledger.id,
      "https://www.notion.so/northwind/Month-end-close",
      "month-end close runbook",
      "you",
    );
    store.updateTask(exp, { project_id: ledger.id, goal_id: exportGoal.id });
    store.updateTask(csv, { project_id: ledger.id, goal_id: importGoal.id });
  });

  const learned = readDoc(DocName.learned)
    .replace(
      "## Your people\n",
      "## Your people\n- Erin Blake is your manager: her asks are important. [s:5 | ev: c2,c9,c14 | seen: 2026-11-03]\n",
    )
    .replace(
      "## How you work\n",
      "## How you work\n- You lead replies with the number, then one line of context. [s:4 | ev: c4,c7,c11 | seen: 2026-11-04]\n",
    )
    .replace(
      "## Watching\n",
      "## Watching\n- Dependabot PRs on ledger are FYI unless a test fails. [s:2 | ev: c15 | seen: 2026-11-05]\n",
    );
  writeDoc(DocName.learned, learned);
}

// ── the canned brain ──────────────────────────────────────────────────────

const STEPS = ["Read the thread", "WebSearch the ask", "Read notes.md"];

async function demoBrain(call: BrainCall): Promise<BrainResult> {
  const props = (call.schema?.properties ?? {}) as Record<string, unknown>;
  const done = (structured: unknown): BrainResult => ({
    text: "",
    structured,
    sessionId: call.sessionId ?? call.resume ?? null,
    durationMs: 1,
    isError: false,
  });

  if ("did" in props) {
    for (const step of STEPS) {
      if (call.signal?.aborted) throw new Error("stopped");
      await sleep(700);
      call.onStep?.(step);
    }
    await sleep(500);
    if (call.cwd) {
      writeFileSync(
        join(call.cwd, "summary.md"),
        "# Summary\n\nThe demo agent's write-up: **three findings**, one recommendation.\n\n- Overtime is concentrated at Fairhaven and Dockside\n- Two sites closed mid-month\n- Weekend shifts drive 60% of it\n",
      );
      writeFileSync(
        join(call.cwd, "numbers.csv"),
        "site,hours\nFairhaven,412\nDockside,288\nNorthgate,167\n",
      );
    }
    const asked = call.prompt
      .match(/The owner typed:\n(.+)/g)
      ?.pop()
      ?.replace("The owner typed:\n", "");
    const replyOwed = /Came from: (slack|github)/.test(call.prompt);
    return done({
      about: asked
        ? `You said: "${asked.slice(0, 80)}"`
        : "The ask on this thread.",
      did: "This is the demo: there is no AI behind it, so this turn is canned. In your own aug the agent reads the thread, does the research, and answers here.",
      next: replyOwed ? "A reply is set up below." : "Nothing left to do here.",
      state: replyOwed ? "ready" : "done",
      ...(replyOwed
        ? {
            action: {
              kind: "reply",
              text: "Thanks - on it, I'll have this to you by end of day.",
            },
          }
        : {}),
    });
  }
  // Home: the Assistant answers in words, after looking things up.
  if (call.env?.AUG_ASKED_BY === "assistant") {
    const named = [...call.prompt.matchAll(/^(AUG-\d{4}) \[[^\]]*\] (.+?)(?: \(project .+\))?$/gm)];
    const asked = call.prompt.includes("## Tasks the owner named")
      ? call.prompt.split("## Tasks the owner named\n")[1].split("\n")[0]
      : null;
    for (const step of ["Bash aug-tools tasks", ...(asked ? [`Bash aug-tools task ${asked.slice(0, 8)}`] : [])]) {
      await sleep(600);
      call.onStep?.(step);
    }
    const text = asked
      ? `This is the demo, so I answer from a script. You named **${asked}**. In your own aug I'd read it, answer, and move it if you asked: make a coding task from it, put it in a project, start its agent.`
      : `This is the demo, so I answer from a script. There are ${named.length} open tasks. Name one with @ and ask me about it, or tell me to make, move, start or close something.`;
    return { ...done(null), text };
  }
  if ("ideas" in props) return done({ ideas: [] });
  if ("verdict" in props)
    return done({
      verdict: "general",
      title: "A demo ask",
      summary: "",
      priority: "regular",
      reason: "demo triage",
    });
  if ("section" in props) {
    const correction = call.prompt.split("\n")[0].replace("Correction: ", "");
    return done({
      skip: false,
      section: "What you care about",
      text: `${correction} (demo lesson)`,
      strength: 2,
    });
  }
  return done(null);
}

// A scratch home unless you named one. An agent's window carries aug's own
// AUG_HOME (for aug-tools); a demo run there would reconcile aug's live
// sessions against the empty demo tmux server and mark every claude gone.
// Your real home is never the demo's either.
export function demoHome(env: Record<string, string | undefined> = process.env): string {
  const named = env.AUG_HOME;
  if (named && !env.AUG && resolve(named) !== resolve(defaultHome())) return named;
  return mkdtempSync(join(tmpdir(), "aug-demo-"));
}

export function installFixture(name: string): Engine {
  if (name !== "demo") throw new Error(`unknown fixture "${name}" (try: demo)`);
  process.env.AUG_HOME = demoHome();
  useDb(openDb());
  // Coding agents run on a private tmux server, never your own.
  setConfigForTest({
    ...DEFAULT_CONFIG,
    autostart: false,
    tmuxSocket: "aug-demo",
  });
  ensureDocs();
  if (store.listTasks().length === 0) seedDemo();
  setBrain(demoBrain);
  setSender(async () => {
    await sleep(300);
    return "the demo: nothing was sent (in your own aug this is where it goes)";
  });
  const fake = fileURLToPath(new URL("./fake-claude.ts", import.meta.url));
  return new Engine({
    offline: true,
    noWorktrees: true,
    launchOverride: (task, launch) => ({
      ...launch,
      argv: [process.execPath, fake, task.title],
    }),
  });
}
