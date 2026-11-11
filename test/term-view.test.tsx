import { afterEach, expect, test } from "bun:test";
import { createSignal, onMount } from "solid-js";
import { testRender } from "@opentui/solid";
import { TermView } from "../src/components/agent-terminal";
import { TerminalsProvider, useTerminals } from "../src/context/terminals";

let destroy: (() => void) | undefined;
afterEach(() => destroy?.());

// The table keeps one TermView mounted while you move between live tasks, so
// it must follow its id, not keep the screen it adopted first.
test("TermView shows the terminal its id names after the id changes", async () => {
  const [id, setId] = createSignal("view-1");
  const setup = await testRender(
    () => (
      <TerminalsProvider>
        {(() => {
          const terminals = useTerminals();
          onMount(() => {
            for (const n of [1, 2])
              terminals.open({
                id: `view-${n}`,
                title: `T${n}`,
                kind: "agent",
                argv: ["sh", "-c", `printf 'screen-of-task-${n}'; sleep 5`],
              });
          });
          return <TermView id={id()} />;
        })()}
      </TerminalsProvider>
    ),
    { width: 60, height: 10 },
  );
  destroy = () => setup.renderer.destroy();
  // The PTYs write on their own time; poll frames until the text shows.
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

  expect(await frameWith("screen-of-task-1")).toContain("screen-of-task-1");
  setId("view-2");
  const text = await frameWith("screen-of-task-2");
  expect(text).toContain("screen-of-task-2");
  expect(text).not.toContain("screen-of-task-1");
});
