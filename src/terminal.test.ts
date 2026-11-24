import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Terminal as Screen } from "@xterm/headless";

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
