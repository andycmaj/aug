// The GitHub Pages site: docs/architecture.html and docs/keyboard.html as
// they are, each with one shared nav strip, plus a small index. The keyboard
// page's data is rebuilt from the keymap here, so the published page follows
// the code even if the committed copy lags. Nothing else under docs/ is
// published.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { withKeysData } from "./keys-doc";

export const DOCS_DIR = join(import.meta.dir, "../../../docs");

const REPO = "https://github.com/andycmaj/riker";

// The README and architecture.html open with these same words.
export const TAGLINE =
  "Your first officer, in a terminal. It triages GitHub and Slack and drafts your replies, but that is only part of the job: it also runs your crew of Claude agents, starting and stopping them, tracking tasks, projects and worktrees, and keeping the work moving.";

export interface SitePage {
  file: string;
  label: string;
  blurb: string;
}

export const SITE_PAGES: SitePage[] = [
  {
    file: "architecture.html",
    label: "architecture",
    blurb:
      "How Riker is built: packages and plugins, triage, the agent lifecycle, moves, the store and every source file.",
  },
  {
    file: "keyboard.html",
    label: "keys",
    blurb:
      "Every key, by where you are: the rail, the Canvas, the chat box, an attached agent, the Board, a dialog.",
  },
];

// Both pages define these tokens (light and dark), so the strip takes each
// page's own look. Their body pads 16px (or the safe area) each side; the
// strip reaches past it to the edges.
const NAV_STYLE = `<style>
.site-nav { position: sticky; top: 0; z-index: 50; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; margin-inline: calc(-1 * max(16px, env(safe-area-inset-left, 0px))) calc(-1 * max(16px, env(safe-area-inset-right, 0px))); padding: 8px 16px; background: var(--surface); border-bottom: 1px solid var(--line); font-family: var(--f-display); font-size: 12px; letter-spacing: .02em; }
.site-nav .brand { font-weight: 700; color: var(--ink); text-decoration: none; margin-right: 6px; }
.site-nav a { color: var(--muted); text-decoration: none; padding: 2px 0; border-bottom: 2px solid transparent; }
.site-nav a:hover { color: var(--ink); }
.site-nav a[aria-current="page"] { color: var(--accent); border-bottom-color: var(--accent); }
.site-nav .gh { margin-left: auto; }
</style>`;

export function siteNav(current: string): string {
  const links = SITE_PAGES.map(
    (p) =>
      `<a href="${p.file}"${p.file === current ? ' aria-current="page"' : ""}>${p.label}</a>`,
  ).join("");
  return `${NAV_STYLE}
<nav class="site-nav" aria-label="Site"><a class="brand" href="./">riker</a>${links}<a class="gh" href="${REPO}">github</a></nav>`;
}

export function withNav(html: string, current: string): string {
  const at = html.indexOf("<body>");
  if (at < 0) {
    throw new Error(`${current} has no <body>`);
  }
  const end = at + "<body>".length;
  return html.slice(0, end) + "\n" + siteNav(current) + html.slice(end);
}

// The index borrows architecture.html's tokens and fonts so it matches.
function indexPage(): string {
  const arch = readFileSync(join(DOCS_DIR, "architecture.html"), "utf8");
  const head = arch.slice(0, arch.indexOf("</head>"));
  // Its tokens (light, dark by preference, dark by data-theme) open its
  // stylesheet and end where the rules start.
  const from = head.indexOf(":root {");
  const to = head.indexOf("* { box-sizing", from);
  if (from < 0 || to < 0) {
    throw new Error("architecture.html has no :root tokens");
  }
  const tokens = head.slice(from, to).trimEnd();
  const fonts = head.match(
    /<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/,
  );
  const cards = SITE_PAGES.map(
    (p) =>
      `<a class="card" href="${p.file}"><span class="k">${p.label}</span><span class="d">${p.blurb}</span></a>`,
  ).join("\n    ");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Riker Docs</title>
<meta name="description" content="Riker, your first officer in a terminal: its architecture and its keys.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
${fonts?.[0] ?? ""}
<style>
${tokens}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--f-body); line-height: 1.55; padding-inline: max(16px, env(safe-area-inset-left, 0px)) max(16px, env(safe-area-inset-right, 0px)); }
.wrap { max-width: 760px; margin: 0 auto; padding: 48px 0 64px; }
.eyebrow { font-family: var(--f-display); font-size: 11px; text-transform: uppercase; letter-spacing: .12em; color: var(--muted); }
h1 { font-family: var(--f-display); font-size: 32px; margin: 6px 0 8px; }
p { color: var(--muted); margin: 0 0 28px; }
.cards { display: grid; gap: 12px; }
.card { display: grid; gap: 4px; padding: 16px 18px; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; text-decoration: none; color: var(--ink); }
.card:hover { border-color: var(--accent); }
.card .k { font-family: var(--f-display); font-weight: 700; color: var(--accent); }
.card .d { color: var(--muted); font-size: 14px; }
</style>
</head>
<body>
${siteNav("")}
<div class="wrap">
  <div class="eyebrow">docs · andycmaj/riker</div>
  <h1>Riker</h1>
  <p>${TAGLINE}</p>
  <div class="cards">
    ${cards}
  </div>
</div>
</body>
</html>
`;
}

// Published path to contents.
export function buildSite(): Record<string, string> {
  const site: Record<string, string> = {
    "index.html": indexPage(),
    ".nojekyll": "",
  };
  for (const p of SITE_PAGES) {
    let html = readFileSync(join(DOCS_DIR, p.file), "utf8");
    if (p.file === "keyboard.html") {
      html = withKeysData(html);
    }
    site[p.file] = withNav(html, p.file);
  }
  return site;
}
