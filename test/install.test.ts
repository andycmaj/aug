import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installHooks } from "../src/core/adopt";
import {
  INSTALLS,
  InstallState,
  installState,
  refreshInstalls,
  revdiffScript,
  revdiffTargets,
  STARSHIP_MODULE,
  starshipConfigPath,
  statusHelperPath,
  withoutStatusline,
  withStatusline,
} from "../src/core/install";
import { freshHome } from "./helpers";

let dir: string;
const saved = {
  claude: process.env.CLAUDE_CONFIG_DIR,
  starship: process.env.STARSHIP_CONFIG,
  path: process.env.PATH,
};

beforeEach(() => {
  freshHome();
  dir = mkdtempSync(join(tmpdir(), "aug-install-"));
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
  process.env.STARSHIP_CONFIG = join(dir, "starship.toml");
  // statusline needs a starship on PATH; any will do.
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
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const settings = () =>
  JSON.parse(
    readFileSync(join(dir, "claude", "settings.json"), "utf8"),
  ) as Record<string, unknown>;

// Another aug home on the same machine: a test or a real-mode check.
function otherHome(): void {
  process.env.AUG_HOME = mkdtempSync(join(tmpdir(), "aug-other-"));
}

describe("starship.toml", () => {
  const cases = {
    "your claude-code profile":
      '[profiles]\nclaude-code = "$claude_model$claude_cost"\n',
    "profiles without claude-code": '[profiles]\nshort = "$directory"\n',
    "no profiles": 'format = "$all"\n',
    "an empty file": "",
  };
  for (const [name, toml] of Object.entries(cases)) {
    test(`${name}: module in front once, uninstall gives the file back`, () => {
      const once = withStatusline(toml);
      expect(withStatusline(once)).toBe(once);
      expect(once).toContain("[custom.aug_task]");
      expect(once.match(/^\s*claude-code = .*$/m)?.[0]).toContain(
        `"${STARSHIP_MODULE}$claude_model`,
      );
      expect(once.match(/^\[profiles\]$/gm)).toHaveLength(1);
      expect(withoutStatusline(once)).toBe(toml);
    });
  }
});

describe("aug install statusline", () => {
  test("writes the helper and module, sets a missing statusLine, uninstalls", () => {
    writeFileSync(
      starshipConfigPath(),
      '[profiles]\nclaude-code = "$claude_model"\n',
    );
    const item = INSTALLS.statusline;
    expect(item.state()).toBe(InstallState.missing);
    item.install();
    expect(item.state()).toBe(InstallState.installed);
    expect(item.here()).toBe(true);
    expect(readFileSync(statusHelperPath(), "utf8")).toContain(
      "statusline 2>/dev/null",
    );
    expect(settings().statusLine).toEqual({
      type: "command",
      command: "starship statusline claude-code",
    });

    item.uninstall();
    expect(readFileSync(starshipConfigPath(), "utf8")).toBe(
      '[profiles]\nclaude-code = "$claude_model"\n',
    );
    expect(existsSync(statusHelperPath())).toBe(false);
  });

  test("a statusLine you set is left alone", () => {
    mkdirSync(join(dir, "claude"), { recursive: true });
    writeFileSync(
      join(dir, "claude", "settings.json"),
      JSON.stringify({ statusLine: { type: "command", command: "mine" } }),
    );
    expect(INSTALLS.statusline.install()).toContain("runs mine");
    expect(settings().statusLine).toEqual({ type: "command", command: "mine" });
  });

  test("a stale helper is refreshed, but not from another aug home", () => {
    INSTALLS.statusline.install();
    writeFileSync(
      statusHelperPath(),
      "#!/bin/sh\n# Installed by `aug install statusline` old\n",
    );
    const home = process.env.AUG_HOME;
    otherHome();
    expect(INSTALLS.statusline.here()).toBe(false);
    refreshInstalls();
    expect(readFileSync(starshipConfigPath(), "utf8")).not.toContain(
      process.env.AUG_HOME!,
    );
    process.env.AUG_HOME = home;
    expect(INSTALLS.statusline.state()).toBe(InstallState.stale);
    expect(refreshInstalls()).toContain("statusline");
    expect(INSTALLS.statusline.state()).toBe(InstallState.installed);
  });
});

describe("aug install revdiff", () => {
  function plugin(): string {
    const plugins = join(dir, "claude", "plugins");
    mkdirSync(join(plugins, "data", "revdiff-revdiff", "scripts"), {
      recursive: true,
    });
    writeFileSync(
      join(plugins, "installed_plugins.json"),
      JSON.stringify({ plugins: { "revdiff@revdiff": [{}] } }),
    );
    return revdiffTargets()[0];
  }

  test("unavailable without the plugin", () => {
    expect(installState("revdiff")).toBe(InstallState.unavailable);
  });

  test("moves your symlink aside without writing through it, and puts it back", () => {
    const target = plugin();
    const yours = join(dir, "yours.sh");
    writeFileSync(yours, "#!/bin/sh\necho mine\n");
    symlinkSync(yours, target);
    expect(installState("revdiff")).toBe(InstallState.missing);

    INSTALLS.revdiff.install();
    expect(readFileSync(target, "utf8")).toBe(revdiffScript());
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(yours, "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(installState("revdiff")).toBe(InstallState.installed);

    INSTALLS.revdiff.uninstall();
    expect(readlinkSync(target)).toBe(yours);
  });
});

describe("aug install hooks", () => {
  test("an older install (a hook event missing) is stale and refreshed", () => {
    const file = join(dir, "claude", "settings.json");
    installHooks(file);
    expect(installState("hooks")).toBe(InstallState.installed);
    const s = settings() as { hooks: Record<string, unknown> };
    delete s.hooks.PostToolUse;
    writeFileSync(file, JSON.stringify(s));
    expect(installState("hooks")).toBe(InstallState.stale);
    expect(refreshInstalls()).toEqual(["hooks"]);
    expect(installState("hooks")).toBe(InstallState.installed);
  });

  test("a scratch home never takes over the real home's hooks", () => {
    installHooks();
    const before = readFileSync(join(dir, "claude", "settings.json"), "utf8");
    otherHome();
    expect(installState("hooks")).toBe(InstallState.stale);
    expect(refreshInstalls()).toEqual([]);
    expect(readFileSync(join(dir, "claude", "settings.json"), "utf8")).toBe(
      before,
    );
  });
});
