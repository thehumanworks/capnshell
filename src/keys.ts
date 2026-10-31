/**
 * tmux-style key names for `send-keys`. A token that is not a key name is sent as
 * literal text, as tmux does, so `keys build "ls -la" Enter` types the command.
 */
export const MAX_KEYS = 1000;

const simple: Record<string, string> = {
  enter: "\r", tab: "\t", btab: "\x1b[Z", escape: "\x1b", esc: "\x1b", space: " ", bspace: "\x7f",
};
// Cursor keys switch between CSI and SS3 forms with the program's DECCKM mode.
const cursor: Record<string, string> = { up: "A", down: "B", right: "C", left: "D", home: "H", end: "F" };
const tilde: Record<string, number> = {
  insert: 2, ic: 2, delete: 3, dc: 3, pageup: 5, pgup: 5, ppage: 5, pagedown: 6, pgdn: 6, npage: 6,
  f5: 15, f6: 17, f7: 18, f8: 19, f9: 20, f10: 21, f11: 23, f12: 24,
};
const function4: Record<string, string> = { f1: "P", f2: "Q", f3: "R", f4: "S" };
const controlSymbols: Record<string, number> = {
  "@": 0, " ": 0, "2": 0, "[": 0x1b, "3": 0x1b, "\\": 0x1c, "4": 0x1c, "]": 0x1d, "5": 0x1d,
  "^": 0x1e, "6": 0x1e, "_": 0x1f, "7": 0x1f, "/": 0x1f, "?": 0x7f, "8": 0x7f,
};

interface Modifiers { ctrl: boolean; meta: boolean; shift: boolean }

function encodeKey(token: string, applicationCursor: boolean): string | undefined {
  const modifiers: Modifiers = { ctrl: false, meta: false, shift: false };
  let base = token;
  for (let match; (match = /^([CMS])-(.+)$/i.exec(base));) {
    const key = match[1]!.toUpperCase();
    modifiers[key === "C" ? "ctrl" : key === "M" ? "meta" : "shift"] = true;
    base = match[2]!;
  }
  const name = base.toLowerCase();
  const { ctrl, meta, shift } = modifiers;
  // xterm's modifier parameter: 1 plus Shift 1, Alt 2, Control 4.
  const parameter = 1 + (shift ? 1 : 0) + (meta ? 2 : 0) + (ctrl ? 4 : 0);
  if (name in cursor) {
    const final = cursor[name]!;
    if (parameter > 1) return `\x1b[1;${parameter}${final}`;
    return applicationCursor ? `\x1bO${final}` : `\x1b[${final}`;
  }
  if (name in tilde) return parameter > 1 ? `\x1b[${tilde[name]};${parameter}~` : `\x1b[${tilde[name]}~`;
  if (name in function4) return parameter > 1 ? `\x1b[1;${parameter}${function4[name]}` : `\x1bO${function4[name]}`;
  const prefix = meta ? "\x1b" : "";
  if (name in simple) {
    if (name === "tab" && shift) return prefix + simple.btab;
    if (name === "space" && ctrl) return prefix + "\0";
    if (name === "bspace" && ctrl) return prefix + "\b";
    return prefix + simple[name]!;
  }
  const characters = [...base];
  if (characters.length !== 1 || base === token) return undefined;
  let character = shift ? base.toUpperCase() : base;
  if (ctrl) {
    if (/^[a-z]$/i.test(character)) character = String.fromCharCode(character.toUpperCase().charCodeAt(0) & 0x1f);
    else if (character in controlSymbols) character = String.fromCharCode(controlSymbols[character]!);
    else return undefined;
  }
  return prefix + character;
}

/** Translate key names to the bytes a terminal sends for them. */
export function encodeKeys(keys: readonly string[], { literal = false, applicationCursor = false } = {}): string {
  return keys.map((token) => literal ? token : encodeKey(token, applicationCursor) ?? token).join("");
}
