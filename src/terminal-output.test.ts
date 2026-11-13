import assert from "node:assert/strict";
import test from "node:test";
import { Terminal as Screen } from "@xterm/headless";
import { BareLineFeeds, MAX_HELD_BYTES, QueryFilter } from "./terminal-output.js";

const bytes = (text: string) => Buffer.from(text, "latin1");
const shown = (text: string) => JSON.stringify(text);
const written = (screen: Screen, data: Uint8Array | string) => new Promise<void>((resolve) => screen.write(data, resolve));

/** What a terminal receives of `chunks`, which arrive one after the other. */
function filtered(chunks: Uint8Array[]) {
  const filter = new QueryFilter();
  return Buffer.concat(chunks.map((chunk) => filter.filter(chunk))).toString("latin1");
}

/** Everything a terminal that answers all it can replies to `output`. */
async function replies(output: string) {
  const windowOptions = Object.fromEntries(["getWinState", "getWinPosition", "getWinSizePixels", "getScreenSizePixels", "getCellSizePixels", "getWinSizeChars", "getScreenSizeChars", "getIconTitle", "getWinTitle"].map((name) => [name, true]));
  const screen = new Screen({ cols: 40, rows: 10, allowProposedApi: true, windowOptions });
  let reply = "";
  screen.onData((data) => { reply += data; });
  await written(screen, bytes(output));
  screen.dispose();
  return reply;
}

// Each makes a terminal that knows it send a reply, or changes what its keys send.
const QUERIES: Record<string, string> = {
  "primary device attributes": "\x1b[c",
  "primary device attributes, with its parameter": "\x1b[0c",
  "secondary device attributes": "\x1b[>c",
  "tertiary device attributes": "\x1b[=0c",
  "device attributes, the VT52 way": "\x1bZ",
  "device status": "\x1b[5n",
  "cursor position": "\x1b[6n",
  "cursor position, with the page": "\x1b[?6n",
  "colour scheme": "\x1b[?996n",
  "a private mode's state": "\x1b[?2048$p",
  "a mode's state": "\x1b[4$p",
  "presentation state": "\x1b[1$w",
  "terminal state": "\x1b[1$u",
  "a checksum of the screen": "\x1b[1;1;1;1;40;10*y",
  "the kitty keyboard flags": "\x1b[?u",
  "a push of kitty keyboard flags": "\x1b[>1u",
  "a pop of kitty keyboard flags": "\x1b[<u",
  "new kitty keyboard flags": "\x1b[=1;1u",
  "the terminal's name and version": "\x1b[>q",
  "the terminal's name and version, with its parameter": "\x1b[>0q",
  "the window's size in pixels": "\x1b[14t",
  "the window's size in cells": "\x1b[18t",
  "the window's title": "\x1b[21t",
  "terminal parameters": "\x1b[x",
  "the number of colour registers": "\x1b[?1;1;0S",
  "how modified keys are sent": "\x1b[?4m",
  "the answerback string": "\x05",
  "the foreground colour": "\x1b]10;?\x07",
  "the background colour": "\x1b]11;?\x1b\\",
  "a palette colour": "\x1b]4;1;?\x07",
  "two colours at once": "\x1b]10;?;?\x07",
  "a colour by name": "\x1b]21;foreground=?\x1b\\",
  "the clipboard": "\x1b]52;c;?\x07",
  "a setting": "\x1bP$qm\x1b\\",
  "terminal capabilities": "\x1bP+q5463;524742\x1b\\",
  "kitty graphics support": "\x1b_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA\x1b\\",
  "in-band resize reports": "\x1b[?2048h",
};

// Each only draws or sets something, and must reach the terminal as it is.
const KEPT: Record<string, string> = {
  "restore the cursor": "\x1b[u",
  "save and restore the cursor": "\x1b7\x1b8",
  "the cursor's shape": "\x1b[2 q",
  "the Linux console's cursor shape": "\x1b[?6c",
  "scroll up": "\x1b[2S",
  "push and pop the title": "\x1b[22;0t\x1b[23;0t",
  "how modified keys are sent": "\x1b[>4;2m",
  "colours": "\x1b[0m\x1b[38;2;1;2;3m\x1b[4:3m",
  "modes": "\x1b[?1049h\x1b[?25l\x1b[?1004;2004h\x1b[?2048l\x1b[4h",
  "a soft reset": "\x1b[!p",
  "the scrolling region": "\x1b[1;18r\x1b[H\x1b[M\x1b[r",
  "character sets and keypad": "\x1b(B\x1b=\x1b>\x1bM",
  "a link with a query in its address": "\x1b]8;;https://example.com/?q=1\x1b\\link\x1b]8;;\x1b\\",
  "a title that asks": "\x1b]0;what?\x07",
  "a new background colour": "\x1b]11;#101010\x07",
  "a clipboard write": "\x1b]52;c;aGk=\x07",
  "a sixel image": "\x1bPq#0;2;0;0;0#0~~@@vv@@~~$\x1b\\",
  "a kitty image": "\x1b_Ga=T,f=24,s=1,v=1;AAAA\x1b\\",
  "an application's own string": "\x1b_other\x1b\\",
  "text": "plain text, 漢字 and ✓\r\n",
  "an escape that starts nothing": "\x1b\x1b[1mbold",
};

test("a terminal gets none of the queries a session's program sends", async (t) => {
  for (const [name, query] of Object.entries(QUERIES)) {
    await t.test(name, () => {
      assert.equal(filtered([bytes(`before${query}after`)]), "beforeafter");
    });
  }
});

test("a terminal gets what only draws or sets something, byte for byte", async (t) => {
  for (const [name, sequence] of Object.entries(KEPT)) {
    await t.test(name, () => {
      const raw = Buffer.from(`before${sequence}after`).toString("latin1");
      assert.equal(filtered([bytes(raw)]), raw);
    });
  }
});

test("in-band resize reports are taken out of the modes a program sets, and only they", () => {
  assert.equal(filtered([bytes("\x1b[?1004;2048h")]), "\x1b[?1004h");
  assert.equal(filtered([bytes("\x1b[?2048;2004;1004h")]), "\x1b[?2004;1004h");
  assert.equal(filtered([bytes("\x1b[?2048h\x1b[?2026h")]), "\x1b[?2026h");
  // The ANSI mode of the same number is another mode.
  assert.equal(filtered([bytes("\x1b[2048h")]), "\x1b[2048h");
});

test("nothing a terminal is sent makes it reply", async () => {
  const raw = Object.values(QUERIES).join("") + Object.values(KEPT).map((sequence) => Buffer.from(sequence).toString("latin1")).join("");
  // The check has teeth: the same terminal does reply to the output as the program sent it.
  const unfiltered = await replies(raw);
  for (const expected of ["\x1b[?1;2c", "\x1b[>0;276;0c", "\x1b[0n", "\x1b[8;10;40t", "\x1b[?2048;0$y", "\x1bP1$r0m\x1b\\"]) {
    assert.ok(unfiltered.includes(expected), `the terminal answered ${shown(unfiltered)} without ${shown(expected)}`);
  }
  assert.equal(await replies(filtered([bytes(raw)])), "");
});

// What Neovim 0.12 sends as it starts and as it exits, around some of what it draws.
const NEOVIM = Buffer.from([
  "\x1b[?1049h\x1b[?1h\x1b=\x1b[H\x1b[2J\x1b[?2004h\x1b[?69$p\x1b[?2026$p\x1b[?2027$p\x1b[?2031$p\x1b[?2048$p\x1b[0m\x1b[4:3m\x1bP$qm\x1b\\\x1b[?u\x1b[c\x1b]11;?\x07\x1b[5n\x1b[?25h",
  "\x1bP+q5463;524742;73657472676266;73657472676262\x1b\\\x1b[>4;2m\x1b[?2048h\x1b[?1004h",
  "\x1b[1;18r\x1b[H\x1b[M\x1b[r\x1b[18;1Hline 74 漢字 ✓\x1b[K\n\x1b(B\x1b[m\x1b[38;2;224;226;234m5\r\x1b[15A",
  "\x1b]0;long.txt - Nvim\x07\x1b[c\x1b[?1049l$ ",
].join("")).toString("latin1");
const NEOVIM_SHOWN = Buffer.from([
  "\x1b[?1049h\x1b[?1h\x1b=\x1b[H\x1b[2J\x1b[?2004h\x1b[0m\x1b[4:3m\x1b[?25h",
  "\x1b[>4;2m\x1b[?1004h",
  "\x1b[1;18r\x1b[H\x1b[M\x1b[r\x1b[18;1Hline 74 漢字 ✓\x1b[K\n\x1b(B\x1b[m\x1b[38;2;224;226;234m5\r\x1b[15A",
  "\x1b]0;long.txt - Nvim\x07\x1b[?1049l$ ",
].join("")).toString("latin1");

test("queries split across chunks are still removed, and nothing else is lost", () => {
  assert.equal(filtered([bytes(NEOVIM)]), NEOVIM_SHOWN);
  for (let at = 1; at < NEOVIM.length; at++) {
    assert.equal(filtered([bytes(NEOVIM.slice(0, at)), bytes(NEOVIM.slice(at))]), NEOVIM_SHOWN, `split at ${at}: ${shown(NEOVIM.slice(at - 8, at))} | ${shown(NEOVIM.slice(at, at + 8))}`);
  }
  assert.equal(filtered(Array.from(NEOVIM, (byte) => bytes(byte))), NEOVIM_SHOWN);
  assert.equal(filtered((NEOVIM.match(/[^]{1,7}/g) ?? []).map(bytes)), NEOVIM_SHOWN);
});

test("output without queries is passed on as the same chunk, not a copy", () => {
  const filter = new QueryFilter();
  for (const text of ["plain text\r\n", "\x1b[1mbold\x1b[0m", "\x1b]0;title\x07"]) {
    const chunk = bytes(text);
    assert.equal(filter.filter(chunk), chunk);
  }
});

test("an image is passed on as it arrives, not held until it ends", () => {
  const filter = new QueryFilter();
  const start = "\x1bPq#0;2;0;0;0#0~~@@vv@@~~$";
  assert.equal(Buffer.from(filter.filter(bytes(start))).toString("latin1"), start);
  assert.equal(Buffer.from(filter.filter(bytes("~~@@\x1b\\after"))).toString("latin1"), "~~@@\x1b\\after");
});

test("a sequence that never ends is held only up to a limit, then passed on whole", () => {
  const filter = new QueryFilter();
  const start = "\x1b]52;c;" + "A".repeat(100);
  // It may yet end as a query, so the terminal waits for it.
  assert.equal(filter.filter(bytes(start)).length, 0);
  const rest = "B".repeat(MAX_HELD_BYTES) + "\x1b[6n" + "C".repeat(10);
  assert.equal(Buffer.from(filter.filter(bytes(rest))).toString("latin1"), start + "B".repeat(MAX_HELD_BYTES) + "C".repeat(10));
});

/** What the terminal driver of a terminal in raw mode makes of output: Bun and Node leave ONLCR on. */
const throughDriver = (data: Uint8Array) => bytes(Buffer.from(data).toString("latin1").replace(/\n/g, "\r\n"));

test("a line feed alone moves the cursor down in the same column on a terminal that converts line feeds", async () => {
  // What Neovim sends to change one cell under the end of the line it just drew.
  const output = "\x1b[2;1Hline 74 abcdefghij\n5\x1b[4;1Hshell output\r\nnext line";
  const draw = async (data: Uint8Array) => {
    const screen = new Screen({ cols: 40, rows: 6, allowProposedApi: true });
    await written(screen, throughDriver(data));
    const rows = Array.from({ length: 6 }, (_, y) => screen.buffer.active.getLine(y)!.translateToString(true));
    screen.dispose();
    return rows;
  };
  // Without it, the driver's carriage return puts the 5 in the first column.
  assert.deepEqual((await draw(bytes(output))).slice(1, 3), ["line 74 abcdefghij", "5"]);
  const kept = new BareLineFeeds().keep(bytes(output));
  assert.deepEqual(await draw(kept), ["", "line 74 abcdefghij", "                  5", "shell output", "next line", ""]);
  // A line feed after a carriage return is the same with or without the conversion, and stays.
  assert.equal(Buffer.from(kept).toString("latin1"), "\x1b[2;1Hline 74 abcdefghij\x0b5\x1b[4;1Hshell output\r\nnext line");
});

test("a line feed is known to follow a carriage return across chunks", () => {
  const whole = "a\r\nb\nc\r\n\nd\n";
  const expected = "a\r\nb\x0bc\r\n\x0bd\x0b";
  const kept = (chunks: string[]) => { const lineFeeds = new BareLineFeeds(); return chunks.map((chunk) => Buffer.from(lineFeeds.keep(bytes(chunk))).toString("latin1")).join(""); };
  assert.equal(kept([whole]), expected);
  for (let at = 1; at < whole.length; at++) assert.equal(kept([whole.slice(0, at), whole.slice(at)]), expected, `split at ${at}`);
  assert.equal(kept([...whole]), expected);
  // An empty chunk between the two changes nothing.
  assert.equal(kept(["a\r", "", "\nb"]), "a\r\nb");
});

test("output is not changed in place, and is the same chunk when nothing changes", () => {
  const lineFeeds = new BareLineFeeds();
  const cooked = bytes("one\r\ntwo\r\n");
  assert.equal(lineFeeds.keep(cooked), cooked);
  const raw = bytes("one\ntwo");
  const kept = lineFeeds.keep(raw);
  assert.notEqual(kept, raw);
  assert.equal(raw.toString("latin1"), "one\ntwo");
  assert.equal(Buffer.from(kept).toString("latin1"), "one\x0btwo");
});
