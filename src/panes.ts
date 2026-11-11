import { Terminal as Screen, type IBufferCell } from "@xterm/headless";
import { printable } from "./errors.js";
import { fit } from "./switcher.js";

/**
 * Panes for `cns ui`: several sessions on one terminal, tiled automatically. Each pane keeps a
 * local copy of its session's screen, fed by the session's output; the terminal shows every
 * copy, each under a title row, redrawing only the rows that changed. src/commands/ui-panes.ts
 * does the attaching and the keys.
 */

/** A rectangle on the terminal, 0-based. A pane's includes its title row. */
export interface Rect { x: number; y: number; cols: number; rows: number }

/**
 * Tile `count` panes over a terminal: one fills it, two sit side by side, three or four make
 * two rows. Every cell belongs to exactly one pane, or to the separator column that follows a
 * pane not at the right edge.
 */
export function tile(count: number, cols: number, rows: number): Rect[] {
  const across = Math.ceil(Math.sqrt(count));
  const down = Math.ceil(count / across);
  const rects: Rect[] = [];
  for (let row = 0; row < down; row++) {
    const inRow = Math.min(across, count - row * across);
    const y = Math.floor(row * rows / down);
    const height = Math.floor((row + 1) * rows / down) - y;
    for (let column = 0; column < inRow; column++) {
      // Each pane but the last gives up its last column to the separator.
      const x = Math.floor(column * (cols + 1) / inRow);
      rects.push({ x, y, cols: Math.floor((column + 1) * (cols + 1) / inRow) - 1 - x, rows: height });
    }
  }
  return rects;
}

/** The size of a pane's screen: its rectangle less the title row, and never smaller than a terminal can be. */
export const screenSize = (rect: Rect) => ({ cols: Math.max(2, rect.cols), rows: Math.max(1, rect.rows - 1) });

const color = (rgb: boolean, palette: boolean, value: number, base: number) =>
  rgb ? `;${base + 8};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}`
    : !palette ? "" : value < 8 ? `;${base + value}` : value < 16 ? `;${base + 52 + value}` : `;${base + 8};5;${value}`;

/** The SGR parameters that draw a cell as it is, after a reset. */
function style(cell: IBufferCell): string {
  return (cell.isBold() ? ";1" : "") + (cell.isDim() ? ";2" : "") + (cell.isItalic() ? ";3" : "") + (cell.isUnderline() ? ";4" : "")
    + (cell.isBlink() ? ";5" : "") + (cell.isInverse() ? ";7" : "") + (cell.isInvisible() ? ";8" : "") + (cell.isStrikethrough() ? ";9" : "")
    + color(cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor(), 30) + color(cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor(), 40);
}

/** A session's screen as this terminal keeps it for a pane. */
export class PaneScreen {
  #screen: Screen;
  #cell: IBufferCell;
  /** The title the program set, as it set it. */
  title = "";

  constructor({ cols, rows }: { cols: number; rows: number }) {
    this.#screen = new Screen({ cols, rows, scrollback: 0, allowProposedApi: true });
    this.#screen.onTitleChange((title) => { this.title = title; });
    this.#cell = this.#screen.buffer.active.getNullCell();
  }

  write(data: Uint8Array) { return new Promise<void>((resolve) => this.#screen.write(data, resolve)); }
  resize({ cols, rows }: { cols: number; rows: number }) { this.#screen.resize(cols, rows); }
  dispose() { this.#screen.dispose(); }
  get size() { return { cols: this.#screen.cols, rows: this.#screen.rows }; }

  /** Row `y` with its colors, cut or padded to exactly `width` columns, ending with styles reset. */
  row(y: number, width: number): string {
    const buffer = this.#screen.buffer.active;
    const line = y < this.#screen.rows ? buffer.getLine(buffer.baseY + y) : undefined;
    let out = "";
    let current = "";
    let used = 0;
    for (let x = 0; line && x < this.#screen.cols; x++) {
      const cell = line.getCell(x, this.#cell);
      const cells = cell?.getWidth() ?? 1;
      if (!cell || cells === 0) continue;
      if (used + cells > width) break;
      const next = style(cell);
      if (next !== current) { out += `\x1b[0${next}m`; current = next; }
      out += printable(cell.getChars() || " ");
      used += cells;
    }
    return out + (current ? "\x1b[0m" : "") + " ".repeat(width - used);
  }

  /** Where the program's cursor is, and the keyboard modes this terminal must use while the pane has the keys. */
  get state() {
    const buffer = this.#screen.buffer.active;
    const core = (this.#screen as unknown as { _core?: { coreService?: { isCursorHidden?: boolean } } })._core;
    const modes = this.#screen.modes;
    return {
      cursor: { x: buffer.cursorX, y: buffer.cursorY, visible: !core?.coreService?.isCursorHidden },
      modes: (modes.applicationCursorKeysMode ? "\x1b[?1h" : "\x1b[?1l") + (modes.applicationKeypadMode ? "\x1b=" : "\x1b>")
        + (modes.bracketedPasteMode ? "\x1b[?2004h" : "\x1b[?2004l"),
    };
  }
}

export interface PaneView { rect: Rect; screen: PaneScreen; title: string; focused: boolean }

const DIM = "\x1b[2m";
const INVERSE = "\x1b[7m";
const RESET = "\x1b[0m";

/** Every row of the terminal: each pane's title row and screen, with a separator column between panes side by side. */
export function compose(panes: readonly PaneView[], cols: number, rows: number): string[] {
  const lines = Array.from({ length: rows }, () => [] as { x: number; text: string }[]);
  for (const { rect, screen, title, focused } of panes) {
    lines[rect.y]?.push({ x: rect.x, text: (focused ? INVERSE : DIM) + fit(` ${title}`, rect.cols) + RESET });
    for (let row = 1; row < rect.rows; row++) lines[rect.y + row]?.push({ x: rect.x, text: screen.row(row - 1, rect.cols) });
    if (rect.x + rect.cols < cols) for (let row = 0; row < rect.rows; row++) lines[rect.y + row]?.push({ x: rect.x + rect.cols, text: `${DIM}│${RESET}` });
  }
  return lines.map((segments) => segments.sort((a, b) => a.x - b.x).map((segment) => segment.text).join(""));
}

/** What to write to turn `before` into `after`: the rows that changed, each drawn in full. */
export const paint = (after: readonly string[], before: readonly string[]) =>
  after.map((line, y) => line === before[y] ? "" : `\x1b[${y + 1};1H${line}`).join("");
