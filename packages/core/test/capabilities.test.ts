import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generalAllow, turnSystem } from "../src/agents";
import { assistantAllow, assistantSystem } from "../src/assistant";
import {
  CAPABILITIES,
  DENIED_STEP,
  GRANT_STEP,
  deniedNote,
  docsNote,
  grantHint,
  grantSteps,
  refusalLines,
  WRITE_VERB,
  capabilityAllow,
  capabilityGrant,
  declaredRules,
  grantedNote,
  pluginDir,
  pluginWidens,
  resolveCapability,
} from "../src/capabilities";
import {
  DEFAULT_CONFIG,
  mergeConfig,
  type AugConfig,
} from "../src/config";
import { TurnRole, type TurnRow } from "../src/types";

function withCaps(caps: Partial<AugConfig["capabilities"]>): AugConfig {
  return {
    ...DEFAULT_CONFIG,
    capabilities: {
      servers: {},
      tools: {},
      plugins: {},
      commands: {},
      grants: {},
      ...caps,
    },
  };
}

describe("capabilities", () => {
  test("defaults grant nothing", () => {
    expect(capabilityAllow("general", DEFAULT_CONFIG)).toEqual([]);
    expect(capabilityAllow("assistant", DEFAULT_CONFIG)).toEqual([]);
  });

  test("slack.read resolves to read tools on the Slack connector", () => {
    const tools = capabilityAllow(
      "general",
      withCaps({ grants: { general: ["slack.read"] } }),
    );
    expect(tools).toContain("mcp__claude_ai_Slack__slack_read_thread");
    expect(tools).toContain("mcp__claude_ai_Slack__slack_search_public");
    expect(tools.length).toBe(CAPABILITIES["slack.read"]!.tools.length);
  });

  test("built-in capabilities hold no write-looking tools but the writes they name", () => {
    for (const spec of Object.values(CAPABILITIES))
      for (const tool of spec.tools)
        expect(WRITE_VERB.test(tool) && !spec.writes?.includes(tool)).toBe(false);
    // Only Claude Docs has a write capability.
    expect(
      Object.entries(CAPABILITIES)
        .filter(([, spec]) => spec.writes?.length)
        .map(([name]) => name),
    ).toEqual(["docs.write"]);
  });

  test("grants are per role", () => {
    const config = withCaps({
      grants: {
        general: ["slack.read", "docs.read"],
        assistant: ["slack.read"],
      },
    });
    expect(capabilityAllow("general", config)).toContain(
      "mcp__claude_ai_Claude_Docs__read",
    );
    expect(capabilityAllow("assistant", config)).not.toContain(
      "mcp__claude_ai_Claude_Docs__read",
    );
  });

  test("an unknown capability grants nothing", () => {
    expect(
      capabilityAllow(
        "general",
        withCaps({ grants: { general: ["slack.write"] } }),
      ),
    ).toEqual([]);
  });

  test("a write verb in an override is dropped", () => {
    const config = withCaps({
      tools: {
        "slack.read": [
          "slack_read_thread",
          "slack_send_message",
          "slack_send_message_draft",
          "slack_schedule_message",
          "slack_add_reaction",
          "slack_update_canvas",
        ],
      },
      grants: { general: ["slack.read"] },
    });
    expect(capabilityAllow("general", config)).toEqual([
      "mcp__claude_ai_Slack__slack_read_thread",
    ]);
  });

  test("notion.read resolves to Notion read tools only", () => {
    expect(
      capabilityAllow(
        "assistant",
        withCaps({ grants: { assistant: ["notion.read"] } }),
      ),
    ).toEqual([
      "mcp__claude_ai_Notion__notion-fetch",
      "mcp__claude_ai_Notion__notion-search",
      "mcp__claude_ai_Notion__notion-get-comments",
    ]);
  });

  test("Notion write and session tools are dropped from an override", () => {
    const writes = [
      "notion-create-pages",
      "notion-create-comment",
      "notion-update-page",
      "notion-update-comment",
      "notion-delete-pages",
      "notion-delete-comment",
      "notion-move-pages",
      "notion-duplicate-page",
      "notion-restore-pages",
      "notion-restore-version",
      "notion-set-comment-reaction",
      "notion-set-discussion-resolved",
      "notion-resolve-suggested-edit",
      "notion-create-suggested-edit",
      "notion-upload-skill",
      "notion-convert-page-to-skill",
      "notion-link-meeting-note-to-calendar-event",
      "notion-calendar-cancel-events",
      "notion-calendar-create-events",
      "notion-spawn-session",
      "notion-stop-session",
      "notion-send-message-to-session",
      "notion-wait-session",
      "notion-query-sessions",
    ];
    for (const tool of writes) expect(WRITE_VERB.test(tool)).toBe(true);
    const config = withCaps({
      tools: { "notion.read": ["notion-fetch", ...writes] },
      grants: { general: ["notion.read"] },
    });
    expect(capabilityAllow("general", config)).toEqual([
      "mcp__claude_ai_Notion__notion-fetch",
    ]);
  });

  test("an unknown Notion capability grants nothing", () => {
    expect(
      capabilityAllow(
        "general",
        withCaps({ grants: { general: ["notion.write"] } }),
      ),
    ).toEqual([]);
  });

  test("globs and bare servers never pass", () => {
    const caps = withCaps({
      tools: { "slack.read": ["*", "slack_read_thread", ""] },
    }).capabilities;
    expect(resolveCapability("slack.read", caps)).toEqual([
      "mcp__claude_ai_Slack__slack_read_thread",
    ]);
    const badServer = withCaps({
      servers: { "slack.read": "claude_ai_Slack__*" },
    }).capabilities;
    expect(resolveCapability("slack.read", badServer)).toEqual([]);
  });

  test("server override renames the connector", () => {
    const caps = withCaps({ servers: { "slack.read": "slack" } }).capabilities;
    expect(resolveCapability("slack.read", caps)[0]).toStartWith(
      "mcp__slack__",
    );
  });

  test("mergeConfig fills capabilities from a partial file", () => {
    expect(mergeConfig({}).capabilities).toEqual({
      servers: {},
      tools: {},
      plugins: {},
      commands: {},
      grants: {},
    });
    const merged = mergeConfig({
      capabilities: { grants: { assistant: ["slack.read"] } },
    } as never);
    expect(merged.capabilities.grants.assistant).toEqual(["slack.read"]);
    expect(merged.capabilities.tools).toEqual({});
  });

  test("roles' allow lists carry their grants", () => {
    const config = withCaps({
      grants: { general: ["docs.read"], assistant: ["slack.read"] },
    });
    expect(generalAllow(config)).toContain("mcp__claude_ai_Claude_Docs__query");
    expect(generalAllow(config)).not.toContain(
      "mcp__claude_ai_Slack__slack_read_thread",
    );
    expect(assistantAllow(config)).toContain(
      "mcp__claude_ai_Slack__slack_read_thread",
    );
  });

  test("the assistant may read GitHub with gh, but never write", () => {
    const allow = assistantAllow(DEFAULT_CONFIG);
    expect(allow).toContain("Bash(gh issue view:*)");
    expect(allow).toContain("Bash(gh pr list:*)");
    expect(allow.filter((r) => r.startsWith("Bash(gh "))).not.toContain(
      "Bash(gh api:*)",
    );
    for (const rule of allow.filter((r) => r.startsWith("Bash(gh "))) {
      expect(rule).not.toMatch(/comment|create|edit|merge|close|review/);
    }
    expect(generalAllow(DEFAULT_CONFIG)).toContain("Bash(gh issue view:*)");
  });
});

function skill(dir: string, path: string, frontmatter: string): void {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), `---\n${frontmatter}\n---\nDo the thing.\n`);
}

// A fake ~/.claude with one installed plugin.
function fakeClaudeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aug-claude-"));
  const install = join(dir, "plugins", "cache", "revdiff", "0.8.24");
  mkdirSync(install, { recursive: true });
  writeFileSync(
    join(dir, "plugins", "installed_plugins.json"),
    JSON.stringify({
      version: 2,
      plugins: {
        "revdiff@revdiff": [{ scope: "user", installPath: install }],
        "gone@market": [{ scope: "user", installPath: join(dir, "nowhere") }],
      },
    }),
  );
  process.env.CLAUDE_CONFIG_DIR = dir;
  return install;
}

describe("plugin and command capabilities", () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
  });

  test("an installed plugin resolves by full or bare name", () => {
    const install = fakeClaudeDir();
    expect(pluginDir("revdiff@revdiff")).toBe(install);
    expect(pluginDir("revdiff")).toBe(install);
    expect(pluginDir("gone@market")).toBeUndefined();
    expect(pluginDir("nope")).toBeUndefined();
    expect(pluginDir("../revdiff")).toBeUndefined();
    expect(pluginDir(install)).toBe(install);
  });

  test("a granted plugin loads its folder and the Skill tool", () => {
    const install = fakeClaudeDir();
    const grant = capabilityGrant(
      "general",
      withCaps({
        plugins: { revdiff: "revdiff@revdiff" },
        commands: { revdiff: ["revdiff"] },
        grants: { general: ["revdiff"] },
      }),
    );
    expect(grant.pluginDirs).toEqual([install]);
    expect(grant.tools).toEqual(["Skill"]);
    expect(grant.allow).toEqual(["Bash(revdiff:*)", "Skill"]);
  });

  test("a plugin that is not installed loads nothing", () => {
    fakeClaudeDir();
    const grant = capabilityGrant(
      "general",
      withCaps({
        plugins: { gone: "gone@market" },
        grants: { general: ["gone"] },
      }),
    );
    expect(grant).toEqual({
      allow: [],
      tools: [],
      pluginDirs: [],
      commands: [],
    });
  });

  test("commands are plain prefixes; shells, wrappers and globs are dropped", () => {
    const grant = capabilityGrant(
      "assistant",
      withCaps({
        commands: {
          tools: [
            "plannotator annotate",
            "jq",
            "bash",
            "env FOO=1 rm",
            "sudo rm",
            "rm *",
            "jq; rm -rf /",
            "",
          ],
        },
        grants: { assistant: ["tools"] },
      }),
    );
    expect(grant.commands).toEqual(["plannotator annotate", "jq"]);
    expect(grant.allow).toEqual(["Bash(plannotator annotate:*)", "Bash(jq:*)"]);
    expect(grant.pluginDirs).toEqual([]);
  });

  test("allowed-tools is read in every form a skill writes it", () => {
    expect(declaredRules("---\nname: a\n---\nbody")).toEqual([]);
    expect(declaredRules("no frontmatter")).toEqual([]);
    expect(
      declaredRules("---\nallowed-tools: [Bash, Read, Edit]\n---\n"),
    ).toEqual(["Bash", "Read", "Edit"]);
    expect(
      declaredRules(
        "---\nallowed-tools: Bash(git add:*), Bash(git status:*) Read\n---\n",
      ),
    ).toEqual(["Bash(git add:*)", "Bash(git status:*)", "Read"]);
    expect(
      declaredRules(
        "---\nallowed-tools:\n  - Bash(jq:*)\n  - 'Grep'\nname: x\n---\n",
      ),
    ).toEqual(["Bash(jq:*)", "Grep"]);
    expect(
      declaredRules(
        "---\nallowed-tools: Bash\ndisable-model-invocation: true\n---\n",
      ),
    ).toBeNull();
  });

  test("a plugin loads only when its skills take nothing ungranted", () => {
    const dir = mkdtempSync(join(tmpdir(), "aug-plugin-"));
    mkdirSync(join(dir, ".claude-plugin"));
    writeFileSync(
      join(dir, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "p", skills: "./.claude-plugin/skills/" }),
    );
    skill(
      dir,
      "skills/read/SKILL.md",
      "name: read\nallowed-tools: [Read, Grep]",
    );
    skill(dir, "commands/run.md", "allowed-tools: Bash(jq:*)");
    skill(
      dir,
      "commands/user.md",
      "allowed-tools: Bash\ndisable-model-invocation: true",
    );
    expect(pluginWidens(dir, ["jq"])).toEqual([]);
    expect(pluginWidens(dir, [])).toEqual(["Bash(jq:*)"]);
    // A manifest's own skill folder counts too.
    skill(
      dir,
      ".claude-plugin/skills/wide/SKILL.md",
      "allowed-tools: [Bash, Write]",
    );
    expect(pluginWidens(dir, ["jq"])).toEqual(["Bash", "Write"]);
  });

  test("a plugin whose skills widen the grant is not loaded", () => {
    const install = fakeClaudeDir();
    skill(install, "skills/wide/SKILL.md", "allowed-tools: [Bash, Edit]");
    const grant = capabilityGrant(
      "general",
      withCaps({
        plugins: { revdiff: "revdiff" },
        commands: { revdiff: ["revdiff"] },
        grants: { general: ["revdiff"] },
      }),
    );
    expect(grant.pluginDirs).toEqual([]);
    expect(grant.tools).toEqual([]);
    expect(grant.allow).toEqual(["Bash(revdiff:*)"]);
  });

  test("grants stay per role, and the prompt names granted commands", () => {
    const config = withCaps({
      commands: { jq: ["jq"] },
      grants: { assistant: ["jq"] },
    });
    expect(grantedNote("assistant", config)).toContain("jq");
    expect(grantedNote("general", config)).toBe("");
    expect(assistantAllow(config)).toContain("Bash(jq:*)");
    expect(generalAllow(config)).not.toContain("Bash(jq:*)");
  });
});

describe("Claude Docs grants", () => {
  const DOCS = "mcp__claude_ai_Claude_Docs__";
  const FILE = "/home/me/.aug/config.json";

  test("docs.read reads only; docs.write adds batch, create and update but not delete", () => {
    expect(
      capabilityAllow("general", withCaps({ grants: { general: ["docs.read"] } })),
    ).toEqual(["read", "export", "guide", "query"].map((t) => DOCS + t));
    const write = capabilityAllow(
      "general",
      withCaps({ grants: { general: ["docs.write"] } }),
    );
    for (const t of ["read", "guide", "batch", "create", "update"])
      expect(write).toContain(DOCS + t);
    expect(write).not.toContain(`${DOCS}delete`);
  });

  test("the default config grants no Docs tool to either role", () => {
    for (const role of ["general", "assistant"] as const)
      expect(
        capabilityAllow(role, DEFAULT_CONFIG).filter((r) => r.startsWith(DOCS)),
      ).toEqual([]);
    expect(generalAllow(DEFAULT_CONFIG).some((r) => r.startsWith(DOCS))).toBe(false);
    expect(assistantAllow(DEFAULT_CONFIG).some((r) => r.startsWith(DOCS))).toBe(false);
  });

  test("docs.write reaches task agents and the Assistant, each by its own grant", () => {
    const config = withCaps({
      grants: { general: ["docs.write"], assistant: ["docs.read"] },
    });
    expect(generalAllow(config)).toContain(`${DOCS}batch`);
    expect(assistantAllow(config)).toContain(`${DOCS}read`);
    expect(assistantAllow(config)).not.toContain(`${DOCS}batch`);
    const both = withCaps({ grants: { assistant: ["docs.write"] } });
    expect(assistantAllow(both)).toContain(`${DOCS}batch`);
  });

  test("an override narrows docs.write and may name delete, never another write", () => {
    const config = withCaps({
      tools: { "docs.write": ["read", "create", "delete", "send", "*"] },
      grants: { general: ["docs.write"] },
    });
    expect(capabilityAllow("general", config)).toEqual(
      ["read", "create", "delete"].map((t) => DOCS + t),
    );
  });

  test("Docs writes stay with docs.write: not through another capability or a renamed server", () => {
    const viaRead = withCaps({
      tools: { "docs.read": ["read", "batch", "update"] },
      grants: { general: ["docs.read"] },
    });
    expect(capabilityAllow("general", viaRead)).toEqual([`${DOCS}read`]);
    const viaSlack = withCaps({
      tools: { "slack.read": ["slack_read_thread", "batch", "create"] },
      grants: { general: ["slack.read"] },
    });
    expect(capabilityAllow("general", viaSlack)).toEqual([
      "mcp__claude_ai_Slack__slack_read_thread",
    ]);
    const renamed = withCaps({
      servers: { "docs.write": "claude_ai_Slack" },
      grants: { general: ["docs.write"] },
    });
    expect(
      capabilityAllow("general", renamed).map((r) => r.split("__")[2]),
    ).toEqual(["read", "export", "guide", "query"]);
  });

  test("a denied Docs call names the capability and the exact config key", () => {
    const none = withCaps({});
    expect(grantHint(`${DOCS}batch`, "general", none, FILE)).toBe(
      `${DOCS}batch: add "docs.write" to capabilities.grants.general in ${FILE}.`,
    );
    expect(grantHint(`${DOCS}read`, "assistant", none, FILE)).toBe(
      `${DOCS}read: add "docs.read" to capabilities.grants.assistant in ${FILE}.`,
    );
    expect(grantHint(`${DOCS}delete`, "general", none, FILE)).toContain(
      `list "delete" in capabilities.tools["docs.write"]`,
    );
    const granted = withCaps({ grants: { general: ["docs.write"] } });
    expect(grantHint(`${DOCS}delete`, "general", granted, FILE)).toContain(
      `"docs.write" is in capabilities.grants.general, but its tools leave "delete" out`,
    );
    expect(
      grantHint("mcp__claude_ai_Slack__slack_send_message", "general", none, FILE),
    ).toContain("no capability in aug grants it");
    expect(grantHint("Bash", "general", none, FILE)).toBeNull();
    expect(grantHint("mcp__someone_else__thing", "general", none, FILE)).toBeNull();
  });

  test("grant steps come once per denied tool, none for a shell call", () => {
    const denied = [
      `${DOCS}batch {"container":{"kind":"project"}}`,
      `${DOCS}batch {"container":{"kind":"project","create":{}}}`,
      "Bash cd /x && ls",
    ];
    expect(grantSteps(denied, "general", withCaps({}), FILE)).toEqual([
      `${GRANT_STEP}${DOCS}batch: add "docs.write" to capabilities.grants.general in ${FILE}.`,
    ]);
  });

  test("the next turn hears the connector denial and its grant, apart from shell advice", () => {
    const steps = [
      "Read x",
      `${DENIED_STEP}${DOCS}batch {"container":{}}`,
      `${GRANT_STEP}${DOCS}batch: add "docs.write" to capabilities.grants.general in ${FILE}.`,
    ];
    const turns = [
      { role: TurnRole.agent, steps: JSON.stringify(steps) },
    ] as unknown as TurnRow[];
    const note = deniedNote(turns);
    expect(note).toContain("the owner has not granted them");
    expect(note).toContain(`- ${DOCS}batch\n`);
    expect(note).toContain(`add "docs.write" to capabilities.grants.general in ${FILE}`);
    expect(note).toContain("never edit aug's config yourself");
    expect(note).not.toContain("did not match an allowed command");
    expect(refusalLines(steps)).toEqual([
      `denied ${DOCS}batch {"container":{}}`,
      `to allow ${DOCS}batch: add "docs.write" to capabilities.grants.general in ${FILE}.`,
    ]);
  });

  test("every headless agent is told where grants live; Docs rules only once granted", () => {
    const none = withCaps({});
    for (const system of [turnSystem(none), assistantSystem(none)]) {
      expect(system).toContain("capabilities.grants.");
      expect(system).toContain("docs.write (make and edit Claude Docs");
      expect(system).toContain("Granted to you now: none");
      expect(system).not.toContain("## Claude Docs");
    }
    const writes = withCaps({
      grants: { general: ["docs.write"], assistant: ["docs.read"] },
    });
    const general = turnSystem(writes);
    expect(general).toContain("Granted to you now: docs.write");
    expect(general).toContain("## Claude Docs");
    expect(general).toContain("one pending block per section");
    expect(general).toContain("move link");
    expect(general).toContain("private data");
    const assistant = assistantSystem(writes);
    expect(assistant).toContain("capabilities.grants.assistant");
    expect(assistant).toContain("not make or change them");
    expect(assistant).toContain("private data");
    expect(docsNote("general", none)).toBe("");
  });
});
