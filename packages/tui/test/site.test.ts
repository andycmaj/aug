// The Pages site is public: it holds the two pages with the shared nav, the
// keyboard data straight from the keymap, and nothing that looks private.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keysDoc } from "../src/keys-doc";
import { buildSite, DOCS_DIR, SITE_PAGES, TAGLINE } from "../src/site";

const site = buildSite();

test("the site is the index and the two pages, each with the shared nav", () => {
  expect(Object.keys(site).sort()).toEqual(
    [".nojekyll", "architecture.html", "index.html", "keyboard.html"].sort(),
  );
  for (const file of ["index.html", ...SITE_PAGES.map((p) => p.file)]) {
    const html = site[file] ?? "";
    expect(html.match(/<nav class="site-nav"/g)?.length).toBe(1);
    for (const p of SITE_PAGES) {
      expect(html).toContain(`href="${p.file}"`);
    }
  }
  expect(site["keyboard.html"]).toContain(
    '<a href="keyboard.html" aria-current="page">',
  );
});

test("the published keyboard page carries the keymap's data", () => {
  const html = site["keyboard.html"] ?? "";
  const json = html.match(
    /<script type="application\/json" id="keys-data">([\s\S]*?)<\/script>/,
  )?.[1];
  expect(JSON.parse(json ?? "null")).toEqual(keysDoc());
});

test("the pages differ from docs/ only by the nav", () => {
  for (const p of SITE_PAGES) {
    if (p.file === "keyboard.html") {
      continue;
    }
    const src = readFileSync(join(DOCS_DIR, p.file), "utf8");
    const out = site[p.file] ?? "";
    expect(out.replace(/\n<style>\n\.site-nav[\s\S]*?<\/nav>/, "")).toBe(src);
  }
});

test("the index, the README and the architecture page share one tagline", () => {
  const flat = (s: string) => s.replace(/\s+/g, " ");
  const readme = readFileSync(join(DOCS_DIR, "../README.md"), "utf8");
  expect(site["index.html"]).toContain(`<p>${TAGLINE}</p>`);
  expect(site["architecture.html"]).toContain(
    `<p class="tagline">${TAGLINE}</p>`,
  );
  expect(flat(readme)).toContain(TAGLINE);
  expect(readme).toContain(
    "https://andycmaj.github.io/riker/architecture.html",
  );
});

// Anything that reads like a credential, a home path, an email or a Slack
// id stays off the public site.
const PRIVATE: [string, RegExp][] = [
  ["GitHub token", /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{10,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Anthropic key", /\bsk-ant-[A-Za-z0-9_-]{10,}/],
  ["AWS key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["home path", /\/(Users|home)\/[a-z][\w.-]*\//],
  ["email", /\b[\w.+-]+@[\w-]+\.(com|org|net|io|dev|co)\b/],
  ["Slack id", /\b[CDGUW]0[A-Z0-9]{8,10}\b/],
];

test("nothing on the site looks private", () => {
  for (const [file, html] of Object.entries(site)) {
    for (const [what, re] of PRIVATE) {
      expect({ file, what, hit: html.match(re)?.[0] ?? null }).toEqual({
        file,
        what,
        hit: null,
      });
    }
  }
});
