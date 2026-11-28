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

  test("paste goes in raw until the program asks for brackets", () => {
    const m = new TerminalModes();
    expect(m.paste("a\nb")).toBe("a\rb");
    m.feed("\x1b[?2004h");
    expect(m.paste("a\nb")).toBe("\x1b[200~a\rb\x1b[201~");
    m.feed("\x1b[?2004l");
    expect(m.paste("x")).toBe("x");
  });

  test("a paste cannot close its own brackets early", () => {
    const m = new TerminalModes();
    m.feed("\x1b[?2004h");
    expect(m.paste("a\x1b[201~rm -rf /\r\n")).toBe(
      "\x1b[200~arm -rf /\r\x1b[201~",
    );
  });

  test("reset turns bracketed paste off", () => {
    const m = new TerminalModes();
    m.feed("\x1b[?2004h\x1bc");
    expect(m.paste("x")).toBe("x");
  });

  describe("clicks", () => {
    const none = { shift: false, alt: false, ctrl: false };

    test("a program that asked for none gets none", () => {
      const m = new TerminalModes();
      m.feed("\x1b[?1006h");
      expect(m.click("press", 0, 1, 1, none)).toBeNull();
    });

    test("1000 with SGR: press and release, no motion", () => {
      const m = new TerminalModes();
      m.feed("\x1b[?1000h\x1b[?1006h");
      expect(m.click("press", 0, 3, 4, none)).toBe("\x1b[<0;4;5M");
      expect(m.click("release", 0, 3, 4, none)).toBe("\x1b[<0;4;5m");
      expect(m.click("press", 2, 0, 0, none)).toBe("\x1b[<2;1;1M");
      expect(m.click("drag", 0, 5, 4, none)).toBeNull();
      expect(m.click("move", 0, 5, 4, none)).toBeNull();
    });

    test("1002 adds a drag with its button held; 1003 any motion", () => {
      const m = new TerminalModes();
      m.feed("\x1b[?1002h\x1b[?1006h");
      expect(m.click("drag", 0, 5, 4, none)).toBe("\x1b[<32;6;5M");
      expect(m.click("move", 0, 5, 4, none)).toBeNull();
      m.feed("\x1b[?1003h");
      expect(m.click("move", 0, 5, 4, none)).toBe("\x1b[<35;6;5M");
    });

    test("modifiers add to the button", () => {
      const m = new TerminalModes();
      m.feed("\x1b[?1000;1006h");
      expect(
        m.click("press", 0, 0, 0, { shift: true, alt: true, ctrl: true }),
      ).toBe("\x1b[<28;1;1M");
    });

    test("legacy encoding: release is button 3, cells clamp", () => {
      const m = new TerminalModes();
      m.feed("\x1b[?1000h");
      expect(m.click("press", 0, 1, 2, none)).toBe('\x1b[M "#');
      expect(m.click("release", 0, 1, 2, none)).toBe('\x1b[M#"#');
      expect(m.click("press", 0, 400, 0, none)).toBe(
        `\x1b[M ${String.fromCharCode(255)}!`,
      );
    });

    test("X10 (9) is presses only, without modifiers", () => {
      const m = new TerminalModes();
      m.feed("\x1b[?9h");
      expect(
        m.click("press", 1, 0, 0, { shift: true, alt: false, ctrl: false }),
      ).toBe("\x1b[M!!!");
      expect(m.click("release", 1, 0, 0, none)).toBeNull();
    });
  });
});
