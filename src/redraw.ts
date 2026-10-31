import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal as Screen } from "@xterm/headless";

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
