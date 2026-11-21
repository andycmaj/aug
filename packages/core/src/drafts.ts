// The scratch file $EDITOR opens on a draft, a brief or a chat message. One
// per task and purpose, so two never collide; read back trimmed, or null
// when the editor removed it.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./paths";

export function draftFile(ref: string, purpose = ""): string {
  return join(paths.drafts(), `${ref}${purpose ? `-${purpose}` : ""}.md`);
}

export function writeDraft(file: string, text: string): void {
  writeFileSync(file, text);
}

export function readDraft(file: string): string | null {
  return existsSync(file) ? readFileSync(file, "utf8").trimEnd() : null;
}

export function removeDraft(file: string): void {
  rmSync(file, { force: true });
}
