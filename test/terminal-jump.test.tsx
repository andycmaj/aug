// AUG-0148: ctrl+t while attached detaches and jumps your tmux client to the
// agent's window; a terminal with no window of its own (the editor) gets the
// key as typed. Pressed through the real keymap.

import { afterEach, expect, test } from "bun:test";
import { onMount } from "solid-js";
import { testRender } from "@opentui/solid";
import {
  FocusProvider,
  KeymapProvider,
  Pane,
  ThemeProvider,
  useFocus,
  type KeymapTable,
} from "@andycmaj/opentui-app";
import type { Renderable } from "@opentui/core";
import { TerminalHost } from "../src/components/agent-terminal";
import { TerminalsProvider, useTerminals } from "../src/context/terminals";
import { keymap } from "../src/keymap";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

// Non-canonical, so ctrl+t arrives as its byte (not the tty's status key),
// and od prints it: 024 is ctrl+t in octal.
const SHOW_ONE_KEY = [
  "sh",
  "-c",
  "stty -icanon -iexten -isig -echo min 1; echo ready; dd bs=1 count=1 2>/dev/null | od -An -c; sleep 5",
];

async function mount(withJump: boolean) {
  const calls: string[] = [];
  let focus: ReturnType<typeof useFocus> | undefined;
  const setup = await testRender(
    () => (
      <ThemeProvider>
        <TerminalsProvider>
          <KeymapProvider keymap={keymap as KeymapTable}>
            <FocusProvider panes={["rail", "task"]}>
              {(() => {
                const terminals = useTerminals();
                focus = useFocus();
                let pane: Renderable | undefined;
                onMount(() => {
                  terminals.open({ id: "term", title: "T", kind: "agent", argv: SHOW_ONE_KEY });
                  focus?.setActivePane("task");
                });
                return (
                  <box flexDirection="column" flexGrow={1}>
                    <Pane name="rail">
                      <text>rail</text>
                    </Pane>
                    <Pane name="task" ref={(r) => (pane = r)}>
                      <TerminalHost
                        id="term"
                        attached={() => focus?.isPaneFocused("task") ?? false}
                        pane={() => pane}
                        onDetach={() => {
                          calls.push("detach");
                          focus?.setActivePane("rail");
                        }}
                        onJump={withJump ? () => calls.push("jump") : undefined}
                      />
                    </Pane>
                  </box>
                );
              })()}
            </FocusProvider>
          </KeymapProvider>
        </TerminalsProvider>
      </ThemeProvider>
    ),
    { width: 60, height: 20 },
  );
  destroy = () => setup.renderer.destroy();
  const frameWith = async (want: string) => {
    let text = "";
    const end = Date.now() + 3000;
    while (!text.includes(want) && Date.now() < end) {
      await Bun.sleep(20);
      await setup.renderOnce();
      text = setup.captureCharFrame();
    }
    return text;
  };
  expect(await frameWith("ready")).toContain("ready");
  return { setup, calls, frameWith, focus: () => focus };
}

test("ctrl+t on an agent detaches, then jumps, and the agent never sees it", async () => {
  const { setup, calls, frameWith, focus } = await mount(true);
  setup.mockInput.pressKey("t", { ctrl: true });
  await setup.renderOnce();
  expect(calls).toEqual(["detach", "jump"]);
  expect(focus()?.isPaneFocused("rail")).toBe(true);
  expect(await frameWith("024")).not.toContain("024");
});

test("ctrl+t in a terminal with no window of its own goes to it as typed", async () => {
  const { setup, calls, frameWith, focus } = await mount(false);
  setup.mockInput.pressKey("t", { ctrl: true });
  expect(await frameWith("024")).toContain("024");
  expect(calls).toEqual([]);
  expect(focus()?.isPaneFocused("task")).toBe(true);
});
