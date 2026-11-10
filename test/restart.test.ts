import { describe, expect, test } from "bun:test";
import { isOutOfTextBuffers, RESTART_CODE } from "../src/core/restart";

describe("restart", () => {
  test("knows opentui's out-of-buffers error", () => {
    expect(isOutOfTextBuffers(new Error("Failed to create TextBuffer"))).toBe(
      true,
    );
  });

  test("other errors are not a restart", () => {
    expect(isOutOfTextBuffers(new Error("boom"))).toBe(false);
  });

  test("the restart code is EX_TEMPFAIL", () => {
    expect(RESTART_CODE).toBe(75);
  });
});
