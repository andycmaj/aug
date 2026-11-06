import { describe, expect, test } from "bun:test";
import { TerminalModes } from "./modes";

describe("TerminalModes", () => {
  test("a plain shell scrolls locally", () => {
    const m = new TerminalModes();
    m.feed("hello\r\n\x1b[?25l\x1b[?2004h");
    expect(m.wheel("up", 3, 4)).toBeNull();
  });

  test("claude fullscreen gets SGR wheel events", () => {
    const m = new TerminalModes();
    m.feed("\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h");
    expect(m.wheel("up", 3, 4)).toBe("\x1b[<64;4;5M");
    expect(m.wheel("down", 0, 0)).toBe("\x1b[<65;1;1M");
  });

  test("a sequence split across chunks still counts", () => {
    const m = new TerminalModes();
    m.feed("x\x1b[?10");
    m.feed("00h\x1b");
    m.feed("[?1006h");
    expect(m.wheel("up", 0, 0)).toBe("\x1b[<64;1;1M");
  });

  test("combined params and turning tracking off", () => {
    const m = new TerminalModes();
    m.feed("\x1b[?1000;1006h");
    expect(m.mouseTracking).toBe(true);
    m.feed("\x1b[?1000l");
    expect(m.mouseTracking).toBe(false);
  });

  test("legacy encoding without SGR", () => {
    const m = new TerminalModes();
    m.feed("\x1b[?1000h");
    expect(m.wheel("down", 1, 2)).toBe('\x1b[Ma"#');
  });

  test("alt screen without mouse gets arrows", () => {
    const m = new TerminalModes();
    m.feed("\x1b[?1049h");
    expect(m.wheel("up", 0, 0)).toBe("\x1b[A");
    m.feed("\x1b[?1049l");
    expect(m.wheel("up", 0, 0)).toBeNull();
  });

  test("reset clears every mode", () => {
    const m = new TerminalModes();
    m.feed("\x1b[?1049h\x1b[?1000h\x1bc");
    expect(m.wheel("up", 0, 0)).toBeNull();
  });
});
