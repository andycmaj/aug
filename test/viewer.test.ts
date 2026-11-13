import { describe, expect, test } from "bun:test";
import { viewersToClose } from "../src/components/use-viewer";
import type { TermState } from "../src/context/terminals";

const term = (id: string, taskId?: number, kind: TermState["kind"] = "agent"): TermState => ({
  id,
  title: id,
  kind,
  taskId,
  running: true,
  exitCode: null,
});

describe("viewers to close", () => {
  const terms = [term("view-1", 1), term("view-2", 2), term("editor", undefined, "editor")];

  test("only the shown task keeps its viewer; editors are not viewers", () => {
    expect(viewersToClose(terms, 1, () => true)).toEqual(["view-2"]);
  });

  test("nothing shown closes every viewer", () => {
    expect(viewersToClose(terms, null, () => true)).toEqual(["view-1", "view-2"]);
  });

  test("the shown task's viewer goes once its claude ends", () => {
    expect(viewersToClose(terms, 1, (id) => id !== 1)).toEqual(["view-1", "view-2"]);
  });
});
