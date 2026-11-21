import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRender } from "@opentui/solid";
import { RGBA } from "@opentui/core";
import { getTheme } from "@andycmaj/opentui-app";
import { App } from "../src/app";
import { installFixture } from "@riker/fixtures/demo";
import { nerdFont, nerdFontInstalled } from "@riker/core/glyphs";
import { Lane, LANE_META, laneMeta } from "@riker/core/lanes";
import { toneColor } from "../src/components/ui";

const GIT_MERGE = "";

describe("merged's look", () => {
  test("purple: the theme's accent", () => {
    expect(LANE_META.merged.tone).toBe("accent");
    const theme = getTheme("default");
    expect(toneColor(theme, "accent")).toBe(theme.accent);
    expect(theme.accent).toBe("#9d7cd8");
  });

  test("the git-merge glyph where the font is a Nerd Font, » elsewhere", () => {
    expect(laneMeta(Lane.merged, true).mark).toBe(GIT_MERGE);
    expect(laneMeta(Lane.merged, false).mark).toBe("»");
  });

  test("a lane with no Nerd Font mark keeps its own", () => {
    for (const lane of Object.keys(LANE_META) as Lane[]) {
      if (lane === Lane.merged) continue;
      expect(laneMeta(lane, true).mark).toBe(LANE_META[lane].mark);
    }
  });
});

describe("Nerd Font detection", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("config says, when it says", () => {
    expect(nerdFont({ nerdFont: true })).toBe(true);
    expect(nerdFont({ nerdFont: false })).toBe(false);
  });

  test("unset, a Nerd Font installed is the guess", () => {
    dir = mkdtempSync(join(tmpdir(), "riker-fonts-"));
    writeFileSync(join(dir, "Inter-Regular.ttf"), "");
    expect(nerdFontInstalled([dir])).toBe(false);
    mkdirSync(join(dir, "caskaydia"));
    writeFileSync(join(dir, "caskaydia", "CaskaydiaCoveNerdFont-Bold.ttf"), "");
    expect(nerdFontInstalled([dir])).toBe(true);
    expect(nerdFontInstalled([join(dir, "missing")])).toBe(false);
  });
});

describe("the rail's merged row", () => {
  let destroy: (() => void) | undefined;
  afterEach(() => {
    destroy?.();
    const home = process.env.RIKER_HOME;
    if (home) rmSync(home, { recursive: true, force: true });
  });

  for (const nerd of [true, false]) {
    test(`draws ${nerd ? "the git-merge glyph" : "»"} in purple`, async () => {
      const engine = installFixture("demo");
      const config = engine.desk.config();
      engine.desk.config = () => ({ ...config, nerdFont: nerd });
      const setup = await testRender(() => <App engine={engine} />, {
        width: 140,
        height: 45,
      });
      destroy = () => setup.renderer.destroy();
      await setup.renderOnce();

      const mark = nerd ? GIT_MERGE : "»";
      const spans = setup
        .captureSpans()
        .lines.flatMap((l) => l.spans)
        .filter((s) => s.text.includes(mark));
      expect(spans.length).toBeGreaterThan(0);
      const purple = RGBA.fromHex(getTheme("default").accent ?? "");
      expect(spans.some((s) => s.fg.equals(purple))).toBe(true);
    });
  }
});
