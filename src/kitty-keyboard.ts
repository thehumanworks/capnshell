/**
 * The kitty keyboard protocol (https://sw.kovidgoyal.net/kitty/keyboard-protocol/), as cns
 * carries it between a program in a session and the terminal of a `cns tty --kitty-keys`.
 * With it a program can tell keys apart that otherwise send the same bytes, such as
 * Shift+Enter and Enter.
 *
 * A program asks its terminal whether it speaks the protocol (`CSI ? u`), then sets the
 * flags it wants (`CSI = flags ; mode u`) or pushes and pops them (`CSI > flags u`,
 * `CSI < n u`). The terminal keeps one mode per screen, the normal and the alternate one,
 * and from then on reports keys as `CSI key ; modifiers u`.
 *
 * In cns the two ends of that conversation are on different machines:
 *
 *   - the session's screen (src/pty.ts) answers the question, as it answers every terminal
 *     query, and keeps the program's mode, so a terminal that attaches later can be given it;
 *   - the attached terminal (src/redraw.ts, NormalScreen) is told the program's mode, in an
 *     entry of its own that cns pushes on each screen and pops when it leaves, so the
 *     terminal's mode from before the session is never changed;
 *   - the detach key then no longer arrives as one byte, so cns reads it in every form a
 *     terminal sends it (findControlKey).
 */

/** Every flag of the protocol: disambiguate, event types, alternate keys, all keys as escapes, text. */
const FLAGS = 0b11111;
/** Pushed modes a screen keeps; the oldest goes when another is pushed, as the protocol says. */
const MAX_PUSHED = 16;

/** One screen's keyboard mode: the flags in force, and those pushed under them. */
export class KeyboardMode {
  flags = 0;
  #pushed: number[] = [];

  /** How many modes are pushed under the one in force. */
  get depth(): number { return this.#pushed.length; }

  push(flags = 0): void {
    if (this.#pushed.length >= MAX_PUSHED) this.#pushed.shift();
    this.#pushed.push(this.flags);
    this.flags = flags & FLAGS;
  }

  /** Popping more than was pushed leaves no flags set. */
  pop(count = 1): void {
    for (let left = Math.max(1, count); left > 0; left--) {
      if (!this.#pushed.length) { this.flags = 0; return; }
      this.flags = this.#pushed.pop()!;
    }
  }

  /** `how` is the protocol's mode: 1 sets exactly these flags, 2 adds them, 3 removes them. */
  set(flags: number, how = 1): void {
    const bits = flags & FLAGS;
    if (how === 2) this.flags |= bits;
    else if (how === 3) this.flags &= ~bits;
    else this.flags = bits;
  }

  reset(): void {
    this.flags = 0;
    this.#pushed = [];
  }

  /** The requests that give a mode with nothing set and nothing pushed this one's flags and pushed flags. */
  replay(): string {
    const [first, ...rest] = [...this.#pushed, this.flags];
    if (!rest.length && !first) return "";
    return `\x1b[=${first};1u${rest.map((flags) => `\x1b[>${flags}u`).join("")}`;
  }

  /** Apply `CSI prefix params u`, where prefix is `>` (push), `<` (pop) or `=` (set). */
  apply(prefix: string, params: number[]): void {
    if (prefix === ">") this.push(params[0] ?? 0);
    else if (prefix === "<") this.pop(params[0] || 1);
    else if (prefix === "=") this.set(params[0] ?? 0, params[1] || 1);
  }
}

/** The keyboard modes of a terminal's two screens, which the protocol keeps apart. */
export class KeyboardModes {
  readonly main = new KeyboardMode();
  readonly alternate = new KeyboardMode();
  reset(): void {
    this.main.reset();
    this.alternate.reset();
  }
}

const POP = "\x1b[<u";

/**
 * What to send a terminal that shows a session, so that it reports keys as the session's
 * program asked. The program's requests are not passed on as they are: cns pushes one entry
 * of its own on each of the terminal's screens, sets the program's flags in it, and pops it
 * when the program leaves that screen or cns leaves the session. However the program used
 * its stack, the terminal's is then one entry deeper at most, and leaving restores it.
 */
export class TerminalKeyboard {
  #program = new KeyboardModes();
  #alternate = false;
  // The flags in the entry cns pushed on each of the terminal's screens: undefined where it pushed none.
  #main: number | undefined;
  #alt: number | undefined;

  /** The program sent `CSI prefix params u`: what to send the terminal in its place. */
  request(prefix: string, params: number[]): string {
    (this.#alternate ? this.#program.alternate : this.#program.main).apply(prefix, params);
    return this.#sync();
  }

  /** The program switched to the alternate screen: what to send after the switch. */
  enter(): string {
    this.#alternate = true;
    // A terminal that keeps one mode for both screens would report keys here as on the normal one.
    if (this.#main !== undefined && this.#alt === undefined) return this.#push(this.#program.alternate.flags);
    return this.#sync();
  }

  /** The program switches back to the normal screen, or cns leaves the session: what to send first. */
  exit(): string {
    this.#alternate = false;
    if (this.#alt === undefined) return "";
    this.#alt = undefined;
    return POP;
  }

  /** cns leaves the session, with the terminal on its normal screen: what gives it its own mode back. */
  end(): string {
    if (this.#main === undefined) return "";
    this.#main = undefined;
    return POP;
  }

  /** The program reset the terminal, which drops every mode with it. */
  reset(): void {
    this.#program.reset();
    this.#alternate = false;
    this.#main = this.#alt = undefined;
  }

  #push(flags: number): string {
    if (this.#alternate) this.#alt = flags; else this.#main = flags;
    return `\x1b[>${flags}u`;
  }

  #sync(): string {
    const flags = (this.#alternate ? this.#program.alternate : this.#program.main).flags;
    const sent = this.#alternate ? this.#alt : this.#main;
    if (sent === flags) return "";
    // A program that asks for nothing leaves the terminal as cns found it.
    if (sent === undefined) return flags ? this.#push(flags) : "";
    if (this.#alternate) this.#alt = flags; else this.#main = flags;
    return `\x1b[=${flags};1u`;
  }
}

const SHIFT = 1, CTRL = 4, LOCKS = 64 | 128;
const RELEASE = 3;
// The kitty protocol: CSI key[:shifted[:base]] ; modifiers[:event] [; text] u
// xterm's modifyOtherKeys, which Vim among others turns on: CSI 27 ; modifiers ; key ~
const KEY_EVENT = /\x1b\[(?:(\d+)((?::\d*)*)(?:;(\d*)(?::(\d+))?(?:;[\d:]*)?)?u|27;(\d+);(\d+)~)/g;

/** The byte Ctrl sends with a key in a terminal that reports keys as bytes, if it sends one. */
function controlByte(key: number): number | undefined {
  if (key >= 97 && key <= 122) return key - 96; // a-z
  if (key >= 65 && key <= 90) return key - 64; // A-Z, which modifyOtherKeys reports with Shift
  if (key >= 91 && key <= 95) return key - 64; // [ \ ] ^ _
  // The digits and signs that have sent control bytes since the VT100.
  return ({ 32: 0x00, 50: 0x00, 64: 0x00, 51: 0x1b, 52: 0x1c, 53: 0x1d, 54: 0x1e, 55: 0x1f, 47: 0x1f, 56: 0x7f, 63: 0x7f } as Record<number, number>)[key];
}

/**
 * Where terminal input holds the key that sends control byte `byte`, such as 0x1d for
 * Ctrl-]: as that byte, or as the key event a terminal reports once a program has asked for
 * the kitty protocol or for modifyOtherKeys. -1 when it is not there.
 *
 * A key event is that key when Ctrl is the only modifier held, apart from Caps Lock and
 * Num Lock, and the key, or the key in its place on a US keyboard, sends the byte; or when
 * Ctrl and Shift are held and the shifted key sends it, as Ctrl-Shift-2 is Ctrl-@. The
 * release of a key is not the key.
 */
export function findControlKey(data: Uint8Array, byte: number): number {
  let found = data.indexOf(byte);
  if (!data.includes(0x1b)) return found;
  const text = Buffer.from(data).toString("latin1");
  KEY_EVENT.lastIndex = 0;
  for (let match = KEY_EVENT.exec(text); match; match = KEY_EVENT.exec(text)) {
    if (found >= 0 && match.index > found) break;
    let keys: number[];
    if (match[1] === undefined) {
      const modifiers = (Number(match[5]) - 1) & ~LOCKS;
      keys = modifiers === CTRL || modifiers === (CTRL | SHIFT) ? [Number(match[6])] : [];
    } else {
      if (Number(match[4] ?? 1) === RELEASE) continue;
      const modifiers = (Number(match[3] || 1) - 1) & ~LOCKS;
      const [, shifted, base] = match[2]!.split(":");
      keys = modifiers === CTRL ? [Number(match[1]), ...base ? [Number(base)] : []]
        : modifiers === (CTRL | SHIFT) && shifted ? [Number(shifted)]
        : [];
    }
    if (keys.some((key) => controlByte(key) === byte)) { found = match.index; break; }
  }
  return found;
}

/** What asks a terminal for its keyboard mode, then for its device attributes, which every terminal answers. */
export const KEYBOARD_QUERY = "\x1b[?u\x1b[c";
const KEYBOARD_REPLY = /\x1b\[\?\d*u/;
const ATTRIBUTES_REPLY = /\x1b\[\?[\d;]*c/;

/**
 * Whether the replies to KEYBOARD_QUERY so far say the terminal speaks the protocol:
 * undefined until the device attributes, which come last, have arrived.
 */
export function keyboardReply(received: string): boolean | undefined {
  const attributes = ATTRIBUTES_REPLY.exec(received);
  if (!attributes) return undefined;
  const mode = KEYBOARD_REPLY.exec(received);
  return !!mode && mode.index < attributes.index;
}

/** What of the input received while waiting for those replies was typed and is not a reply. */
export function withoutKeyboardReplies(received: string): string {
  return received.replace(KEYBOARD_REPLY, "").replace(ATTRIBUTES_REPLY, "");
}

const LATE_REPLIES = new RegExp(`${KEYBOARD_REPLY.source}|${ATTRIBUTES_REPLY.source}`, "g");

/**
 * Terminal input without the replies to KEYBOARD_QUERY, for a terminal that had not answered
 * when cns stopped waiting: its answer is then not typed into the session. `done` once the
 * device attributes, which come last, have passed. No key a person types sends these.
 */
export function withoutLateKeyboardReplies(data: Uint8Array): { data: Uint8Array; done: boolean } {
  if (!data.includes(0x1b)) return { data, done: false };
  const text = Buffer.from(data).toString("latin1");
  const kept = text.replace(LATE_REPLIES, "");
  return { data: kept.length === text.length ? data : Buffer.from(kept, "latin1"), done: ATTRIBUTES_REPLY.test(text) };
}
