import assert from "node:assert/strict";
import test from "node:test";
import { Terminal as Screen } from "@xterm/headless";
import { AttachedScreen, NormalScreen } from "./redraw.js";

const cols = 30, rows = 5;
function lines(screen: Screen) {
  const buffer = screen.buffer.active;
  return Array.from({ length: rows }, (_, y) => buffer.getLine(buffer.viewportY + y)!.translateToString(true).trimEnd()).join("\n");
}
const written = (screen: Screen, data: Uint8Array | string) => new Promise<void>((resolve) => screen.write(data, resolve));

// A shell, then a full-screen program, back to the shell and into another program.
const stream = Buffer.from([
  "$ vim\r\n",
  "\x1b[?1049h\x1b[2J\x1b[Hvim screen\x1b[3;2Hrow 3 漢字",
  "\x1b[?1049l$ less\r\n",
  "\x1b[?1;1049h\x1b[2J\x1b[Hless page",
].join(""));

async function show(chunks: Uint8Array[]) {
  const attached = new AttachedScreen(cols, rows);
  // The local terminal switches to its alternate screen before any output.
  const local = new Screen({ cols, rows, allowProposedApi: true });
  await written(local, "\x1b[?1049h");
  let output = "";
  for (const chunk of chunks) {
    const translated = await attached.translate(chunk);
    output += Buffer.from(translated).toString("latin1");
    await written(local, translated);
  }
  attached.dispose();
  return { local, output };
}

test("terminals attached by cns ui and the console stay on their alternate screen and show each screen the program switches to", async () => {
  const program = new Screen({ cols, rows, allowProposedApi: true });
  const checks: [number, string][] = [];
  // Check after each segment that the local terminal shows what the program shows.
  const segments = ["$ vim\r\n", "\x1b[?1049h\x1b[2J\x1b[Hvim screen\x1b[3;2Hrow 3 漢字", "\x1b[?1049l$ less\r\n", "\x1b[?1;1049h\x1b[2J\x1b[Hless page"];
  const attached = new AttachedScreen(cols, rows);
  const local = new Screen({ cols, rows, allowProposedApi: true });
  await written(local, "\x1b[?1049h");
  for (const [index, segment] of segments.entries()) {
    await written(program, segment);
    await written(local, await attached.translate(Buffer.from(segment)));
    checks.push([index, lines(program)]);
    assert.equal(lines(local), lines(program), `after segment ${index}`);
    assert.equal(local.buffer.active.type, "alternate");
    assert.equal(local.buffer.active.cursorX, program.buffer.active.cursorX, `cursor x after segment ${index}`);
    assert.equal(local.buffer.active.cursorY, program.buffer.active.cursorY, `cursor y after segment ${index}`);
  }
  assert.match(checks[2]![1], /^\$ vim\n\$ less$/m);
  // Other modes in the same sequence still reach the terminal.
  assert.equal(local.modes.applicationCursorKeysMode, true);
  attached.dispose();
});

test("screen switches split across chunks are still caught", async () => {
  const reference = await show([stream]);
  assert.doesNotMatch(reference.output, /\x1b\[\?(?:[0-9;]*;)?(?:47|1047|1049)[;hl]/);
  for (let split = 1; split < stream.length; split++) {
    const { local, output } = await show([stream.subarray(0, split), stream.subarray(split)]);
    assert.doesNotMatch(output, /\x1b\[\?(?:[0-9;]*;)?(?:47|1047|1049)[;hl]/, `split at ${split}`);
    assert.equal(lines(local), lines(reference.local), `split at ${split}`);
  }
  const bytes = await show([...stream].map((byte) => Uint8Array.of(byte)));
  assert.equal(lines(bytes.local), lines(reference.local));
  assert.match(lines(bytes.local), /^less page\n/);
});

test("a session on the normal screen leaves the alternate screen the way its program entered it", () => {
  const screen = new NormalScreen();
  assert.equal(screen.leave(), "");
  screen.follow(Buffer.from("$ vim\r\n\x1b[?1049h\x1b[2J"));
  assert.equal(screen.leave(), "\x1b[?1049l");
  screen.follow(Buffer.from("\x1b[?25l text \x1b[?1049l$ "));
  assert.equal(screen.leave(), "");
  // Among other modes, and the older switches.
  screen.follow(Buffer.from("\x1b[?1;47;25h"));
  assert.equal(screen.leave(), "\x1b[?47l");
  screen.follow(Buffer.from("\x1b[?47l\x1b[?1047h\x1b[?1h"));
  assert.equal(screen.leave(), "\x1b[?1047l");
  // The last switch in a chunk decides, as it does for the terminal.
  screen.follow(Buffer.from("\x1b[?1047l\x1b[?1049h\x1b[?1049l"));
  assert.equal(screen.leave(), "");
});

test("what a terminal shows is scrolled into its scrollback before a redraw clears the screen", async () => {
  const local = new Screen({ cols, rows, scrollback: 100, allowProposedApi: true });
  // A terminal with a few commands on it, the cursor on the row below them.
  await written(local, "one\r\ntwo\r\nthree\r\n");
  await written(local, NormalScreen.scrollAway(rows) + "\x1b[0m\x1b[H\x1b[2Jsession");
  const buffer = local.buffer.active;
  const all = Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)!.translateToString(true));
  assert.deepEqual(all.slice(0, 3), ["one", "two", "three"]);
  assert.equal(lines(local), "session\n\n\n\n");
  // A full screen, the cursor on its last row, is kept whole too.
  const full = new Screen({ cols, rows, scrollback: 100, allowProposedApi: true });
  await written(full, "1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7");
  await written(full, NormalScreen.scrollAway(rows) + "\x1b[0m\x1b[H\x1b[2Jsession");
  const kept = Array.from({ length: full.buffer.active.length }, (_, y) => full.buffer.active.getLine(y)!.translateToString(true));
  assert.deepEqual(kept.slice(0, 7), ["1", "2", "3", "4", "5", "6", "7"]);
  local.dispose();
  full.dispose();
});
