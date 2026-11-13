/**
 * What an attached terminal receives of a session's output, where that is not the output
 * byte for byte (src/terminal.ts writes it).
 *
 * A session's own screen answers the terminal queries of its program (src/pty.ts), on the
 * peer that runs it. An attached terminal must then never see those queries: its reply
 * would cross the link as input, arrive after the screen's, and be read as typed keys by
 * whatever reads next. Neovim, for one, asks for device attributes as it exits and waits
 * one second; a reply later than that lands in the shell as `62;22c`.
 *
 * QueryFilter removes from a session's output what would make the attached terminal reply
 * or change how it types:
 *
 *   - queries: device attributes, status and cursor reports, mode and setting requests,
 *     window reports, colour and clipboard reads, capability and graphics probes;
 *   - the kitty keyboard protocol, so that keys such as the detach key stay single bytes;
 *   - in-band resize reports (mode 2048). A program that receives them ignores its PTY's
 *     size, and so never follows a terminal of another size that attaches later.
 *
 * Everything else passes through byte for byte, including sequences it does not know.
 *
 * BareLineFeeds then keeps a line feed from also returning the cursor to the first column.
 */

/** A sequence still incomplete after this many bytes is not a query; it passes through. */
export const MAX_HELD_BYTES = 4096;

const ESC = "\x1b";
const NEXT = /[\x05\x1b]/g;
const CSI = /\x1b\[([<=>?]?)([0-9:;]*)([ -\/]*)([@-~])/y;
const CSI_PARTIAL = /\x1b\[[0-?]*[ -\/]*$/y;
const DCS_HEADER = /\x1bP[0-?]*([ -\/]*[@-~])/y;
const DCS_PARTIAL = /\x1bP[0-?]*[ -\/]*$/y;
const STRING_END = /[\x07\x1b]/g;
// XTWINOPS reports: window state, position and size in pixels and cells, icon label and title.
const WINDOW_REPORTS = new Set(["11", "13", "14", "15", "16", "18", "19", "20", "21"]);
// Palette, special and dynamic colours, kitty's colour protocol and the clipboard.
const READABLE_OSC = /^(?:4|5|1[0-9]|21|52);/;
const GRAPHICS_QUERY = /(?:^|,)a=q(?:,|$)/;

/** What to write in place of a complete CSI sequence: undefined keeps it as it is. */
function csi(prefix: string, params: string, intermediates: string, final: string): string | undefined {
  if (intermediates === "$") return "pwu".includes(final) ? "" : undefined; // DECRQM, DECRQPSR, DECRQTSR
  if (intermediates === "*") return final === "y" ? "" : undefined; // DECRQCRA
  if (intermediates) return undefined;
  switch (final) {
    // DA1, DA2 and DA3. With `?` it is a reply, or the Linux console's cursor shape.
    case "c": return prefix === "?" ? undefined : "";
    case "n": return prefix === "" || prefix === "?" ? "" : undefined; // DSR, CPR, DECXCPR
    // The kitty keyboard protocol: its query and its flags. A bare `CSI u` restores the cursor.
    case "u": return prefix ? "" : undefined;
    case "q": return prefix === ">" ? "" : undefined; // XTVERSION
    case "t": return prefix === "" && WINDOW_REPORTS.has(params.split(";")[0]!) ? "" : undefined;
    case "x": return prefix === "" ? "" : undefined; // DECREQTPARM
    case "S": return prefix === "?" ? "" : undefined; // XTSMGRAPHICS
    case "m": return prefix === "?" ? "" : undefined; // XTQMODKEYS
    case "h": {
      if (prefix !== "?") return undefined;
      const modes = params.split(";");
      const kept = modes.filter((mode) => mode !== "2048");
      if (kept.length === modes.length) return undefined;
      return kept.length ? `${ESC}[?${kept.join(";")}h` : "";
    }
    default: return undefined;
  }
}

export class QueryFilter {
  #carry = "";

  /** The part of a chunk of session output that an attached terminal may show. */
  filter(data: Uint8Array): Uint8Array {
    if (!this.#carry && !data.includes(0x1b) && !data.includes(0x05)) return data;
    // Latin-1 maps bytes to characters one to one, so UTF-8 split across chunks survives.
    // Its 0x80-0x9f bytes are parts of characters here, never 8-bit controls.
    const text = this.#carry + Buffer.from(data).toString("latin1");
    this.#carry = "";
    let output = "";
    // text[kept..at) passes through; `at` is the next byte to look at.
    let kept = 0;
    let at = 0;
    const replace = (end: number, replacement: string) => {
      output += text.slice(kept, at) + replacement;
      kept = at = end;
    };
    while (at < text.length) {
      NEXT.lastIndex = at;
      const next = NEXT.exec(text);
      if (!next) break;
      at = next.index;
      // ENQ asks for the answerback string.
      if (text[at] !== ESC) { replace(at + 1, ""); continue; }
      const end = this.#sequence(text, at, replace);
      if (end === undefined) {
        // Incomplete: the next chunk may finish it, unless it is too long to be a query.
        if (text.length - at <= MAX_HELD_BYTES) {
          this.#carry = text.slice(at);
          output += text.slice(kept, at);
          return Buffer.from(output, "latin1");
        }
        at += 1;
      } else at = end;
    }
    if (kept === 0 && text.length === data.length) return data;
    return Buffer.from(output + text.slice(kept), "latin1");
  }

  /**
   * Handle the escape sequence at `at`: return where to continue, having called `replace`
   * to drop or rewrite it, or undefined when the text ends before the sequence does.
   */
  #sequence(text: string, at: number, replace: (end: number, replacement: string) => void): number | undefined {
    const kind = text[at + 1];
    if (kind === undefined) return undefined;
    if (kind === "[") {
      CSI.lastIndex = at;
      const match = CSI.exec(text);
      if (!match) {
        CSI_PARTIAL.lastIndex = at;
        return CSI_PARTIAL.test(text) ? undefined : at + 1;
      }
      const replacement = csi(match[1]!, match[2]!, match[3]!, match[4]!);
      if (replacement !== undefined) replace(CSI.lastIndex, replacement);
      return CSI.lastIndex;
    }
    // DECID, an older request for device attributes.
    if (kind === "Z") { replace(at + 2, ""); return at + 2; }
    if (kind === "]") {
      const end = this.#stringEnd(text, at + 2, true);
      if (end === undefined) return undefined;
      if (end === "cut") return at + 1;
      const body = text.slice(at + 2, end.body);
      const fields = body.split(";").slice(1);
      if (READABLE_OSC.test(body) && fields.some((field) => field === "?" || field.endsWith("=?"))) replace(end.end, "");
      return end.end;
    }
    if (kind === "P") {
      DCS_HEADER.lastIndex = at;
      const header = DCS_HEADER.exec(text);
      if (!header) {
        DCS_PARTIAL.lastIndex = at;
        return DCS_PARTIAL.test(text) ? undefined : at + 1;
      }
      // DECRQSS and XTGETTCAP. Any other string, such as a sixel image, passes as it arrives.
      if (header[1] !== "$q" && header[1] !== "+q") return DCS_HEADER.lastIndex;
      const end = this.#stringEnd(text, DCS_HEADER.lastIndex, false);
      if (end === undefined) return undefined;
      if (end === "cut") return at + 1;
      replace(end.end, "");
      return end.end;
    }
    if (kind === "_") {
      // The kitty graphics protocol's query: `a=q` among the keys before the payload.
      if (text[at + 2] === undefined) return undefined;
      if (text[at + 2] !== "G") return at + 1;
      const control = /[;\x1b]/g;
      control.lastIndex = at + 3;
      const keys = control.exec(text);
      if (!keys) return undefined;
      if (!GRAPHICS_QUERY.test(text.slice(at + 3, keys.index))) return at + 1;
      const end = this.#stringEnd(text, keys.index, false);
      if (end === undefined) return undefined;
      if (end === "cut") return at + 1;
      replace(end.end, "");
      return end.end;
    }
    return at + 1;
  }

  /**
   * Where the control string whose content starts at `from` ends: its content's end and
   * its own. Undefined when the text ends first, and "cut" when another escape cuts the
   * string short, which then passes through.
   */
  #stringEnd(text: string, from: number, bell: boolean): { body: number; end: number } | "cut" | undefined {
    STRING_END.lastIndex = from;
    for (let match = STRING_END.exec(text); match; match = STRING_END.exec(text)) {
      if (match[0] === "\x07") {
        if (bell) return { body: match.index, end: match.index + 1 };
        continue;
      }
      if (match.index + 1 >= text.length) return undefined;
      return text[match.index + 1] === "\\" ? { body: match.index, end: match.index + 2 } : "cut";
    }
    return undefined;
  }
}

const LINE_FEED = 0x0a;
const VERTICAL_TAB = 0x0b;
const CARRIAGE_RETURN = 0x0d;

/**
 * A terminal in raw mode still turns every line feed written to it into a carriage return
 * and a line feed: raw mode in Bun, as in Node, leaves that conversion on. A full-screen
 * program has turned it off on its own PTY, and sends a line feed alone to move the cursor
 * down one row in the same column. Converted, the cursor lands in the first column, and
 * what the program draws next lands on top of other text.
 *
 * A vertical tab moves the cursor as a line feed does, and the conversion leaves it alone,
 * so it takes the place of each line feed that does not follow a carriage return. After a
 * carriage return the conversion changes nothing, and the line feed stays.
 */
export class BareLineFeeds {
  #afterReturn = false;

  /** A chunk of output as the terminal must receive it; the chunk itself is not changed. */
  keep(data: Uint8Array): Uint8Array {
    if (!data.length) return data;
    let output = data;
    for (let at = data.indexOf(LINE_FEED); at >= 0; at = data.indexOf(LINE_FEED, at + 1)) {
      if (at ? data[at - 1] === CARRIAGE_RETURN : this.#afterReturn) continue;
      if (output === data) output = Uint8Array.from(data);
      output[at] = VERTICAL_TAB;
    }
    this.#afterReturn = data[data.length - 1] === CARRIAGE_RETURN;
    return output;
  }
}
