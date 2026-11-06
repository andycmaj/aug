import { expect, test } from "bun:test";
import { terminalReplies } from "./replies";

const ctx = {
  cursor: [4, 2] as [number, number],
  foreground: "#c0caf5",
  background: "#1a1b26",
};

test("cursor position report is 1-based row;col", () => {
  expect(terminalReplies("abc\x1b[6n", ctx)).toBe("\x1b[3;5R");
});

test("device status and attributes", () => {
  expect(terminalReplies("\x1b[5n", ctx)).toBe("\x1b[0n");
  expect(terminalReplies("\x1b[c", ctx)).toBe("\x1b[?62;22c");
  expect(terminalReplies("\x1b[0c", ctx)).toBe("\x1b[?62;22c");
  expect(terminalReplies("\x1b[>c", ctx)).toBe("\x1b[>0;10;0c");
});

test("OSC 10/11 colour queries with BEL or ST terminators", () => {
  expect(terminalReplies("\x1b]11;?\x07", ctx)).toBe(
    "\x1b]11;rgb:1a1a/1b1b/2626\x1b\\",
  );
  expect(terminalReplies("\x1b]10;?\x1b\\", ctx)).toBe(
    "\x1b]10;rgb:c0c0/caca/f5f5\x1b\\",
  );
});

test("ordinary output and colour sets produce nothing", () => {
  expect(terminalReplies("\x1b[31mred\x1b[0m\x1b]11;#000000\x07", ctx)).toBe(
    "",
  );
});
