// Every connection in progress shows one animated mark, then
// connected or failed with a reason. The embedded terminal is the live one:
// connecting from spawn to its first output, failed when it exits first or
// stays silent past its timeout. Under bun test motion is off, so the
// connecting mark is the still one.

import { afterEach, expect, test } from "bun:test";
import { createSignal, onMount } from "solid-js";
import { testRender } from "@opentui/solid";
import {
  FocusProvider,
  KeymapProvider,
  Pane,
  ThemeProvider,
  type KeymapTable,
} from "@andycmaj/opentui-app";
import type { Renderable } from "@opentui/core";
import { LINK_FRAMES, LINK_STILL, type Link } from "@riker/core/link-state";
import { TerminalHost } from "../src/components/agent-terminal";
import { LinkMark, useLinkFrame } from "../src/components/link-mark";
import { MotionContext } from "../src/context/motion";
import {
  TerminalsProvider,
  useTerminals,
  type TermRequest,
} from "../src/context/terminals";
import { keymap } from "../src/keymap";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

async function mountTerm(request: Omit<TermRequest, "id" | "title" | "kind">) {
  const setup = await testRender(
    () => (
      <ThemeProvider>
        <TerminalsProvider>
          <KeymapProvider keymap={keymap as KeymapTable}>
            <FocusProvider panes={["canvas"]}>
              {(() => {
                const terminals = useTerminals();
                let pane: Renderable | undefined;
                onMount(() =>
                  terminals.open({
                    id: "t",
                    title: "T",
                    kind: "agent",
                    ...request,
                  }),
                );
                return (
                  <Pane name="canvas" ref={(r) => (pane = r)}>
                    <TerminalHost
                      id="t"
                      attached={() => true}
                      pane={() => pane}
                      onDetach={() => {}}
                    />
                  </Pane>
                );
              })()}
            </FocusProvider>
          </KeymapProvider>
        </TerminalsProvider>
      </ThemeProvider>
    ),
    { width: 60, height: 8 },
  );
  destroy = () => setup.renderer.destroy();
  const frames: string[] = [];
  const frameWith = async (want: string, ms = 3000) => {
    let text = "";
    const end = Date.now() + ms;
    while (!text.includes(want) && Date.now() < end) {
      await Bun.sleep(20);
      await setup.renderOnce();
      text = setup.captureCharFrame();
      frames.push(text);
    }
    return text;
  };
  return { frameWith, frames };
}

test("a terminal is connecting until its first output, then attached", async () => {
  const { frameWith } = await mountTerm({
    argv: ["sh", "-c", "sleep 0.4; printf hello; sleep 5"],
  });
  expect(await frameWith(`[${LINK_STILL} connecting]`)).toContain(
    `[${LINK_STILL} connecting]`,
  );
  const after = await frameWith("[attached]");
  expect(after).toContain("hello");
  expect(after).not.toContain("connecting");
});

test("a terminal that exits before any output fails with why", async () => {
  const { frameWith } = await mountTerm({ argv: ["sh", "-c", "exit 3"] });
  expect(await frameWith("[exited 3 before any output]")).toContain(
    "[exited 3 before any output]",
  );
});

test("a terminal that never answers fails at its timeout, and connects if it answers late", async () => {
  const { frameWith } = await mountTerm({
    argv: ["sh", "-c", "sleep 0.8; printf late; sleep 5"],
    connectMs: 300,
  });
  expect(await frameWith("[✕ no answer after 0.3s]")).toContain(
    "[✕ no answer after 0.3s]",
  );
  const after = await frameWith("[attached]");
  expect(after).toContain("late");
});

test("LinkMark animates only while connecting, with motion on", async () => {
  const [link, setLink] = createSignal<Link>({
    phase: "connecting",
    reason: null,
    since: 0,
  });
  const setup = await testRender(
    () => (
      <ThemeProvider>
        <MotionContext.Provider value={() => true}>
          <text>
            <LinkMark link={link()} label="github" reason />
          </text>
        </MotionContext.Provider>
      </ThemeProvider>
    ),
    { width: 40, height: 3 },
  );
  destroy = () => setup.renderer.destroy();
  const seen = new Set<string>();
  const end = Date.now() + 1500;
  while (seen.size < 2 && Date.now() < end) {
    await Bun.sleep(50);
    await setup.renderOnce();
    const mark = Array.from(setup.captureCharFrame()).find((c) =>
      (LINK_FRAMES as readonly string[]).includes(c),
    );
    if (mark) {
      seen.add(mark);
    }
  }
  expect(seen.size).toBeGreaterThanOrEqual(2);

  setLink({ phase: "failed", reason: "rate limited", since: 1 });
  await setup.renderOnce();
  expect(setup.captureCharFrame()).toContain("✕ github · rate limited");
});

test("the frame timer stops as soon as the link settles, and never runs without motion", async () => {
  const [active, setActive] = createSignal(true);
  const [motion, setMotion] = createSignal(true);
  let frame = () => 0;
  const setup = await testRender(
    () => (
      <MotionContext.Provider value={motion}>
        {(() => {
          frame = useLinkFrame(active);
          return <text>probe</text>;
        })()}
      </MotionContext.Provider>
    ),
    { width: 10, height: 1 },
  );
  destroy = () => setup.renderer.destroy();
  await Bun.sleep(500);
  expect(frame()).toBeGreaterThan(0);

  setActive(false);
  const settled = frame();
  await Bun.sleep(500);
  expect(frame()).toBe(settled);

  setMotion(false);
  setActive(true);
  await Bun.sleep(500);
  expect(frame()).toBe(settled);
});
