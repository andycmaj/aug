// What happens to the brain docs when aug starts: the one-time SOUL to
// PERSONA rename, shipped docs kept up to date, LEARNED.md's sections, the
// onboarding offer, and the trash pruned.
//
// Shipped updates are notify-only. Per doc, `kv` holds the hash of the shipped
// text aug last saw. When the shipped text changes: a missing file is
// written; a file still exactly the old shipped text is replaced; a file the
// owner edited is left alone and, for a shipped doc, gets one SYSTEM task.
// Owner docs (PERSONA, JOB, STYLE) ship only templates, so an edited one is
// never asked about.

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import {
  DOC_CLASS,
  DocClass,
  docHash,
  DocName,
  docPath,
  ensureDocs,
  pruneTrash,
  readDoc,
  replaceDoc,
  shippedText,
  trashDoc,
  withLearnedSections,
  writeDoc,
} from "./docs";
import { logger } from "./log";
import { ONBOARD_TASK, propose, systemTask } from "./proposals";
import * as store from "./store";
import { ProposalSource } from "./types";

const log = logger("docs");

export interface SyncResult {
  migrated: boolean;
  // Replaced silently: the file was still the old shipped text.
  updated: DocName[];
  // Edited by the owner: a SYSTEM task asks.
  asked: DocName[];
}

// Before PERSONA.md there were SOUL.md (the red lines) and COUNSEL.md (how
// aug speaks to you). They become one file; the only owner text aug ever
// rewrites is the old names, inside the docs. Everything is in .trash first.
export function migrateSoul(at = new Date()): boolean {
  const soulFile = docPath("SOUL.md");
  const counselFile = docPath("COUNSEL.md");
  if (!existsSync(soulFile) && !existsSync(counselFile)) return false;
  const others = Object.values(DocName).filter((n) => existsSync(docPath(n)));
  for (const name of ["SOUL.md", "COUNSEL.md", ...others]) trashDoc(name, at);

  if (!existsSync(docPath(DocName.persona))) {
    const soul = existsSync(soulFile) ? readFileSync(soulFile, "utf8") : null;
    const counsel = existsSync(counselFile)
      ? readFileSync(counselFile, "utf8")
      : null;
    writeDoc(DocName.persona, mergePersona(soul, counsel));
  }
  if (existsSync(soulFile)) unlinkSync(soulFile);
  if (existsSync(counselFile)) unlinkSync(counselFile);

  for (const name of Object.values(DocName)) {
    const file = docPath(name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const renamed = text.replace(/\b(SOUL|COUNSEL)\.md\b/g, "PERSONA.md");
    if (renamed !== text) writeFileSync(file, renamed);
  }
  log.info("migrated SOUL.md and COUNSEL.md to PERSONA.md");
  return true;
}

// SOUL.md's text under a PERSONA heading, then COUNSEL.md's under its own.
// From the old shipped pair this gives exactly the new shipped PERSONA.md.
export function mergePersona(soul: string | null, counsel: string | null): string {
  const rules = (soul ?? "").replace(/^# SOUL\b.*$/m, "# PERSONA").trimEnd();
  const voice = (counsel ?? "").replace(/^# COUNSEL\b.*\n*/m, "").trim();
  const top = rules || "# PERSONA";
  return voice ? `${top}\n\n## How you speak to me\n\n${voice}\n` : `${top}\n`;
}

function shippedKey(name: DocName): string {
  return `doc.shipped.${name}`;
}

export function syncShipped(): Pick<SyncResult, "updated" | "asked"> {
  const updated: DocName[] = [];
  const asked: DocName[] = [];
  for (const name of Object.values(DocName)) {
    if (DOC_CLASS[name] === DocClass.learned) continue;
    const shipped = shippedText(name);
    const now = docHash(shipped);
    const was = store.kvGet(shippedKey(name));
    if (was === now) continue;
    if (!existsSync(docPath(name))) writeDoc(name, shipped);
    else {
      const mine = docHash(readDoc(name));
      if (mine === now) {
        // Already the new text.
      } else if (was && mine === was) {
        replaceDoc(name, shipped);
        updated.push(name);
      } else if (DOC_CLASS[name] === DocClass.shipped) {
        propose({
          doc: name,
          source: ProposalSource.shipped,
          proposed: shipped,
          reason: `aug ships a new ${name}; yours has edits`,
        });
        asked.push(name);
      }
    }
    store.kvSet(shippedKey(name), now);
  }
  return { updated, asked };
}

const OFFERED = "onboard.offered";

// Once per install: a SYSTEM task offering the interview. Never started by
// itself.
export function offerOnboarding(): boolean {
  if (store.kvGet(OFFERED)) return false;
  const task = systemTask(
    "Set up your docs: a short interview",
    [
      "The Assistant asks about your role, channels, priorities and how you work (reading Slack and GitHub first, so it only asks what it cannot find), then drafts PERSONA, JOB and STYLE for you to review here.",
      "",
      "y: start the interview in Home. x: skip it (the templates stay). Run it again any time: ask the Assistant to onboard you.",
    ].join("\n"),
  );
  store.kvSet(ONBOARD_TASK, String(task.id));
  store.kvSet(OFFERED, "1");
  return true;
}

// The rename runs before any missing file is seeded: a seeded PERSONA.md
// would hide SOUL.md's text.
export function syncDocs(opts: { offer?: boolean } = {}): SyncResult {
  const migrated = migrateSoul();
  ensureDocs();
  const result = syncShipped();
  const learned = readDoc(DocName.learned);
  const sectioned = withLearnedSections(learned);
  if (sectioned !== learned) writeDoc(DocName.learned, sectioned);
  if (opts.offer) offerOnboarding();
  pruneTrash();
  if (result.updated.length || result.asked.length)
    log.info("shipped docs", {
      updated: result.updated.join(","),
      asked: result.asked.join(","),
    });
  return { migrated, ...result };
}
