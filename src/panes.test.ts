import assert from "node:assert/strict";
import test from "node:test";
import { Terminal as Screen } from "@xterm/headless";
import { compose, paint, PaneScreen, screenSize, tile, type Rect } from "./panes.js";

const text = (value: string) => new TextEncoder().encode(value);

/** What a terminal of this size shows after `output`, row by row. */
async function shown(output: string, cols: number, rows: number): Promise<string[]> {
  const terminal = new Screen({ cols, rows, allowProposedApi: true });
  await new Promise<void>((resolve) => terminal.write(output, resolve));
  const lines = Array.from({ length: rows }, (_, y) => terminal.buffer.active.getLine(y)!.translateToString(true).trimEnd());
  terminal.dispose();
  return lines;
}

test("panes tile the terminal: side by side for two, two rows for three or four, every cell used once", () => {
  assert.deepEqual(tile(1, 100, 30), [{ x: 0, y: 0, cols: 100, rows: 30 }]);
  assert.deepEqual(tile(2, 100, 30), [{ x: 0, y: 0, cols: 49, rows: 30 }, { x: 50, y: 0, cols: 50, rows: 30 }]);
  assert.deepEqual(tile(3, 100, 30).map((rect) => [rect.x, rect.y, rect.cols, rect.rows]), [[0, 0, 49, 15], [50, 0, 50, 15], [0, 15, 100, 15]]);
  assert.deepEqual(tile(4, 101, 31).map((rect) => [rect.x, rect.y, rect.cols, rect.rows]), [[0, 0, 50, 15], [51, 0, 50, 15], [0, 15, 50, 16], [51, 15, 50, 16]]);
  for (const count of [1, 2, 3, 4]) {
    for (const [cols, rows] of [[100, 30], [101, 31], [80, 24], [9, 5]] as const) {
      const used = Array.from({ length: rows }, () => Array<number>(cols).fill(0));
      for (const rect of tile(count, cols, rows)) {
        for (let y = rect.y; y < rect.y + rect.rows; y++) {
          for (let x = rect.x; x < rect.x + rect.cols; x++) used[y]![x]!++;
          if (rect.x + rect.cols < cols) used[y]![rect.x + rect.cols]!++;
        }
      }
      assert.ok(used.every((row) => row.every((cell) => cell === 1)), `${count} panes on ${cols}x${rows}`);
    }
  }
  assert.deepEqual(screenSize({ x: 0, y: 0, cols: 49, rows: 30 }), { cols: 49, rows: 29 });
  assert.deepEqual(screenSize({ x: 0, y: 0, cols: 1, rows: 1 }), { cols: 2, rows: 1 }, "a screen is never smaller than a terminal can be");
});

test("a pane's row keeps the program's colors and styles, and is cut to the pane's width", async () => {
  const screen = new PaneScreen({ cols: 30, rows: 3 });
  await screen.write(text("\x1b[1;31mred\x1b[0m \x1b[38;2;1;2;3;48;5;200mrgb\x1b[0m \x1b[92;4mok\x1b[0m 日本\r\n\x1b]0;my title\x07plain"));
  assert.equal(screen.row(0, 16), "\x1b[0;1;31mred\x1b[0m \x1b[0;38;2;1;2;3;48;5;200mrgb\x1b[0m \x1b[0;4;92mok\x1b[0m 日本 ");
  assert.equal(screen.row(0, 6), "\x1b[0;1;31mred\x1b[0m \x1b[0;38;2;1;2;3;48;5;200mrg\x1b[0m", "cut at the width");
  assert.equal(screen.row(0, 14), "\x1b[0;1;31mred\x1b[0m \x1b[0;38;2;1;2;3;48;5;200mrgb\x1b[0m \x1b[0;4;92mok\x1b[0m 日 ", "a wide character that does not fit is left out");
  assert.equal(screen.row(1, 8), "plain   ");
  assert.equal(screen.row(5, 4), "    ", "rows below the screen are blank");
  assert.equal(screen.title, "my title");
  screen.dispose();
});

test("the cursor and keyboard modes follow the program", async () => {
  const screen = new PaneScreen({ cols: 20, rows: 5 });
  await screen.write(text("ab\r\ncd"));
  assert.deepEqual(screen.state, { cursor: { x: 2, y: 1, visible: true }, modes: "\x1b[?1l\x1b>\x1b[?2004l" });
  await screen.write(text("\x1b[?1h\x1b=\x1b[?2004h\x1b[?25l"));
  assert.deepEqual(screen.state, { cursor: { x: 2, y: 1, visible: false }, modes: "\x1b[?1h\x1b=\x1b[?2004h" });
  screen.dispose();
});

test("the terminal shows each pane under its title, side by side, and repaints only the rows that changed", async () => {
  const [left, right] = [new PaneScreen({ cols: 10, rows: 3 }), new PaneScreen({ cols: 10, rows: 3 })];
  await left.write(text("left 1\r\nleft 2"));
  await right.write(text("right 1"));
  const rects: Rect[] = tile(2, 21, 4);
  const frame = (focused: number) => compose([
    { rect: rects[0]!, screen: left, title: "lf/tty-1", focused: focused === 0 },
    { rect: rects[1]!, screen: right, title: "studio/build · exited 2", focused: focused === 1 },
  ], 21, 4);
  const first = frame(0);
  assert.deepEqual(await shown(paint(first, []), 21, 4), [
    " lf/tty-1 │ studio/b…",
    "left 1    │right 1",
    "left 2    │",
    "          │",
  ]);
  assert.match(first[0]!, /^\x1b\[7m lf\/tty-1 \x1b\[0m\x1b\[2m│\x1b\[0m\x1b\[2m studio/, "the pane with the keys has its title in reverse");
  await right.write(text("\r\nright 2"));
  const second = frame(0);
  assert.equal(paint(second, first), `\x1b[3;1H${second[2]}`, "only the changed row is drawn");
  assert.equal(paint(frame(1), second).split("\x1b[1;1H").length, 2, "moving the keys redraws the title row");
  left.dispose();
  right.dispose();
});
