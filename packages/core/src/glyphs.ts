// Whether the terminal can draw Nerd Font glyphs. A terminal cannot be asked
// which font it uses, so config's nerdFont says; unset, a Nerd Font installed
// on this machine is the guess (the one who installs one usually runs it).

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RikerConfig } from "./config";

const FONT_DIRS = [
  join(homedir(), "Library", "Fonts"),
  "/Library/Fonts",
  join(homedir(), ".local", "share", "fonts"),
  join(homedir(), ".fonts"),
  "/usr/share/fonts",
  "/usr/local/share/fonts",
];

const NERD_FILE = /nerd ?font/i;

function hasNerdFont(dir: string, depth: number): boolean {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    if (NERD_FILE.test(e.name)) {
      return true;
    }
    if (
      depth > 0 &&
      e.isDirectory() &&
      hasNerdFont(join(dir, e.name), depth - 1)
    ) {
      return true;
    }
  }
  return false;
}

let installed: boolean | null = null;

// Read once per process: rows ask on every render.
export function nerdFontInstalled(dirs = FONT_DIRS): boolean {
  if (dirs !== FONT_DIRS) {
    return dirs.some((d) => hasNerdFont(d, 2));
  }
  installed ??= FONT_DIRS.some((d) => hasNerdFont(d, 2));
  return installed;
}

export function nerdFont(config: Pick<RikerConfig, "nerdFont">): boolean {
  return config.nerdFont ?? nerdFontInstalled();
}
