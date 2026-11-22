// The plugins a real Riker runs, in one list: the TUI's engine and
// riker-tools (a hook's `done --reply` builds its draft through them) read
// the same one. No Solid here, so riker-tools loads it plain.

import type { RikerPlugin } from "@riker/core/plugins";
import { githubPlugin } from "@riker/github";
import { slackPlugin } from "@riker/slack";
import { triagePlugin } from "@riker/triage";

export function rikerPlugins(): RikerPlugin[] {
  return [triagePlugin(), githubPlugin(), slackPlugin()];
}
