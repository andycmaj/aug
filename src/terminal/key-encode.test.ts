import { expect, test } from "bun:test";
import { parseKeypress } from "@opentui/core";
import { encodeKey } from "./key-encode";

const k = (s: string) => {
  const p = parseKeypress(s, { useKittyKeyboard: true });
  if (!p) throw new Error("unparsed " + JSON.stringify(s));
  return p;
};

test.each([
  ["\x1b[99;5u", "\x03", "ctrl+c"],
  ["\x1b[97;5u", "\x01", "ctrl+a"],
  ["\x1b[27u", "\x1b", "escape"],
  ["\x1b[13u", "\r", "enter"],
  ["\x1b[9;2u", "\x1b[Z", "shift+tab"],
  ["\x1b[127u", "\x7f", "backspace"],
  ["\x1b[120;3u", "\x1bx", "alt+x"],
  ["\x1b[1;5A", "\x1b[1;5A", "ctrl+up"],
  ["\x1b[A", "\x1b[A", "up"],
  ["\x1b[3;5~", "\x1b[3;5~", "ctrl+delete"],
  ["\x1b[93;5u", "\x1d", "ctrl+]"],
  ["\x1b[97;2u", "A", "shift+a"],
])("%j -> %j (%s)", (input, out) => {
  expect(encodeKey(k(input))).toBe(out);
});

test("legacy passthrough", () => {
  expect(encodeKey(parseKeypress("\x03")!)).toBe("\x03");
  expect(encodeKey(parseKeypress("q")!)).toBe("q");
});
