// What a link attached to a task or project may be, and how it opens. A web
// address goes to the system opener; a file on disk goes to $EDITOR and
// never to the opener, since `open` on a path runs whatever handles it.

import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

export type LinkTarget =
  | { type: "web"; url: string }
  | { type: "file"; path: string };

// The target a stored link names, or null when it is neither: a stored
// link may predate the check, so readers ask this rather than trust it.
export function linkTarget(link: string): LinkTarget | null {
  const clean = link.trim();
  if (!clean) {
    return null;
  }
  if (isAbsolute(clean)) {
    return { type: "file", path: clean };
  }
  if (!URL.canParse(clean)) {
    return null;
  }
  const parsed = new URL(clean);
  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return { type: "web", url: clean };
  }
  if (
    parsed.protocol !== "file:" ||
    (parsed.host && parsed.host !== "localhost")
  ) {
    return null;
  }
  try {
    return { type: "file", path: fileURLToPath(parsed) };
  } catch {
    return null;
  }
}

// The link as it is stored: trimmed, otherwise as given, so unlink matches
// it with the same words. A file must be a regular file now (not a folder,
// not an app bundle); one that goes later shows as gone.
export function checkLink(link: string): string | Error {
  const clean = link.trim();
  const target = linkTarget(clean);
  if (!target) {
    return new Error(
      `${clean || "url"} is not an http(s) URL or a file's absolute path`,
    );
  }
  if (target.type === "file" && !isFile(target.path)) {
    return new Error(`${target.path} is not a file on disk`);
  }
  return clean;
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
