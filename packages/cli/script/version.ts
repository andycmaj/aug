#!/usr/bin/env bun
// A release's first step (.github/workflows/riker-release.yml): bump the root
// package.json's version (what `riker --version` says, core/version.ts),
// commit, tag vX.Y.Z, push, move the `latest` tag, and make a draft GitHub
// release with generated notes. The workflow's later jobs attach the binaries
// (script/compile.ts --all) and publish the draft. Installs come from the
// release's assets through mise; nothing goes to npm.
//
// Inputs (env, from workflow_dispatch):
//   RIKER_BUMP     "major" | "minor" | "patch" (default "patch")
//   RIKER_VERSION  an exact version, which wins over the bump
//
// Tags are plain vX.Y.Z: Riker is the only thing released from this repo,
// and unprefixed tags keep `mise use github:andycmaj/riker@1.2.3` natural.

import { $ } from "bun";
import { appendFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const BUMPS = ["major", "minor", "patch"] as const;
type Bump = (typeof BUMPS)[number];

export function bumpVersion(current: string, bump: Bump): string {
  const [major, minor, patch] = current
    .replace(/^v/, "")
    .split("-")[0]!
    .split(".")
    .map((n) => Number.parseInt(n, 10));
  if (major === undefined || minor === undefined || patch === undefined || [major, minor, patch].some(Number.isNaN))
    throw new Error(`cannot read a semver from "${current}"`);
  const next: Record<Bump, string> = {
    major: `${major + 1}.0.0`,
    minor: `${major}.${minor + 1}.0`,
    patch: `${major}.${minor}.${patch + 1}`,
  };
  return next[bump];
}

// The version a release makes: the override as given (without a leading v),
// else the bump of the current one.
export function nextVersion(current: string, bump: string | undefined, override: string | undefined): string {
  const exact = override?.trim().replace(/^v/, "");
  if (exact) {
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(exact)) throw new Error(`"${exact}" is not a version like 1.2.3`);
    return exact;
  }
  const raw = bump?.trim() || "patch";
  const chosen = BUMPS.find((b) => b === raw);
  if (!chosen) throw new Error(`RIKER_BUMP "${raw}": expected ${BUMPS.join(" | ")}`);
  return bumpVersion(current, chosen);
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "../../..");
  process.chdir(root);
  const pkgPath = join(root, "package.json");
  const pkg = (await Bun.file(pkgPath).json()) as { version: string };

  const version = nextVersion(pkg.version, process.env.RIKER_BUMP, process.env.RIKER_VERSION);
  const tag = `v${version}`;
  console.log(`${pkg.version} -> ${version} (tag ${tag})`);

  pkg.version = version;
  await Bun.write(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

  await $`git add package.json`;
  await $`git commit -m ${`chore: release ${tag}`}`;
  await $`git tag ${tag}`;
  await $`git push origin HEAD --tags`;

  const sha = (await $`git rev-parse HEAD`.text()).trim();
  await $`git tag -f latest ${sha}`;
  await $`git push origin refs/tags/latest --force`;

  await $`gh release create ${tag} --draft --target ${sha} --title ${tag} --generate-notes`;

  const output = [`version=${version}`, `tag=${tag}`];
  console.log(output.join("\n"));
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${output.join("\n")}\n`);
}
