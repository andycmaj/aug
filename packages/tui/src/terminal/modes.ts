// The emulator keeps no mode state we can read back, so follow the private
// modes that decide where a wheel turn goes: a program that tracks the mouse
// (Claude Code fullscreen) scrolls itself, an alt-screen program without it
// gets arrow keys, and anything else scrolls our own scrollback. Bracketed
// paste (2004) decides how a paste is wrapped.

const MOUSE = new Set([9, 1000, 1002, 1003]);
const ALT = new Set([47, 1047, 1049]);
const SGR = 1006;
const BRACKETED_PASTE = 2004;
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const MODE = /\x1b\[\?([0-9;]+)([hl])|\x1bc/g;
// Keep a cut-off sequence for the next chunk.
const PARTIAL = /\x1b(?:\[\??[0-9;]*)?$/;

export type Wheel = "up" | "down";

export class TerminalModes {
  private mouse = new Set<number>();
  sgr = false;
  alt = false;
  bracketedPaste = false;
  private tail = "";

  get mouseTracking(): boolean {
    return this.mouse.size > 0;
  }

  feed(chunk: string): void {
    const text = this.tail + chunk;
    const cut = text.match(PARTIAL);
    this.tail = cut ? cut[0] : "";
    const body = cut ? text.slice(0, cut.index) : text;
    for (const m of body.matchAll(MODE)) {
      if (m[0] === "\x1bc") {
        this.mouse.clear();
        this.sgr = false;
        this.alt = false;
        this.bracketedPaste = false;
        continue;
      }
      const on = m[2] === "h";
      for (const p of (m[1] ?? "").split(";")) {
        const n = Number(p);
        if (MOUSE.has(n)) {
          if (on) {
            this.mouse.add(n);
          } else {
            this.mouse.delete(n);
          }
        } else if (n === SGR) {
          this.sgr = on;
        } else if (ALT.has(n)) {
          this.alt = on;
        } else if (n === BRACKETED_PASTE) {
          this.bracketedPaste = on;
        }
      }
    }
  }

  // Bytes for pasted text. Line breaks become CR as a real terminal sends
  // them; a program that asked for brackets (Claude Code, a shell, tmux's
  // client) gets them, so it takes the text as one paste instead of keys.
  // The end marker is stripped from the text so a paste cannot end early
  // and run the rest as typed keys.
  paste(text: string): string {
    const body = text.replace(/\r?\n/g, "\r");
    if (!this.bracketedPaste) {
      return body;
    }
    return `${PASTE_START}${body.replaceAll(PASTE_END, "")}${PASTE_END}`;
  }

  // Bytes for one wheel step at a 0-based cell, or null to scroll locally.
  wheel(direction: Wheel, x: number, y: number): string | null {
    if (this.mouseTracking) {
      const button = direction === "up" ? 64 : 65;
      if (this.sgr) {
        return `\x1b[<${button};${x + 1};${y + 1}M`;
      }
      const c = (n: number) => String.fromCharCode(32 + Math.min(n, 222));
      return `\x1b[M${c(button)}${c(x + 1)}${c(y + 1)}`;
    }
    if (this.alt) {
      return direction === "up" ? "\x1b[A" : "\x1b[B";
    }
    return null;
  }
}
