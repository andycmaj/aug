import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../src/core/config";
import {
  ARCHIVE,
  DocName,
  docHash,
  docPath,
  forPrompt,
  LEARNED_HEADER,
  learnedInUse,
  readArchive,
  readDoc,
  shippedText,
  staleWatching,
  trashDir,
  withLearnedSections,
  writeDoc,
} from "../src/core/docs";
import { archiveStale, runDocPass } from "../src/core/doc-pass";
import {
  mergePersona,
  migrateSoul,
  offerOnboarding,
  syncDocs,
  syncShipped,
} from "../src/core/doc-sync";
import { Engine } from "../src/core/engine";
import { applyLesson, PROMOTE_AT } from "../src/core/learn";
import { setMux } from "../src/core/mux";
import {
  acceptProposals,
  onboardingTask,
  propose,
  redraftProposals,
  rejectProposals,
  writeReview,
} from "../src/core/proposals";
import { buildRail, Section } from "../src/core/rail";
import * as store from "../src/core/store";
import {
  Kind,
  MoveStatus,
  ProposalSource,
  ProposalStatus,
  TaskStatus,
  TurnRole,
} from "../src/core/types";
import { ASSISTANT_TOOLS, assistantAllow } from "../src/core/assistant";
import { ONBOARD_START } from "../src/core/onboard";
import { inTmux } from "../src/core/driver";
import { docDraftsDir } from "../src/core/paths";
import { REAL_JOB } from "./doc-fixture";
import { FakeMux } from "./fake-mux";
import { fakeBrain, freshHome } from "./helpers";

// The shipped SOUL.md and COUNSEL.md before PERSONA.md.
const OLD_SOUL = `# SOUL

Rules that outrank everything else.

- Nothing goes out without my press. Draft; never send.
- Never share credentials, tokens or private repository contents outside the thread they came from.
- When unsure whether something is mine, say so and ask.
`;
const OLD_COUNSEL = `# COUNSEL

Speak plainly and briefly. Take a position when asked; say what you would do and why in one line.
`;

function systemTasks() {
  return store
    .listTasks()
    .filter((t) => t.kind === Kind.system && t.status === TaskStatus.open);
}

beforeEach(() => {
  freshHome();
});

describe("the SOUL to PERSONA rename", () => {
  test("the old shipped pair becomes exactly the new shipped PERSONA.md", () => {
    expect(mergePersona(OLD_SOUL, OLD_COUNSEL)).toBe(
      shippedText(DocName.persona),
    );
  });

  test("an edited SOUL.md keeps its words, and old names are rewritten", () => {
    writeFileSync(docPath("SOUL.md"), "# SOUL\n\n- Never ping Dana after 6pm.\n");
    writeFileSync(docPath("COUNSEL.md"), OLD_COUNSEL);
    writeDoc(DocName.learned, "# LEARNED\n\nSOUL.md always outranks this file.\n");
    // As an install before the rename: PERSONA.md not seeded yet.
    Bun.spawnSync(["rm", docPath(DocName.persona)]);
    expect(migrateSoul()).toBe(true);
    const persona = readDoc(DocName.persona);
    expect(persona).toStartWith("# PERSONA\n\n- Never ping Dana after 6pm.");
    expect(persona).toContain("## How you speak to me\n\nSpeak plainly");
    expect(existsSync(docPath("SOUL.md"))).toBe(false);
    expect(existsSync(docPath("COUNSEL.md"))).toBe(false);
    expect(readDoc(DocName.learned)).toContain("PERSONA.md always outranks");
    const trashed = readdirSync(trashDir());
    expect(trashed.some((f) => f.startsWith("SOUL."))).toBe(true);
    expect(trashed.some((f) => f.startsWith("LEARNED."))).toBe(true);
    expect(migrateSoul()).toBe(false);
  });

  test("syncDocs renames before seeding, so SOUL.md's text survives", () => {
    Bun.spawnSync(["rm", docPath(DocName.persona)]);
    writeFileSync(docPath("SOUL.md"), "# SOUL\n\n- Mine.\n");
    syncDocs();
    expect(readDoc(DocName.persona)).toBe("# PERSONA\n\n- Mine.\n");
  });

  test("an untouched install migrates to the shipped PERSONA.md and is never asked", () => {
    Bun.spawnSync(["rm", docPath(DocName.persona)]);
    writeFileSync(docPath("SOUL.md"), OLD_SOUL);
    writeFileSync(docPath("COUNSEL.md"), OLD_COUNSEL);
    const result = syncDocs();
    expect(result.migrated).toBe(true);
    expect(readDoc(DocName.persona)).toBe(shippedText(DocName.persona));
    expect(result.asked).toEqual([]);
  });
});

describe("shipped updates: notify, never merge", () => {
  test("first run records what is there; only an edited shipped doc is asked about", () => {
    writeDoc(DocName.coding, "# CODING\n\nMy own rules.\n");
    writeDoc(DocName.job, "# JOB\n\nMine.\n");
    const { updated, asked } = syncShipped();
    expect(updated).toEqual([]);
    expect(asked).toEqual([DocName.coding]);
    expect(readDoc(DocName.coding)).toBe("# CODING\n\nMy own rules.\n");
    expect(systemTasks().map((t) => t.title)).toEqual([
      "CODING.md: new shipped version",
    ]);
    // Each shipped change is announced once.
    expect(syncShipped().asked).toEqual([]);
    expect(systemTasks()).toHaveLength(1);
  });

  test("a doc still exactly the old shipped text is replaced silently", () => {
    const old = "# TRIAGE\n\nOld shipped rules.\n";
    writeDoc(DocName.triage, old);
    store.kvSet(`doc.shipped.${DocName.triage}`, docHash(old));
    const { updated, asked } = syncShipped();
    expect(updated).toEqual([DocName.triage]);
    expect(asked).toEqual([]);
    expect(readDoc(DocName.triage)).toBe(shippedText(DocName.triage));
    expect(readdirSync(trashDir()).some((f) => f.startsWith("TRIAGE."))).toBe(
      true,
    );
  });

  test("an edited owner doc is never asked about", () => {
    store.kvSet(`doc.shipped.${DocName.job}`, docHash("# JOB\n\nold template\n"));
    writeDoc(DocName.job, "# JOB\n\nMine.\n");
    expect(syncShipped()).toEqual({ updated: [], asked: [] });
    expect(readDoc(DocName.job)).toBe("# JOB\n\nMine.\n");
  });

  test("take shipped writes it and trashes yours; keep mine leaves yours", () => {
    writeDoc(DocName.coding, "# CODING\n\nMine.\n");
    syncShipped();
    const [task] = systemTasks();
    expect(writeReview(task.id)?.empty).toBe(false);
    expect(acceptProposals(task.id)).toBe("wrote CODING.md");
    expect(readDoc(DocName.coding)).toBe(shippedText(DocName.coding));
    expect(store.getTask(task.id)!.status).toBe(TaskStatus.done);
    const copy = readdirSync(trashDir()).find((f) => f.startsWith("CODING."))!;
    expect(readFileSync(join(trashDir(), copy), "utf8")).toBe(
      "# CODING\n\nMine.\n",
    );

    writeDoc(DocName.assistant, "# ASSISTANT\n\nMine.\n");
    store.kvSet(`doc.shipped.${DocName.assistant}`, "older");
    syncShipped();
    const [second] = systemTasks();
    expect(rejectProposals(second.id)).toBe("kept your ASSISTANT.md");
    expect(readDoc(DocName.assistant)).toBe("# ASSISTANT\n\nMine.\n");
  });
});

describe("proposals", () => {
  test("a second proposal for a doc revises the open one", () => {
    const a = propose({
      doc: DocName.job,
      source: ProposalSource.evolve,
      proposed: "# JOB\n\nv1\n",
      reason: "first",
    });
    const b = propose({
      doc: DocName.job,
      source: ProposalSource.evolve,
      proposed: "# JOB\n\nv2\n",
      reason: "second",
    });
    expect(b.id).toBe(a.id);
    expect(b.proposed).toBe("# JOB\n\nv2\n");
    expect(systemTasks()).toHaveLength(1);
  });

  test("accepting moves the absorbed lessons from LEARNED.md to the archive", () => {
    const lesson =
      "- Erin's asks are important. [s:3 | ev: c1,c2 | seen: 2026-11-01]";
    writeDoc(
      DocName.learned,
      readDoc(DocName.learned).replace("## Your people\n", `## Your people\n${lesson}\n`),
    );
    const p = propose({
      doc: DocName.job,
      source: ProposalSource.evolve,
      proposed: "# JOB\n\nErin Blake is my manager: her asks are important.\n",
      reason: "a settled lesson about Erin",
      absorbs: [lesson],
    });
    acceptProposals(p.task_id);
    expect(readDoc(DocName.job)).toContain("Erin Blake is my manager");
    expect(readDoc(DocName.learned)).not.toContain("Erin's asks");
    expect(readArchive()).toContain("absorbed into JOB.md");
    expect(readArchive()).toContain("Erin's asks are important");
    expect(store.getProposal(p.id)!.status).toBe(ProposalStatus.accepted);
  });

  test("the owner's notes redraft a proposal in place", async () => {
    const calls = fakeBrain(() => ({ text: "# STYLE\n\nTerse.", reason: "shorter" }));
    const p = propose({
      doc: DocName.style,
      source: ProposalSource.evolve,
      proposed: "# STYLE\n\nVery long.\n",
    });
    expect(await redraftProposals(p.task_id, "## STYLE.md:3\ntoo long")).toBe(
      "redrafted STYLE.md",
    );
    expect(store.getProposal(p.id)!.proposed).toBe("# STYLE\n\nTerse.\n");
    expect(calls[0].prompt).toContain("too long");
  });

  test("notes on a shipped version are kept and answered, not dropped", async () => {
    writeDoc(DocName.coding, "# CODING\n\nMine.\n");
    syncShipped();
    const [task] = systemTasks();
    expect(await redraftProposals(task.id, "why the change?")).toBe(
      "nothing to redraft",
    );
    const turns = store.turnsForTask(task.id);
    expect(turns.map((t) => t.role)).toEqual([TurnRole.you, TurnRole.trigger]);
  });

  test("a closed System task's proposal is not revised: a new one opens", () => {
    const a = propose({ doc: DocName.job, source: ProposalSource.evolve, proposed: "a\n" });
    store.updateTask(a.task_id, { status: TaskStatus.done });
    const b = propose({ doc: DocName.job, source: ProposalSource.evolve, proposed: "b\n" });
    expect(b.task_id).not.toBe(a.task_id);
  });

  test("System tasks sit in their own rail section", () => {
    propose({ doc: DocName.job, source: ProposalSource.evolve, proposed: "x\n" });
    const sections = buildRail({
      tasks: store.listTasks(),
      pendingActions: new Set(),
      ideas: [],
      fyi: [],
      lastHeard: new Map(),
      now: new Date(),
    });
    expect(sections.map((s) => s.section)).toEqual([Section.system]);
  });
});

describe("LEARNED.md", () => {
  test("lessons go in use at strength 3", () => {
    expect(PROMOTE_AT).toBe(3);
    const { text } = applyLesson(
      readDoc(DocName.learned),
      { skip: false, section: "How you work", text: "Lead with the number", strength: 3 },
      "c1",
      "2026-11-13",
    );
    expect(learnedInUse(text)).toContain("Lead with the number");
  });

  test("the header comes from code; the file's own header is not read", () => {
    const inUse = learnedInUse("# LEARNED\n\nSOUL.md outranks.\n\n## How you work\n- x\n");
    expect(inUse).toStartWith(LEARNED_HEADER);
    expect(inUse).not.toContain("SOUL.md");
    expect(inUse).toContain("- x");
  });

  test("a missing section is added; lines are never touched", () => {
    const text = withLearnedSections("# LEARNED\n\n## How you work\n- mine\n\n## Watching\n- w\n");
    expect(text).toContain("## Your people");
    expect(text.indexOf("## Promises")).toBeLessThan(text.indexOf("## Watching"));
    expect(text).toContain("- mine");
    expect(text).toContain("- w");
  });

  test("Watching lines unseen for 30 days go to the archive", () => {
    const old = "- old guess [s:2 | ev: c1 | seen: 2026-09-01]";
    const fresh = "- new guess [s:2 | ev: c2 | seen: 2026-11-10]";
    const owner = "- owner's own line";
    const text = `# LEARNED\n\n## How you work\n${owner}\n\n## Watching\n${old}\n${fresh}\n`;
    expect(staleWatching(text, new Date("2026-11-13")).stale).toEqual([old]);
    writeDoc(DocName.learned, text);
    expect(archiveStale(new Date("2026-11-13"))).toBe(1);
    expect(readDoc(DocName.learned)).toContain(fresh);
    expect(readDoc(DocName.learned)).not.toContain("old guess");
    expect(readFileSync(docPath(ARCHIVE), "utf8")).toContain("stale");
  });
});

describe("budgets", () => {
  test("a doc is whole up to twice its budget, then cut with a note", () => {
    freshHome({ ...DEFAULT_CONFIG, docBudgets: { "STYLE.md": 10 } });
    expect(forPrompt(DocName.style, "x".repeat(20))).toBe("x".repeat(20));
    const cut = forPrompt(DocName.style, "x".repeat(50));
    expect(cut).toStartWith("x".repeat(20) + "\n(cut at budget");
  });
});

describe("the daily doc pass", () => {
  test("nothing new and nothing over budget: no model call", async () => {
    const calls = fakeBrain(() => ({ edits: [] }));
    await runDocPass(new Date("2026-11-13T09:00:00Z"));
    expect(calls).toHaveLength(1);
    const next = await runDocPass(new Date("2026-11-14T10:00:00Z"));
    expect(next.skipped).toBe("nothing new");
    expect(calls).toHaveLength(1);
    const early = await runDocPass(new Date("2026-11-14T11:00:00Z"));
    expect(early.skipped).toBe("not due");
  });

  test("an edit becomes a proposal, an aug-shaped lesson an idea", async () => {
    fakeBrain(() => ({
      edits: [
        { doc: "JOB.md", text: "# JOB\n\nShip the ledger.", reason: "settled" },
        { doc: "CODING.md", text: "nope", reason: "shipped docs are off limits" },
      ],
      ideas: [{ title: "Teach CODING.md to run lint", body: "Agents skip lint." }],
    }));
    const result = await runDocPass(new Date());
    expect(result.proposed).toBe(1);
    expect(result.ideas).toBe(1);
    const [task] = systemTasks();
    expect(task.title).toBe("JOB.md: proposed edit");
    expect(readDoc(DocName.job)).toBe(shippedText(DocName.job));
  });

  test("an edit still over budget and no smaller is dropped", async () => {
    freshHome({ ...DEFAULT_CONFIG, docBudgets: { "STYLE.md": 10 } });
    fakeBrain(() => ({
      edits: [{ doc: "STYLE.md", text: "y".repeat(500), reason: "longer" }],
    }));
    expect((await runDocPass(new Date(), true)).proposed).toBe(0);
  });
});

describe("onboarding", () => {
  let mux: FakeMux;
  beforeEach(() => {
    fakeBrain(() => null);
    mux = new FakeMux();
    setMux(mux);
  });

  // The window's start runs after acceptDocs answers.
  const settle = () => new Promise((r) => setTimeout(r, 20));

  test("offered once, and y starts the interview in the task's own claude", async () => {
    expect(offerOnboarding()).toBe(true);
    expect(offerOnboarding()).toBe(false);
    const offer = onboardingTask()!;
    expect(offer.title).toBe("Set up your docs: a short interview");
    expect(inTmux(offer)).toBe(true);
    const engine = new Engine();
    expect(engine.desk.acceptDocs(offer.id)).toBe(
      `the interview is starting in ${store.taskRef(offer.id)}`,
    );
    await settle();
    const [window] = mux.windows;
    expect(window!.taskId).toBe(offer.id);
    expect(window!.cwd).toBe(docDraftsDir());
    expect(window!.argv[0]).toBe("claude");
    const system = window!.argv[window!.argv.indexOf("--append-system-prompt") + 1]!;
    expect(system).toContain("onboarding interview");
    expect(system).toContain(`--file ${join(docDraftsDir(), "PERSONA.md")}`);
    expect(window!.argv.at(-1)).toBe(ONBOARD_START);
    expect(engine.desk.isLive(store.getTask(offer.id)!)).toBe(true);
    // Home is not involved.
    expect(
      store.turnsForTask(store.homeTask().id).some((t) => t.role === TurnRole.trigger),
    ).toBe(false);
  });

  test("the interview's own agent may hand drafts in, and nothing else", async () => {
    offerOnboarding();
    const engine = new Engine();
    const offer = onboardingTask()!;
    const by = `agent ${store.taskRef(offer.id)}`;
    const ok = store.enqueueMove("propose_doc", { doc: "JOB", text: "draft" }, by);
    const no = store.enqueueMove("new", { title: "x" }, by);
    await engine.drainMoves();
    expect(store.getMove(ok.id)!.status).toBe(MoveStatus.done);
    expect(store.getMove(no.id)!.result).toContain("the owner's move");
    expect(store.proposalsForTask(offer.id).map((p) => p.doc)).toEqual(["JOB.md"]);
  });

  test("y on the drafts closes the interview's window", async () => {
    offerOnboarding();
    const engine = new Engine();
    const offer = onboardingTask()!;
    engine.desk.acceptDocs(offer.id);
    await settle();
    propose({ doc: DocName.job, source: ProposalSource.onboard, proposed: "# JOB\n" });
    expect(mux.windows).toHaveLength(1);
    expect(engine.desk.acceptDocs(offer.id)).toBe("wrote JOB.md");
    await settle();
    expect(mux.windows).toHaveLength(0);
  });

  test("the Assistant's drafts land on the onboarding task", async () => {
    offerOnboarding();
    const engine = new Engine();
    const offer = onboardingTask()!;
    for (const doc of ["PERSONA", "JOB"])
      store.enqueueMove(
        "propose_doc",
        { doc, text: `# ${doc}\n\ndraft`, reason: "interview" },
        "assistant",
      );
    const bad = store.enqueueMove(
      "propose_doc",
      { doc: "CODING", text: "x" },
      "assistant",
    );
    await engine.drainMoves();
    expect(store.getMove(bad.id)!.result).toContain("PERSONA | JOB | STYLE");
    const proposals = store.proposalsForTask(offer.id);
    expect(proposals.map((p) => p.doc)).toEqual(["PERSONA.md", "JOB.md"]);
    expect(store.getTask(offer.id)!.title).toBe(
      "Your docs, drafted from the interview",
    );
    expect(engine.desk.acceptDocs(offer.id)).toBe("wrote PERSONA.md, JOB.md");
    expect(readDoc(DocName.job)).toBe("# JOB\n\ndraft\n");
  });

  test("a whole doc handed in as a file, Markdown and all", async () => {
    offerOnboarding();
    const engine = new Engine();
    const offer = onboardingTask()!;
    const file = join(docDraftsDir(), "JOB.md");
    writeFileSync(file, REAL_JOB);
    const ok = store.enqueueMove(
      "propose_doc",
      { doc: "JOB", file, reason: "interview" },
      "assistant",
    );
    // A bare name is read from the drafts folder too.
    writeFileSync(join(docDraftsDir(), "STYLE.md"), "# STYLE\n\n## Tone\nShort.\n");
    const bare = store.enqueueMove(
      "propose_doc",
      { doc: "STYLE", file: "STYLE.md" },
      "assistant",
    );
    await engine.drainMoves();
    expect(store.getMove(ok.id)!.result).toContain("JOB.md proposed on");
    expect(store.getMove(bare.id)!.status).toBe(MoveStatus.done);
    const [job] = store.proposalsForTask(offer.id).filter((p) => p.doc === "JOB.md");
    expect(job!.proposed).toBe(REAL_JOB);
    expect(existsSync(file)).toBe(false);
  });

  test("propose_doc reads no file outside the drafts folder", async () => {
    const engine = new Engine();
    const outside = join(process.env.AUG_HOME!, "config.json");
    writeFileSync(outside, "{}");
    const cases = [
      [{ doc: "JOB", file: outside }, "must be in"],
      [{ doc: "JOB", file: "../../config.json" }, "must be in"],
      [{ doc: "JOB", file: "nope.md" }, "no such file"],
      [{ doc: "JOB" }, "needs --file or --text"],
      [{ doc: "JOB", file: "x.md", text: "y" }, "not both"],
    ] as const;
    const moves = cases.map(([args]) =>
      store.enqueueMove("propose_doc", { ...args }, "assistant"),
    );
    await engine.drainMoves();
    cases.forEach(([, want], i) =>
      expect(store.getMove(moves[i]!.id)!.result).toContain(want),
    );
    expect(existsSync(outside)).toBe(true);
  });

  test("the Assistant may write only in the drafts folder", () => {
    expect(ASSISTANT_TOOLS).toContain("Write");
    const writes = assistantAllow().filter((r) => /^(Edit|Write)\b/.test(r));
    expect(writes).toEqual([`Edit(/${docDraftsDir()}/**)`]);
  });

  test("the onboard move from the Assistant starts the interview's claude", async () => {
    const engine = new Engine();
    const move = store.enqueueMove("onboard", {}, "assistant");
    await engine.drainMoves();
    const task = onboardingTask()!;
    expect(store.getMove(move.id)!.result).toBe(
      `the interview is starting in ${store.taskRef(task.id)}`,
    );
    await settle();
    expect(mux.windows.map((w) => w.taskId)).toEqual([task.id]);
  });

  test("x on the offer skips it and the templates stay", () => {
    offerOnboarding();
    const engine = new Engine();
    expect(engine.desk.rejectDocs(onboardingTask()!.id)).toBe(
      "onboarding skipped: the templates stay",
    );
    expect(readDoc(DocName.persona)).toBe(shippedText(DocName.persona));
  });
});
