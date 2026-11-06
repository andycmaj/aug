export interface KeyLike {
  name: string;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  option?: boolean;
  sequence: string;
  raw: string;
  source: "raw" | "kitty";
  eventType?: string;
}

const CSI = "\x1b[";
const SS3 = "\x1bO";

const SPECIAL: Record<string, string> = {
  return: "\r",
  enter: "\r",
  tab: "\t",
  backspace: "\x7f",
  escape: "\x1b",
  space: " ",
  up: CSI + "A",
  down: CSI + "B",
  right: CSI + "C",
  left: CSI + "D",
  home: CSI + "H",
  end: CSI + "F",
  insert: CSI + "2~",
  delete: CSI + "3~",
  pageup: CSI + "5~",
  pagedown: CSI + "6~",
  f1: SS3 + "P",
  f2: SS3 + "Q",
  f3: SS3 + "R",
  f4: SS3 + "S",
  f5: CSI + "15~",
  f6: CSI + "17~",
  f7: CSI + "18~",
  f8: CSI + "19~",
  f9: CSI + "20~",
  f10: CSI + "21~",
  f11: CSI + "23~",
  f12: CSI + "24~",
};

// xterm modifier parameter: 1 + shift(1) + alt(2) + ctrl(4)
function modParam(k: KeyLike): number {
  return (
    1 + (k.shift ? 1 : 0) + (k.meta || k.option ? 2 : 0) + (k.ctrl ? 4 : 0)
  );
}

function withModifiers(base: string, k: KeyLike): string {
  const m = modParam(k);
  if (m === 1) return base;
  const csiLetter =
    base.match(/^\x1b\[([A-H])$/) ?? base.match(/^\x1bO([P-S])$/);
  if (csiLetter) return `${CSI}1;${m}${csiLetter[1]}`;
  const tilde = base.match(/^\x1b\[(\d+)~$/);
  if (tilde) return `${CSI}${tilde[1]};${m}~`;
  return base;
}

function ctrlChar(ch: string): string | null {
  const c = ch.toLowerCase();
  if (c >= "a" && c <= "z") return String.fromCharCode(c.charCodeAt(0) - 96);
  const map: Record<string, string> = {
    "@": "\x00",
    " ": "\x00",
    "[": "\x1b",
    "\\": "\x1c",
    "]": "\x1d",
    "^": "\x1e",
    _: "\x1f",
    "?": "\x7f",
  };
  return map[c] ?? null;
}

// Legacy input sequences pass through untouched; kitty CSI-u events (which
// a shell or editor in the PTY can't read) are re-encoded as xterm bytes.
export function encodeKey(k: KeyLike): string {
  if (k.eventType === "release") return "";
  if (k.source !== "kitty") return k.raw || k.sequence;

  const alt = k.meta || k.option ? "\x1b" : "";
  const special = SPECIAL[k.name];
  if (special !== undefined) {
    if (k.name === "tab" && k.shift && !k.ctrl) return CSI + "Z";
    if (k.name === "backspace" && k.ctrl) return alt + "\x08";
    if (special.startsWith(CSI) || special.startsWith(SS3))
      return withModifiers(special, {
        ...k,
        meta: false,
        option: false,
        ...(alt ? { meta: true } : {}),
      });
    if (k.name === "space" && k.ctrl) return alt + "\x00";
    return alt + special;
  }

  const ch =
    k.name.length === 1
      ? k.shift
        ? k.name.toUpperCase()
        : k.name
      : k.sequence;
  if (k.ctrl) {
    const c = ctrlChar(k.name);
    if (c !== null) return alt + c;
  }
  return (
    alt + (k.sequence && !k.sequence.startsWith("\x1b[") ? k.sequence : ch)
  );
}
