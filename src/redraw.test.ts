import assert from "node:assert/strict";
import test from "node:test";
import { Terminal as Screen } from "@xterm/headless";
import { AttachedScreen } from "./redraw.js";

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

test("attached terminals stay on their alternate screen and show each screen the program switches to", async () => {
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
