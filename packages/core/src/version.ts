// Riker's version is the root package.json's: the release workflow bumps it
// (packages/cli/script/version.ts) and tags the commit, and a compiled binary
// carries it because the bundler inlines the JSON.

import root from "../../../package.json" with { type: "json" };

export const VERSION: string = root.version;
