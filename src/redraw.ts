import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as Screen } from "@xterm/headless";
import { TerminalKeyboard } from "./kitty-keyboard.js";

const encoder = new TextEncoder();
// The serializer writes the normal buffer, then this, then the alternate buffer.
const ALTERNATE = "\x1b[?1049h\x1b[H";
const CLEAR = "\x1b[0m\x1b[H\x1b[2J";

/**
 * Escape sequences that redraw a screen and its input modes on a cleared terminal.
 * `flat` draws only the active buffer, for a terminal that stays on one screen.
 */
export function redraw(screen: Screen, serializer: SerializeAddon, { flat = false } = {}): string {
  let content = serializer.serialize({ scrollback: 0 });
  if (flat && screen.buffer.active.type === "alternate") content = content.slice(content.indexOf(ALTERNATE) + ALTERNATE.length);
  // xterm keeps cursor visibility internal; the serializer does not restore it.
  const core = (screen as unknown as { _core?: { coreService?: { isCursorHidden?: boolean } } })._core;
  return CLEAR + content + (core?.coreService?.isCursorHidden ? "\x1b[?25l" : "");
}

const SWITCHES = new Set(["47", "1047", "1049"]);
const PRIVATE_MODES = /\x1b\[\?([0-9;]*)([hl])/g;
// What NormalScreen acts on: private modes, the kitty keyboard protocol's requests, and a full reset.
const FOLLOWED = /\x1b(?:\[\?([0-9;]*)([hl])|\[([<=>])([0-9;]*)u|c)/g;
// A private mode sequence that the next chunk may complete.
const PARTIAL = /\x1b(?:\[(?:\?[0-9;]*)?)?$/;

/**
 * Keeps a local terminal on its alternate screen while it shows a session, so
 * detaching returns to what it showed before, as tmux does. Output passes through,
 * except the program's own switches between the normal and alternate screens: this
 * screen follows them and redraws the one the program switched to.
 */
export class AttachedScreen {
  #screen: Screen;
  #serializer = new SerializeAddon();
  #carry = "";

  constructor(cols: number, rows: number) {
    this.#screen = new Screen({ cols, rows, scrollback: 0, allowProposedApi: true });
    this.#screen.loadAddon(this.#serializer as never);
  }

  /** Translate a chunk of session output into what to write to the local terminal. */
  async translate(data: Uint8Array): Promise<Uint8Array> {
    // Latin-1 maps bytes to characters one to one, so UTF-8 split across chunks survives.
    const text = this.#carry + Buffer.from(data).toString("latin1");
    const partial = PARTIAL.exec(text);
    this.#carry = partial?.[0] ?? "";
    const complete = partial ? text.slice(0, partial.index) : text;
    const output: Uint8Array[] = [];
    let start = 0;
    for (const match of complete.matchAll(PRIVATE_MODES)) {
      const modes = match[1]!.split(";");
      const kept = modes.filter((mode) => !SWITCHES.has(mode));
      if (kept.length === modes.length) continue;
      const end = match.index + match[0].length;
      output.push(Buffer.from(complete.slice(start, match.index) + (kept.length ? `\x1b[?${kept.join(";")}${match[2]}` : ""), "latin1"));
      await this.#write(complete.slice(start, end));
      output.push(encoder.encode(redraw(this.#screen, this.#serializer, { flat: true })));
      start = end;
    }
    const rest = complete.slice(start);
    output.push(Buffer.from(rest, "latin1"));
    void this.#write(rest);
    return output.length === 1 ? output[0]! : Buffer.concat(output);
  }

  resize(cols: number, rows: number) { this.#screen.resize(cols, rows); }
  dispose() { this.#screen.dispose(); }

  #write(text: string) {
    return new Promise<void>((resolve) => this.#screen.write(Buffer.from(text, "latin1"), resolve));
  }
}

/**
 * Follows a session shown on a local terminal's normal screen, as ssh shows a shell: lines
 * that scroll off the top go to the terminal's own scrollback, and the program's switches to
 * the alternate screen reach the terminal as they are. This remembers which screen the
 * program has the terminal on, so that leaving the session can return it to the normal one.
 *
 * With `keyboard`, the terminal speaks the kitty keyboard protocol and the session's output
 * still holds the program's requests for it. They are replaced by what sets the program's
 * mode in an entry of cns's own, which leaving the session pops: see TerminalKeyboard.
 *
 * It reads output that QueryFilter has passed, in which no escape sequence is split.
 */
export class NormalScreen {
  /** The mode that switched the terminal to its alternate screen, while it is on it. */
  #alternate: string | undefined;
  #keyboard: TerminalKeyboard | undefined;

  constructor({ keyboard = false } = {}) {
    this.#keyboard = keyboard ? new TerminalKeyboard() : undefined;
  }

  /**
   * What scrolls everything a terminal of `rows` rows shows, down to the cursor's row, into
   * its scrollback. An attachment starts by clearing the screen, which would erase it.
   */
  static scrollAway(rows: number): string { return "\r\n".repeat(rows); }

  /** Note the screen switches in a chunk of output, and return the chunk as the terminal must receive it. */
  show(data: Uint8Array): Uint8Array {
    if (!data.includes(0x1b)) return data;
    const text = Buffer.from(data).toString("latin1");
    let output = "";
    let kept = 0;
    for (const match of text.matchAll(FOLLOWED)) {
      const end = match.index + match[0].length;
      let before = "";
      let after = "";
      let sequence = match[0];
      if (match[2]) {
        for (const mode of match[1]!.split(";")) {
          if (!SWITCHES.has(mode)) continue;
          const to = match[2] === "h" ? mode : undefined;
          if (to && !this.#alternate) after += this.#keyboard?.enter() ?? "";
          else if (!to && this.#alternate) before += this.#keyboard?.exit() ?? "";
          this.#alternate = to;
        }
      } else if (match[3]) {
        // Without `keyboard` QueryFilter has removed these, and none arrives here.
        sequence = this.#keyboard?.request(match[3], match[4]!.split(";").filter(Boolean).map(Number)) ?? "";
      } else {
        // A full reset returns the terminal to its normal screen.
        this.#alternate = undefined;
        this.#keyboard?.reset();
      }
      if (!before && !after && sequence === match[0]) continue;
      output += text.slice(kept, match.index) + before + sequence + after;
      kept = end;
    }
    return kept ? Buffer.from(output + text.slice(kept), "latin1") : data;
  }

  /** What returns the terminal to its normal screen and to its own keyboard mode: nothing when it has both. */
  leave(): string {
    const sequence = `${this.#keyboard?.exit() ?? ""}${this.#alternate ? `\x1b[?${this.#alternate}l` : ""}${this.#keyboard?.end() ?? ""}`;
    this.#alternate = undefined;
    return sequence;
  }
}
