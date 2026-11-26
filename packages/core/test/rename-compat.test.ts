// What still works for things made before aug was renamed Riker: env, refs,
// tmux tags, entrypoints, config skill names and what aug installed. One test
// per legacy fallback (docs/rename-riker.md).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envVar, inAgentEnv, optionFormat, refNumber } from "../src/brand";
import { guardScript, hooksHere, installHooks } from "../src/adopt";
import {
  INSTALLS,
  InstallState,
  installState,
  refreshInstalls,
  revdiffTargets,
} from "../src/install";
import { resolveLogSettings } from "../src/log";
import { mentionedTasks } from "../src/mentions";
import { homeAliases, paths } from "../src/paths";
import { toolsBin } from "../src/self";
import * as store from "../src/store";
import { parseClaudeProcess } from "../src/strays";
import { currentSkill, registeredActions } from "../src/task-actions";
import { Kind } from "../src/types";
import { config, freshHome } from "./support/helpers";

describe("env", () => {
  test("RIKER_* first, then the AUG_* an agent from before the rename has", () => {
    expect(envVar("TASK_ID", { AUG_TASK_ID: "7" })).toBe("7");
    expect(envVar("TASK_ID", { RIKER_TASK_ID: "8", AUG_TASK_ID: "7" })).toBe(
      "8",
    );
    expect(envVar("TASK_ID", {})).toBeUndefined();
    expect(inAgentEnv({ AUG: "1" })).toBe(true);
    expect(inAgentEnv({ RIKER: "1" })).toBe(true);
    expect(inAgentEnv({})).toBe(false);
  });

  test("the log reads AUG_LOG and AUG_DEV too", () => {
    expect(resolveLogSettings({ AUG_LOG: "trace" })?.level).toBe("trace");
    expect(resolveLogSettings({ AUG_DEV: "1" })?.level).toBe("debug");
    expect(resolveLogSettings({ RIKER_LOG: "off", AUG_DEV: "1" })).toBeNull();
  });
});

describe("refs", () => {
  beforeEach(() => freshHome());

  test("RIKER- is printed; AUG-, riker- and bare numbers still parse", () => {
    expect(store.taskRef(12)).toBe("RIKER-0012");
    for (const ref of [
      "RIKER-0012",
      "AUG-0012",
      "@AUG-0012",
      "aug12",
      "riker-12",
      "12",
    ]) {
      expect(refNumber(ref)).toBe(12);
    }
    expect(store.parseTaskRef("AUG-0076")).toBe(76);
    expect(refNumber("ledger-12")).toBeNull();
  });

  test("text from before the rename names its tasks", () => {
    const a = store.createTask({
      title: "one",
      kind: Kind.general,
      channel: "owner",
    });
    const b = store.createTask({
      title: "two",
      kind: Kind.general,
      channel: "owner",
    });
    const aug = `AUG-${String(a.id).padStart(4, "0")}`;
    expect(
      mentionedTasks(`about @${aug} and ${store.taskRef(b.id)}`).map(
        (t) => t.id,
      ),
    ).toEqual([a.id, b.id]);
  });
});

test("a tmux read falls back to aug's tag", () => {
  expect(optionFormat("task")).toBe(
    "#{?@riker_task,#{@riker_task},#{@aug_task}}",
  );
});

test("claudes aug or Riker runs itself are never strays", () => {
  const base = { pid: 1, sessionId: "s", cwd: "/w", kind: "interactive" };
  for (const entrypoint of ["aug", "riker"]) {
    expect(
      parseClaudeProcess(JSON.stringify({ ...base, entrypoint })),
    ).toBeNull();
  }
  expect(
    parseClaudeProcess(JSON.stringify({ ...base, entrypoint: "cli" })),
  ).not.toBeNull();
});

test("an action in config that names aug's plugin runs Riker's", () => {
  freshHome({
    actions: {
      recap: { skill: "aug:summarize", via: "headless", title: "Recap" },
    },
  });
  expect(currentSkill("aug:guide")).toBe("riker:guide");
  expect(currentSkill("mine:guide")).toBe("mine:guide");
  expect(
    registeredActions(config()).find((a) => a.name === "recap")?.skill,
  ).toBe("riker:summarize");
});

test("aug-tools is on an agent's PATH beside riker-tools", () => {
  freshHome();
  const dir = toolsBin();
  expect(readFileSync(join(dir, "aug-tools"), "utf8")).toBe(
    readFileSync(join(dir, "riker-tools"), "utf8"),
  );
});

test("the hook guard lets aug's agents and aug-tagged sessions through", () => {
  freshHome();
  const guard = guardScript();
  expect(guard).toContain("$RIKER_TASK_ID$AUG_TASK_ID");
  expect(guard).toContain("#{@riker_project}#{@aug_project}");
});

// What aug installed into a home that has since moved from .aug to .riker.
describe("aug's installs are ours but out of date", () => {
  let dir: string;
  let legacy: string;
  const saved = {
    claude: process.env.CLAUDE_CONFIG_DIR,
    starship: process.env.STARSHIP_CONFIG,
    path: process.env.PATH,
  };

  beforeEach(() => {
    freshHome();
    dir = mkdtempSync(join(tmpdir(), "riker-compat-"));
    process.env.RIKER_HOME = join(dir, ".riker");
    mkdirSync(paths.home());
    legacy = join(dir, ".aug");
    process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
    process.env.STARSHIP_CONFIG = join(dir, "starship.toml");
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", "starship"), "#!/bin/sh\n", { mode: 0o755 });
    process.env.PATH = `${join(dir, "bin")}:${saved.path}`;
  });

  afterEach(() => {
    for (const [key, value] of [
      ["CLAUDE_CONFIG_DIR", saved.claude],
      ["STARSHIP_CONFIG", saved.starship],
      ["PATH", saved.path],
    ] as const) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("a home named .riker was the .aug beside it", () => {
    expect(homeAliases()).toEqual([paths.home(), legacy]);
    expect(homeAliases("/tmp/scratch")).toEqual(["/tmp/scratch"]);
  });

  test("hooks calling ~/.aug's guard are this home's, and refreshed", () => {
    const file = join(dir, "claude", "settings.json");
    mkdirSync(join(dir, "claude"));
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                { type: "command", command: `sh ${legacy}/adopt-hook.sh stop` },
              ],
            },
          ],
        },
        theme: "dark",
      }),
    );
    expect(hooksHere(file)).toBe(true);
    expect(installState("hooks")).toBe(InstallState.stale);
    expect(refreshInstalls()).toContain("hooks");
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(legacy);
    expect(text).toContain(`${paths.home()}/adopt-hook.sh`);
    expect(JSON.parse(text).theme).toBe("dark");
    expect(installState("hooks")).toBe(InstallState.installed);
  });

  test("aug's backup of settings.json is the one kept", () => {
    const file = join(dir, "claude", "settings.json");
    mkdirSync(join(dir, "claude"));
    writeFileSync(file, "{}");
    writeFileSync(`${file}.before-aug`, '{"original":true}');
    installHooks(file);
    expect(existsSync(`${file}.before-riker`)).toBe(false);
  });

  test("aug's statusline block is replaced, then uninstalled", () => {
    const toml = [
      "[profiles]",
      'claude-code = "${custom.aug_task}$claude_model"',
      "",
      "# >>> aug statusline >>>",
      "[custom.aug_task]",
      `command = ${JSON.stringify(join(legacy, "statusline.sh"))}`,
      "# <<< aug statusline <<<",
      "",
    ].join("\n");
    writeFileSync(process.env.STARSHIP_CONFIG!, toml);
    writeFileSync(
      join(paths.home(), "statusline.sh"),
      `#!/bin/sh\n# Installed by \`aug install statusline\` for aug home ${legacy}; removed by \`aug uninstall statusline\`.\n`,
    );
    expect(INSTALLS.statusline.here()).toBe(true);
    expect(installState("statusline")).toBe(InstallState.stale);
    expect(refreshInstalls()).toContain("statusline");
    const after = readFileSync(process.env.STARSHIP_CONFIG!, "utf8");
    expect(after).not.toContain("aug");
    expect(after).toContain(
      'claude-code = "${custom.riker_task}$claude_model"',
    );
    expect(installState("statusline")).toBe(InstallState.installed);
    // The helper was aug's: replaced in place, not kept as someone else's.
    expect(existsSync(join(paths.home(), "statusline.sh.before-riker"))).toBe(
      false,
    );
    INSTALLS.statusline.uninstall();
    expect(readFileSync(process.env.STARSHIP_CONFIG!, "utf8")).toBe(
      '[profiles]\nclaude-code = "$claude_model"\n',
    );
  });

  test("aug's revdiff launcher is replaced, and its backup restored on uninstall", () => {
    const plugins = join(dir, "claude", "plugins");
    mkdirSync(join(plugins, "data", "revdiff-revdiff", "scripts"), {
      recursive: true,
    });
    writeFileSync(
      join(plugins, "installed_plugins.json"),
      JSON.stringify({ plugins: { "revdiff@revdiff": [{}] } }),
    );
    const [target] = revdiffTargets();
    writeFileSync(
      target,
      `#!/usr/bin/env bash\n# Installed by \`aug install revdiff\` for aug home ${legacy}; removed by \`aug uninstall revdiff\`.\n`,
    );
    writeFileSync(`${target}.before-aug`, "#!/bin/sh\necho mine\n");
    expect(INSTALLS.revdiff.here()).toBe(true);
    expect(installState("revdiff")).toBe(InstallState.stale);
    expect(refreshInstalls()).toContain("revdiff");
    expect(installState("revdiff")).toBe(InstallState.installed);
    INSTALLS.revdiff.uninstall();
    expect(readFileSync(target, "utf8")).toBe("#!/bin/sh\necho mine\n");
  });
});
