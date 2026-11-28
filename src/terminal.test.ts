import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Terminal as Screen } from "@xterm/headless";
import { kittyKeyboard } from "./test-support.js";

const posix = process.platform !== "win32";

// A session whose program took the alternate screen, the mouse and bracketed paste, attached
// by a process that then fails with an error nothing catches.
const FAILING_ATTACH = String.raw`
import { attachTerminal } from ${JSON.stringify(path.join(import.meta.dirname, "terminal.ts"))};
void attachTerminal(async (sink) => {
  await sink.output(Buffer.from("\x1b[0m\x1b[H\x1b[2J$ vim\r\n\x1b[?1049h\x1b[?1003h\x1b[?1006h\x1b[?2004h\x1b[2;5r\x1b[3;1Hfull-screen"), 10);
  setTimeout(() => { throw new Error("the failure nothing catches"); }, 300);
  return { write() {}, resize() {}, capture: async () => { throw new Error("unused"); }, [Symbol.dispose]() {} };
}, {}, { normalScreen: true });
`;

// What changed: cns reset the terminal only where it left a session in an orderly way. An
// error nothing caught ended it with the terminal still on the program's alternate screen and
// reporting the mouse, which types escape sequences into the shell at every movement.
test("an error that ends cns while a full-screen program has the terminal still gives the terminal back", { skip: !posix }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cns-terminal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, "failing-attach.ts");
  await writeFile(script, FAILING_ATTACH);
  const screen = new Screen({ cols: 80, rows: 10, scrollback: 100, allowProposedApi: true });
  t.after(() => screen.dispose());
  const settled = () => new Promise<void>((resolve) => screen.write("", resolve));
  let taken = false;
  const child = Bun.spawn([process.execPath, script], {
    terminal: {
      cols: 80, rows: 10, name: "xterm-256color",
      data: (_terminal, data) => {
        screen.write(data.slice());
        // The program had the terminal before the failure.
        if (screen.buffer.active.type === "alternate" && screen.modes.mouseTrackingMode === "any") taken = true;
      },
    },
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  assert.notEqual(await child.exited, 0);
  await settled();
  assert.equal(taken, true, "the program never took the terminal, so the test shows nothing");
  assert.deepEqual(
    { screen: screen.buffer.active.type, mouse: screen.modes.mouseTrackingMode, bracketedPaste: screen.modes.bracketedPasteMode },
    { screen: "normal", mouse: "none", bracketedPaste: false },
  );
});

// A session whose shell and editor each set a keyboard mode with the kitty protocol, attached
// by a process that passes the protocol on and then fails with an error nothing catches.
const FAILING_WITH_KEYS = String.raw`
import { attachTerminal } from ${JSON.stringify(path.join(import.meta.dirname, "terminal.ts"))};
void attachTerminal(async (sink) => {
  await sink.output(Buffer.from("\x1b[=1;1u\x1b[0m\x1b[H\x1b[2J$ vim\r\n\x1b[?1049h\x1b[>15u\x1b[3;1Hfull-screen"), 10);
  setTimeout(() => { throw new Error("the failure nothing catches"); }, 300);
  return { write() {}, resize() {}, capture: async () => { throw new Error("unused"); }, [Symbol.dispose]() {} };
}, {}, { normalScreen: true, keyboard: true });
`;

// Without this, a terminal left in a program's keyboard mode types codes such as 9;5u into
// the shell for every key with a modifier, until the user runs reset.
test("an error that ends cns while a program has set the terminal's keyboard mode gives the terminal its own mode back", { skip: !posix }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cns-terminal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, "failing-with-keys.ts");
  await writeFile(script, FAILING_WITH_KEYS);
  const screen = new Screen({ cols: 80, rows: 10, scrollback: 100, allowProposedApi: true });
  t.after(() => screen.dispose());
  const keyboard = kittyKeyboard(screen, () => {});
  // The terminal's own mode, from before cns ran: one a shell had pushed.
  await new Promise<void>((resolve) => screen.write("\x1b[>3u", resolve));
  assert.deepEqual(keyboard.all, [3, 1, 0, 0]);
  let taken = false;
  const child = Bun.spawn([process.execPath, script], {
    terminal: {
      cols: 80, rows: 10, name: "xterm-256color",
      data: (_terminal, data) => {
        screen.write(data.slice(), () => {
          // The editor's mode on the alternate screen, the shell's on the normal one under it.
          if (keyboard.all.join() === "1,2,15,1") taken = true;
        });
      },
    },
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  assert.notEqual(await child.exited, 0);
  await new Promise<void>((resolve) => screen.write("", resolve));
  assert.equal(taken, true, "the programs never set the terminal's keyboard mode, so the test shows nothing");
  assert.equal(screen.buffer.active.type, "normal");
  assert.deepEqual(keyboard.all, [3, 1, 0, 0]);
});

// A session whose redraw arrives well before the attach call returns, as through a holder
// under load. The session reports the keys it is given.
const SLOW_ATTACH = String.raw`
import { attachTerminal } from ${JSON.stringify(path.join(import.meta.dirname, "terminal.ts"))};
void attachTerminal(async (sink) => {
  await sink.output(Buffer.from("the session's screen\r\n"), 22);
  await new Promise((resolve) => setTimeout(resolve, 500));
  return {
    write(data) { process.stdout.write("keys " + JSON.stringify(Buffer.from(data).toString("latin1")) + "\r\n"); process.exit(7); },
    resize() {}, capture: async () => { throw new Error("unused"); }, [Symbol.dispose]() {},
  };
}, {}, { normalScreen: true });
`;

// What changed: the terminal went raw only once the attach call returned. A key typed at the
// redrawn screen before then was the terminal's: Ctrl-C stopped cns instead of the program.
test("a key typed at a session's screen before its attach call returns goes to the session", { skip: !posix }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cns-terminal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, "slow-attach.ts");
  await writeFile(script, SLOW_ATTACH);
  let output = "";
  let drawn!: () => void;
  const shown = new Promise<void>((resolve) => { drawn = resolve; });
  const child = Bun.spawn([process.execPath, script], {
    terminal: {
      cols: 80, rows: 10, name: "xterm-256color",
      data: (_terminal, data) => {
        output += Buffer.from(data).toString("latin1");
        if (output.includes("the session's screen")) drawn();
      },
    },
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await shown;
  child.terminal!.write("\x03");
  assert.equal(await child.exited, 7, output);
  assert.match(output, /keys "\\u0003"/);
});

// A session that shows its screen and then fails its attach call. The process carries on and
// reads a line, as cns shell does before it tries the session again.
const FAILED_ATTACH = String.raw`
import { attachTerminal } from ${JSON.stringify(path.join(import.meta.dirname, "terminal.ts"))};
try {
  await attachTerminal(async (sink) => {
    await sink.output(Buffer.from("the session's screen\r\n"), 22);
    throw new Error("the attach failed");
  }, {}, { normalScreen: true });
} catch (error) {
  process.stdout.write("caught: " + (error as Error).message + "\n");
}
process.stdin.once("data", (data) => { process.stdout.write("read " + JSON.stringify(String(data)) + "\n"); process.exit(0); });
process.stdin.resume();
`;

// The first output makes the terminal raw. Left raw after a failed attach, the terminal shows
// nothing that is typed, and Enter no longer ends a line.
test("an attach that fails after the session's first output gives the terminal its own mode back", { skip: !posix }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "cns-terminal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, "failed-attach.ts");
  await writeFile(script, FAILED_ATTACH);
  let output = "";
  let caught!: () => void;
  const failed = new Promise<void>((resolve) => { caught = resolve; });
  const child = Bun.spawn([process.execPath, script], {
    terminal: {
      cols: 80, rows: 10, name: "xterm-256color",
      data: (_terminal, data) => {
        output += Buffer.from(data).toString("latin1");
        if (output.includes("caught: the attach failed")) caught();
      },
    },
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  await failed;
  const typed = output.length;
  child.terminal!.write("typed\r");
  assert.equal(await child.exited, 0, output);
  // Cooked again: the terminal echoes the line, and hands it over at Enter as a line.
  assert.match(output.slice(typed), /typed\r\n[^]*read "typed\\n"/);
});
