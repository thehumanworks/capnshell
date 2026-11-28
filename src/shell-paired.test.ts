import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Client, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Terminal as Screen } from "@xterm/headless";
import { cliEnvironment, cliInvocation, endHolders, kittyKeyboard, launchCli, unusedPort } from "./test-support.js";

const posix = process.platform !== "win32";
const decoder = new TextDecoder();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What reads a pseudo-terminal's output besides the test, and may send input of its own. */
interface TerminalReader {
  cols: number;
  rows: number;
  read(data: Uint8Array, send: (text: string) => void): void;
}

/** Run cns on a pseudo-terminal, as a person at a terminal would. */
function inTerminal(t: TestContext, args: string[], env: Record<string, string>, reader?: TerminalReader) {
  const invocation = cliInvocation(args);
  let output = "";
  let notify = () => {};
  const child = Bun.spawn([invocation.file, ...invocation.args], {
    env: cliEnvironment(env) as Record<string, string>,
    terminal: {
      cols: reader?.cols ?? 100, rows: reader?.rows ?? 30, name: "xterm-256color",
      data: (terminal, data) => {
        output += decoder.decode(data, { stream: true });
        reader?.read(data.slice(), (text) => { terminal.write(text); });
        notify();
      },
    },
  });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const waitFor = (needle: string, from = 0) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Waiting for ${JSON.stringify(needle)} in ${JSON.stringify(output.slice(-600))}`)), 15000);
    notify = () => { if (output.indexOf(needle, from) >= 0) { clearTimeout(timer); resolve(); } };
    notify();
  });
  return {
    write: (text: string) => child.terminal!.write(text),
    /** Close the terminal, as closing its window does: cns gets SIGHUP. */
    close: () => child.terminal!.close(),
    /** Interrupt cns itself, as Ctrl-C does before cns has taken the keys for the session. */
    interrupt: () => child.kill("SIGINT"),
    /** Stop cns, as kill does. */
    terminate: () => child.kill("SIGTERM"),
    get output() { return output; },
    exited: child.exited,
    waitFor,
    /** Wait until cns has attached to a session, and return the session's name. */
    attached: async () => {
      await waitFor("Ctrl-] detaches");
      return /session (\S+)\. Ctrl-\] detaches/.exec(output)![1]!;
    },
  };
}

/**
 * Run cns on a pseudo-terminal that a model of a terminal emulator reads. The model draws
 * what cns writes and, as Ghostty does, answers every query that reaches it and reports its
 * size in-band to a program that turns those reports on. What it draws has passed the
 * pseudo-terminal's driver, which converts line feeds as the driver of a real terminal does.
 * Like a real terminal, it keeps the lines that scroll off the top of its normal screen.
 */
function inEmulator(t: TestContext, args: string[], env: Record<string, string>, cols: number, rows: number, { kitty = false, answerAfterMs = 0 } = {}) {
  const screen = new Screen({ cols, rows, scrollback: 1000, allowProposedApi: true });
  t.after(() => screen.dispose());
  /** Everything the emulator sent that nobody typed. */
  const sent: string[] = [];
  let write = (_text: string) => {};
  // `answerAfterMs` is a terminal far away, whose answers take that long to arrive.
  const send = (text: string) => { if (answerAfterMs) setTimeout(() => write(text), answerAfterMs); else write(text); };
  let recent = "";
  // With `kitty` the model speaks the kitty keyboard protocol, as kitty, Ghostty and Rex do.
  // Without it, it stays silent but still notes what it was sent, so a test can see that nothing was.
  const keyboard = kittyKeyboard(screen, (reply) => { if (kitty) { sent.push(reply); send(reply); } });
  screen.onData((reply) => {
    sent.push(reply);
    send(reply.replace("\x1b[?1;2c", "\x1b[?62;22c").replace("\x1b[?2048;0$y", "\x1b[?2048;2$y"));
  });
  const terminal = inTerminal(t, args, env, { cols, rows, read: (data, writer) => {
    write = writer;
    screen.write(data);
    recent = (recent + Buffer.from(data).toString("latin1")).slice(-4096);
    if (!recent.includes("\x1b[?2048h")) return;
    recent = "";
    const report = `\x1b[48;${rows};${cols};0;0t`;
    sent.push(report);
    writer(report);
  } });
  /** The rows of the emulator's screen, once it has drawn all it received. */
  const drawn = async () => {
    await new Promise<void>((resolve) => screen.write("", resolve));
    const buffer = screen.buffer.active;
    return Array.from({ length: rows }, (_, y) => buffer.getLine(buffer.baseY + y)!.translateToString(true));
  };
  /** Every row the emulator holds: its scrollback, then its screen. */
  const scrollback = async () => {
    await new Promise<void>((resolve) => screen.write("", resolve));
    const buffer = screen.buffer.active;
    return Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y)!.translateToString(true));
  };
  return Object.assign(terminal, {
    sent,
    drawn,
    scrollback,
    /** The emulator's keyboard mode, once it has read all it received: flags and depth of the normal screen, then of the alternate one. */
    keyboard: async () => {
      await new Promise<void>((resolve) => screen.write("", resolve));
      return keyboard.all;
    },
    /** Wait until the emulator's keyboard mode is `mode`. */
    keyboardIs: async (mode: number[]) => {
      for (const end = Date.now() + 15000; ; await pause(20)) {
        await new Promise<void>((resolve) => screen.write("", resolve));
        if (keyboard.all.join() === mode.join()) return;
        if (Date.now() > end) throw new Error(`Waiting for the keyboard mode ${mode.join()}; it is ${keyboard.all.join()}`);
      }
    },
    /** The emulator's state now: which screen it shows, where its cursor is and what it reports. */
    state: async () => {
      await new Promise<void>((resolve) => screen.write("", resolve));
      const buffer = screen.buffer.active;
      return { screen: buffer.type, cursorY: buffer.cursorY, mouse: screen.modes.mouseTrackingMode, bracketedPaste: screen.modes.bracketedPasteMode };
    },
    /** Wait until a row of the screen has `text`. */
    shows: async (text: string) => {
      for (const end = Date.now() + 15000; ; await pause(20)) {
        const now = await drawn();
        if (now.some((row) => row.includes(text))) return now;
        if (Date.now() > end) throw new Error(`Waiting for ${JSON.stringify(text)} on the screen:\n${now.join("\n")}`);
      }
    },
  });
}

/** A device, studio, running its daemon, and laptop paired with it with every grant. */
async function pairedStudio(t: TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-shell-paired-")));
  // Hooks run in the order they were added: stop the daemon and proxy, then remove the directory.
  const cleanups: Array<() => Promise<unknown>> = [];
  t.after(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); await rm(root, { recursive: true, force: true }); });
  const device = async (name: string) => {
    const dir = path.join(root, name);
    await mkdir(dir, { mode: 0o700 });
    return { env: { CNS_CONFIG_DIR: dir, HOME: dir, SHELL: "/bin/bash" }, state: path.join(dir, "daemon.json"), dir };
  };
  const cli = async (dev: { env: Record<string, string> }, args: string[], input = "") => {
    const child = launchCli(t, args, { env: dev.env });
    child.child.stdin.end(input);
    return { code: await child.exited, stdout: child.stdout, stderr: child.stderr };
  };
  const studio = await device("studio");
  const port = await unusedPort("127.0.0.1");
  assert.equal((await cli(studio, ["up", "--bind", "127.0.0.1", "--port", port, "--state", studio.state])).code, 0);
  cleanups.push(async () => { await cli(studio, ["stop", "--state", studio.state]); await endHolders(studio.state); });
  /** Pair another device with studio, which grants it `grant`. */
  const pair = async (name: string, grant: string) => {
    const dev = await device(name);
    const inviting = launchCli(t, ["pair", "--yes", "--name", name, "--grant", grant, "--state", studio.state], { env: studio.env });
    inviting.child.stdin.end();
    await inviting.waitFor("Invite: cns1:");
    const invite = /Invite: (cns1:[A-Za-z0-9_-]+)/.exec(inviting.stdout)![1]!;
    assert.equal((await cli(dev, ["pair", invite, "--yes", "--name", "studio"])).code, 0);
    assert.equal(await inviting.exited, 0);
    return dev;
  };
  const laptop = await pair("laptop", "all");

  /** The names of studio's sessions now, as laptop lists them. */
  const sessions = async () => {
    const listed = await cli(laptop, ["sessions", "studio", "--json"]);
    assert.equal(listed.code, 0, listed.stderr);
    return (JSON.parse(listed.stdout) as Array<{ name: string }>).map((session) => session.name).sort();
  };
  /** Wait until studio no longer lists the session `name`. */
  const gone = async (name: string) => {
    for (let tries = 0; (await sessions()).includes(name); tries++) {
      if (tries > 50) assert.fail(`${name} is still listed on studio: ${JSON.stringify(await sessions())}`);
      await pause(100);
    }
  };

  /** Make laptop reach studio through a proxy that can cut connections and refuse new ones. */
  const throughProxy = async () => {
    const proxied = { refusing: false };
    const sockets: net.Socket[] = [];
    const proxy = net.createServer((client) => {
      if (proxied.refusing) { client.destroy(); return; }
      const upstream = net.connect(Number(port), "127.0.0.1");
      sockets.push(client, upstream);
      client.pipe(upstream).pipe(client);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    });
    const proxyPort = Number(await unusedPort("127.0.0.1"));
    await new Promise<void>((resolve) => proxy.listen(proxyPort, "127.0.0.1", resolve));
    cleanups.push(async () => { for (const socket of sockets) socket.destroy(); proxy.close(); });
    const file = path.join(laptop.dir, "peers", "studio");
    const record = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...record, addresses: [`ws://127.0.0.1:${proxyPort}`] }), { mode: 0o600 });
    return Object.assign(proxied, {
      cut: () => { for (const socket of sockets.splice(0)) socket.destroy(); },
      /** Point laptop at studio directly again, past the proxy. */
      bypass: () => writeFile(file, JSON.stringify(record), { mode: 0o600 }),
    });
  };

  return {
    root, cli, pair, laptop, sessions, gone, throughProxy,
    terminal: (dev: { env: Record<string, string> }, args: string[]) => inTerminal(t, args, dev.env),
    emulator: (dev: { env: Record<string, string> }, args: string[], cols: number, rows: number, options?: { kitty?: boolean; answerAfterMs?: number }) => inEmulator(t, args, dev.env, cols, rows, options),
  };
}

// What changed: cns shell DEVICE at a terminal used to join the device's session main, so every
// terminal on a device typed into the same shell. Each now starts a session of its own.

test("two terminals running cns shell DEVICE each get a shell of their own", { skip: !posix, timeout: 60000 }, async (t) => {
  const { laptop, sessions, terminal } = await pairedStudio(t);
  const [a, b] = [terminal(laptop, ["shell", "studio"]), terminal(laptop, ["shell", "studio"])];
  const [nameA, nameB] = await Promise.all([a.attached(), b.attached()]);
  assert.notEqual(nameA, nameB, `both terminals attached to the session ${nameA}`);
  assert.deepEqual([nameA, nameB].sort(), ["shell-1", "shell-2"]);
  a.write("echo typed-$((2+3))-in-a\r");
  b.write("echo typed-$((3+4))-in-b\r");
  await Promise.all([a.waitFor("typed-5-in-a"), b.waitFor("typed-7-in-b")]);
  await pause(300);
  assert.doesNotMatch(b.output, /typed-5-in-a/, "terminal b shows what was typed in terminal a");
  assert.doesNotMatch(a.output, /typed-7-in-b/, "terminal a shows what was typed in terminal b");
  assert.deepEqual(await sessions(), ["shell-1", "shell-2"]);
});

test("cns sessions without a device lists every paired device's sessions, and names the ones it may not list", { skip: !posix, timeout: 60000 }, async (t) => {
  const { cli, pair, laptop } = await pairedStudio(t);
  assert.equal((await cli(laptop, ["shell", "studio", "--name", "build", "--", "sleep 60"])).code, 0);
  const listed = await cli(laptop, ["sessions"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /^DEVICE +NAME +STATUS +SIZE +ATTACHED +TITLE OR COMMAND\nstudio +build +running +80x24 +0 +sleep 60\n$/);
  assert.equal(listed.stderr, "");
  const json = await cli(laptop, ["sessions", "--json"]);
  const [entry] = JSON.parse(json.stdout) as Array<{ device: string; state: string; sessions: Array<{ name: string }> }>;
  assert.deepEqual([entry?.device, entry?.state, entry?.sessions.map((session) => session.name)], ["studio", "listed", ["build"]]);

  // A device that studio lets copy files only is told why studio is left out, and nothing fails.
  const phone = await pair("phone", "files");
  const refused = await cli(phone, ["sessions"]);
  assert.deepEqual([refused.code, refused.stdout], [0, ""]);
  assert.match(refused.stderr, /^cns: studio: not listed: studio does not let this device list its sessions \(sessions:list\); cns doctor studio checks what it grants now\n$/);
});

test("cns ui moves between sessions with its switch key, starts new ones and detaches leaving them all running", { skip: !posix, timeout: 60000 }, async (t) => {
  const { cli, laptop, sessions, terminal } = await pairedStudio(t);
  assert.equal((await cli(laptop, ["shell", "studio", "--name", "build", "--", "exec bash --noprofile --norc"])).code, 0);
  const ui = terminal(laptop, ["ui"]);
  await ui.waitFor("cns ui · 1 device · 1 session");
  await ui.waitFor("1  build");
  // A digit opens that numbered session.
  ui.write("1");
  await pause(300);
  ui.write("echo from-$((6*7))\r");
  await ui.waitFor("from-42");
  // The switch key brings the switcher back over the session, which keeps running.
  let mark = ui.output.length;
  ui.write("\x1d");
  await ui.waitFor("cns ui · 1 device", mark);
  await ui.waitFor("Esc studio/build", mark);
  // n starts the next shell-N there and opens it.
  ui.write("n");
  await pause(500);
  ui.write("echo in-new-$((1+1))\r");
  await ui.waitFor("in-new-2", mark);
  // Tab goes back to the session before, which redraws as it was.
  mark = ui.output.length;
  ui.write("\x1d");
  await ui.waitFor("Tab studio/build", mark);
  ui.write("\t");
  await ui.waitFor("from-42", mark);
  // d detaches: cns ui ends, and both sessions keep running.
  mark = ui.output.length;
  ui.write("\x1d");
  await ui.waitFor("Esc studio/build", mark);
  ui.write("d");
  await ui.waitFor("left cns ui; every session keeps running", mark);
  assert.equal(await ui.exited, 0);
  assert.deepEqual(await sessions(), ["build", "shell-1"]);
  const listed = await cli(laptop, ["sessions", "studio", "--json"]);
  assert.ok((JSON.parse(listed.stdout) as Array<{ running: boolean }>).every((session) => session.running));
});

test("cns ui opens a session named on the command line, and the switcher's x kills after asking", { skip: !posix, timeout: 60000 }, async (t) => {
  const { cli, laptop, sessions, gone, terminal } = await pairedStudio(t);
  assert.equal((await cli(laptop, ["shell", "studio", "--name", "work", "--", "printf 'work-ready\\n'; exec bash --noprofile --norc"])).code, 0);
  assert.equal((await cli(laptop, ["shell", "studio", "--name", "spare", "--", "sleep 60"])).code, 0);
  const ui = terminal(laptop, ["ui", "studio/work", "--key", "C-b"]);
  await ui.waitFor("work-ready");
  let mark = ui.output.length;
  // With --key C-b, Ctrl-] goes to the session, and Ctrl-B opens the switcher.
  ui.write("\x02");
  await ui.waitFor("Esc studio/work", mark);
  // Numbers come with the listing, which the switcher asks for as it opens.
  await ui.waitFor("2  spare", mark);
  mark = ui.output.length;
  ui.write("2");
  await pause(300);
  ui.write("\x02");
  await ui.waitFor("Esc studio/spare", mark);
  mark = ui.output.length;
  ui.write("x");
  await ui.waitFor("Kill studio/spare?", mark);
  ui.write("y");
  await ui.waitFor("Killed studio/spare.", mark);
  await gone("spare");
  assert.deepEqual(await sessions(), ["work"]);
  ui.write("q");
  assert.equal(await ui.exited, 0);
});

test("cns ui shows sessions side by side: + adds a pane, keys go to the current one, - removes it", { skip: !posix, timeout: 60000 }, async (t) => {
  const { cli, laptop, sessions, terminal } = await pairedStudio(t);
  for (const name of ["left", "right"]) assert.equal((await cli(laptop, ["shell", "studio", "--name", name, "--", "exec bash --noprofile --norc"])).code, 0);
  const screen = async (name: string) => (await cli(laptop, ["screen", "studio", name])).stdout;
  const ui = terminal(laptop, ["ui", "studio/left"]);
  await pause(300);
  ui.write("echo L$((1+1))X\r");
  await ui.waitFor("L2X");
  // In the switcher, select right and add it as a pane: it gets the keys, and left stays beside it.
  let mark = ui.output.length;
  ui.write("\x1d");
  await ui.waitFor("2  right", mark);
  ui.write("j+");
  // A pane's title is drawn in reverse while it has the keys.
  await ui.waitFor("\x1b[7m studio/right", mark);
  await ui.waitFor("L2X", mark);
  ui.write("echo R$((2*3))X\r");
  await ui.waitFor("R6X", mark);
  assert.match(await screen("right"), /R6X/);
  assert.doesNotMatch(await screen("left"), /R6X/);
  // Tab gives the keys back to left, in its pane.
  mark = ui.output.length;
  ui.write("\x1d");
  await ui.waitFor("Tab studio/left", mark);
  ui.write("\t");
  await ui.waitFor("\x1b[7m studio/left", mark);
  ui.write("echo L$((3*3))X\r");
  await ui.waitFor("L9X", mark);
  assert.match(await screen("left"), /L9X/);
  assert.doesNotMatch(await screen("right"), /L9X/);
  // - closes left's pane: right fills the terminal again, and both sessions keep running.
  mark = ui.output.length;
  ui.write("\x1d");
  await ui.waitFor("Esc studio/left", mark);
  ui.write("-");
  await pause(500);
  ui.write("echo only$((4*4))X\r");
  await ui.waitFor("only16X", mark);
  assert.match(await screen("right"), /only16X/);
  mark = ui.output.length;
  ui.write("\x1d");
  await ui.waitFor("Esc studio/right", mark);
  ui.write("d");
  assert.equal(await ui.exited, 0);
  assert.deepEqual(await sessions(), ["left", "right"]);
});

test("cns ui refuses to run without a terminal, and names what to use instead", { skip: !posix, timeout: 60000 }, async (t) => {
  const { cli, laptop } = await pairedStudio(t);
  const result = await cli(laptop, ["ui"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /cns ui needs a terminal\. Without one, cns sessions lists sessions/);
  // What was asked for is checked first, so a mistake there is named rather than the missing terminal.
  assert.match((await cli(laptop, ["ui", "nowhere"])).stderr, /No paired device is saved as nowhere/);
  assert.match((await cli(laptop, ["ui", "studio/bad:name"])).stderr, /Session names have/);
  assert.match((await cli(laptop, ["ui", "studio/a/b"])).stderr, /cns ui takes DEVICE or DEVICE\/SESSION/);
  assert.match((await cli(laptop, ["ui", "--key", "C-c"])).stderr, /--key cannot be Ctrl-C: the session needs it/);
});

test("a terminal's session is removed when its shell exits", { skip: !posix, timeout: 60000 }, async (t) => {
  const { laptop, sessions, gone, terminal } = await pairedStudio(t);
  const shell = terminal(laptop, ["shell", "studio"]);
  const name = await shell.attached();
  assert.deepEqual(await sessions(), [name]);
  shell.write("exit 3\r");
  assert.equal(await shell.exited, 3);
  await gone(name);
});

test("Ctrl-C while a terminal is still attaching stops cns and ends its session", { skip: !posix, timeout: 60000 }, async (t) => {
  const { laptop, gone, terminal } = await pairedStudio(t);
  const shell = terminal(laptop, ["shell", "studio"]);
  // The session has started, and the attachment to it is being made.
  const name = await shell.attached();
  shell.interrupt();
  assert.equal(await shell.exited, 130);
  assert.doesNotMatch(shell.output, /error|PTY session cancelled/);
  await gone(name);
});

test("closing a terminal ends the session it started, as closing an ssh window does", { skip: !posix, timeout: 60000 }, async (t) => {
  const { laptop, sessions, gone, terminal } = await pairedStudio(t);
  const shell = terminal(laptop, ["shell", "studio"]);
  const name = await shell.attached();
  assert.deepEqual(await sessions(), [name]);
  shell.close();
  const code = await shell.exited;
  await gone(name);
  assert.equal(code, 129, "cns exits as a process ended by SIGHUP does");
});

test("Ctrl-] leaves a terminal's session running, says how to return, and --attach NAME rejoins it", { skip: !posix, timeout: 60000 }, async (t) => {
  const { laptop, sessions, terminal } = await pairedStudio(t);
  const shell = terminal(laptop, ["shell", "studio"]);
  const name = await shell.attached();
  shell.write("\x1d");
  assert.equal(await shell.exited, 0);
  assert.deepEqual(await sessions(), [name], "the session keeps running");
  const back = terminal(laptop, ["shell", "studio", "--attach", name]);
  assert.equal(await back.attached(), name);
  back.write("echo back-$((4+4))\r");
  await back.waitFor("back-8");
  back.write("\x1d");
  assert.equal(await back.exited, 0);
  assert.match(shell.output, new RegExp(`detached from ${name}; it keeps running on studio: cns shell studio --attach ${name} returns to it`));
});

// What a full-screen program does with its terminal, as Neovim does it: it asks whether the
// terminal reports its size in-band and then trusts only those reports, moves down a row with
// a line feed alone, and asks for the device attributes as it exits, waiting a second for them.
const FULL_SCREEN_PROGRAM = String.raw`
import { writeFileSync } from "node:fs";
const out = (text) => process.stdout.write(text);
let input = "";
let waiting;
let inband = false;
let quitting = false;
let size = [process.stdout.columns, process.stdout.rows];
const draw = () => out("\x1b[1;1H\x1b[2Ksize " + size[0] + "x" + size[1] + ".\x1b[3;10Hab\ncd");
const answer = (query, pattern, ms) => new Promise((resolve) => {
  const timer = setTimeout(() => { waiting = undefined; resolve(null); }, ms);
  waiting = { pattern, done: (match) => { clearTimeout(timer); waiting = undefined; resolve(match); } };
  out(query);
});
const quit = async () => {
  const asked = Date.now();
  const device = await answer("\x1b[c", /\x1b\[\?[\d;]*c/, 1000);
  writeFileSync(process.argv[2], JSON.stringify({ inband, device: device && device[0].slice(2), waitedMs: Date.now() - asked }));
  out((inband ? "\x1b[?2048l" : "") + "\x1b[?1049l");
  process.exit(0);
};
process.stdin.on("data", (data) => {
  input += data.toString("latin1");
  for (;;) {
    const match = waiting && waiting.pattern.exec(input);
    const report = !match && /\x1b\[48;(\d+);(\d+);\d+;\d+t/.exec(input);
    const found = match || report;
    if (!found) break;
    input = input.slice(0, found.index) + input.slice(found.index + found[0].length);
    if (match) waiting.done(match);
    else if (inband) { size = [Number(report[2]), Number(report[1])]; draw(); }
  }
  if (input.includes("q") && !quitting) { quitting = true; void quit(); }
});
out("\x1b[?1049h\x1b[H\x1b[2J");
const mode = await answer("\x1b[?2048$p", /\x1b\[\?2048;(\d)\$y/, 1000);
if (mode && (mode[1] === "1" || mode[1] === "2")) { inband = true; out("\x1b[?2048h"); }
else process.stdout.on("resize", () => { size = [process.stdout.columns, process.stdout.rows]; draw(); });
draw();
`;

test("a full-screen program draws where it means to, follows the terminal attached and gets its answers from the session", { skip: !posix, timeout: 60000 }, async (t) => {
  const { root, laptop, emulator } = await pairedStudio(t);
  const [program, result] = [path.join(root, "full-screen.mjs"), path.join(root, "result.json")];
  await writeFile(program, FULL_SCREEN_PROGRAM);
  const first = emulator(laptop, ["shell", "studio"], 100, 30);
  const name = await first.attached();
  // The program's own terminal passes its output on unchanged, as a full-screen program sets it.
  first.write(`stty raw -echo; "${process.execPath}" "${program}" "${result}"; stty sane; echo left-$((1+1))\r`);
  // The line feed between ab and cd moves the cursor down, and not to the first column.
  assert.deepEqual((await first.shows("size 100x30.")).slice(2, 4), ["         ab", "           cd"]);

  // The program's switch to the alternate screen reached the terminal, and detaching undoes it.
  assert.equal((await first.state()).screen, "alternate");
  first.write("\x1d");
  assert.equal(await first.exited, 0);
  assert.equal((await first.state()).screen, "normal", "detaching left the terminal on the program's alternate screen");
  assert.ok((await first.drawn()).some((row) => row.includes(`detached from ${name}`)), "the screen from before the program is back, with what cns said");

  // A terminal of another size takes over: the program must learn the new size from the session.
  const second = emulator(laptop, ["shell", "studio", "--attach", name], 80, 20);
  assert.deepEqual((await second.shows("size 80x20.")).slice(2, 4), ["         ab", "           cd"]);
  assert.equal((await second.state()).screen, "alternate", "joining a session on its alternate screen puts the terminal on its own");

  second.write("q");
  await second.waitFor("left-2");
  await pause(300);
  const ended = JSON.parse(await readFile(result, "utf8")) as { inband: boolean; device: string | null; waitedMs: number };
  assert.equal(ended.inband, false, "the program was told a terminal reports its size in-band, and stops following the session's size");
  assert.equal(ended.device, "?1;2c", "the session's screen answers the program's last query");
  assert.ok(ended.waitedMs < 1000, `the program waited ${ended.waitedMs} ms for its answer`);
  // No query reached either terminal, so neither sent a reply that could arrive after the program had gone.
  assert.deepEqual({ first: first.sent, second: second.sent }, { first: [], second: [] });
  assert.doesNotMatch((await second.drawn()).join("\n"), /\d;\d+c/, "a reply was typed into the shell");
  assert.equal((await second.state()).screen, "normal");
});

// What changed: cns shell used to show a session on the terminal's alternate screen, as tmux
// does. That screen keeps no scrollback, and terminals turn the wheel into arrow keys on it,
// so scrolling up went through the shell's history instead.
test("a terminal's session scrolls into the terminal's own scrollback, and leaves its output behind", { skip: !posix, timeout: 60000 }, async (t) => {
  const { laptop, emulator } = await pairedStudio(t);
  const shell = emulator(laptop, ["shell", "studio"], 100, 12);
  const name = await shell.attached();
  await shell.shows("$");
  assert.equal((await shell.state()).screen, "normal");
  // What the terminal showed before the session is kept above it, not cleared with the first redraw.
  const before = await shell.scrollback();
  assert.ok(before.some((row) => row.includes(`connected to studio via a direct link; session ${name}`)), before.join("\n"));
  assert.ok((await shell.drawn()).every((row) => !row.includes("connected to studio")), "the session starts on a screen of its own");

  // Five screens of output: every line is still there to scroll back to, once.
  shell.write("for i in $(seq 1 60); do echo row-$i-; done\r");
  await shell.shows("row-60-");
  const rows = (await shell.scrollback()).filter((row) => /^row-\d+-$/.test(row));
  assert.deepEqual(rows, Array.from({ length: 60 }, (_, index) => `row-${index + 1}-`));
  assert.equal((await shell.state()).screen, "normal");

  // A program that takes the mouse and the alternate screen and is cut off: detaching gives both back.
  shell.write("printf '\\033[?1049h\\033[?1000h\\033[?1006h\\033[?2004h\\033[2;5r\\033[3;1Hfull-screen'; cat\r");
  await shell.shows("full-screen");
  assert.deepEqual(await shell.state().then(({ screen, mouse }) => ({ screen, mouse })), { screen: "alternate", mouse: "vt200" });
  shell.write("\x1d");
  assert.equal(await shell.exited, 0);
  const after = await shell.state();
  assert.deepEqual({ screen: after.screen, mouse: after.mouse, bracketedPaste: after.bracketedPaste }, { screen: "normal", mouse: "none", bracketedPaste: false });
  // The session's output is still on the screen, and what cns says comes after it.
  const left = await shell.drawn();
  const last = left.findIndex((row) => row === "row-60-");
  const said = left.findIndex((row) => row.includes(`detached from ${name}`));
  assert.ok(last >= 0 && said > last, left.join("\n"));
});

test("stopping cns while a full-screen program has the terminal gives the terminal back", { skip: !posix, timeout: 60000 }, async (t) => {
  const { laptop, gone, emulator } = await pairedStudio(t);
  const shell = emulator(laptop, ["shell", "studio"], 100, 12);
  const name = await shell.attached();
  await shell.shows("$");
  shell.write("printf '\\033[?1049h\\033[?1003h\\033[?1006h\\033[?2004h\\033[3;1Hfull-screen'; cat\r");
  await shell.shows("full-screen");
  assert.deepEqual(await shell.state().then(({ screen, mouse }) => ({ screen, mouse })), { screen: "alternate", mouse: "any" });
  shell.terminate();
  assert.equal(await shell.exited, 143);
  const after = await shell.state();
  assert.deepEqual({ screen: after.screen, mouse: after.mouse, bracketedPaste: after.bracketedPaste }, { screen: "normal", mouse: "none", bracketedPaste: false });
  await gone(name);
});

test("CNS_KEY=none, which is for cns shell, leaves cns ui its Ctrl-]", { skip: !posix, timeout: 60000 }, async (t) => {
  const { cli, laptop } = await pairedStudio(t);
  assert.equal((await cli(laptop, ["shell", "studio", "--name", "build", "--", "exec bash --noprofile --norc"])).code, 0);
  const ui = inTerminal(t, ["ui", "studio/build"], { ...laptop.env, CNS_KEY: "none" });
  await pause(500);
  ui.write("echo here-$((2+2))\r");
  await ui.waitFor("here-4");
  const mark = ui.output.length;
  ui.write("\x1d");
  await ui.waitFor("cns ui · 1 device", mark);
  ui.write("q");
  assert.equal(await ui.exited, 0);
  // Asked for by name, a switcher without a key is still refused.
  assert.match((await cli(laptop, ["ui", "--key", "none"])).stderr, /--key takes a control key such as C-\] or C-b/);
});

test("--key names the key that detaches, and none sends every key to the session", { skip: !posix, timeout: 60000 }, async (t) => {
  const { laptop, cli, sessions, terminal } = await pairedStudio(t);
  const shell = terminal(laptop, ["shell", "studio", "--key", "C-b"]);
  await shell.waitFor("Ctrl-B detaches.");
  const name = /session (\S+)\. Ctrl-B detaches/.exec(shell.output)![1]!;
  // Ctrl-] is the session's now: cat -v shows it as it shows any control key.
  shell.write("cat -v\r");
  await pause(300);
  shell.write("\x1d\r");
  await shell.waitFor("^]");
  shell.write("\x02");
  assert.equal(await shell.exited, 0);
  assert.match(shell.output, new RegExp(`detached from ${name}; it keeps running on studio`));
  assert.deepEqual(await sessions(), [name]);

  // CNS_KEY is the same setting; with none, both keys reach the program.
  const all = inTerminal(t, ["shell", "studio", "--attach", name], { ...laptop.env, CNS_KEY: "none" });
  await all.waitFor(`session ${name}.`);
  assert.doesNotMatch(all.output, /detaches/);
  // The redraw shows what the first terminal left: cat -v is still reading.
  await all.waitFor("cat -v");
  const typed = all.output.length;
  all.write("\x1d\x02\r");
  await all.waitFor("^]^B", typed);
  all.write("\x03");
  await pause(300);
  all.write("exit 5\r");
  assert.equal(await all.exited, 5);
  assert.match((await cli(laptop, ["shell", "studio", "--key", "C-c"])).stderr, /--key cannot be Ctrl-C: the session needs it/);
});

// Asks as programs do: the keyboard mode, then device attributes, which every terminal answers.
const ASK_KEYBOARD = `printf '\\033[?u\\033[c'; IFS= read -rs -d c reply; printf 'speaks=%s.\\n' "$(printf %s "$reply" | tr -d '\\033' | tr '[' :)"`;

// What changed: cns shell kept the kitty keyboard protocol from the terminal, so a program on
// the device saw Shift+Enter as Enter. With --kitty-keys the session says its terminal speaks
// the protocol, the terminal is put in the program's mode, and the detach key, which then
// arrives as an escape sequence, still detaches.
test("--kitty-keys gives a session's program the terminal's kitty keyboard protocol, and the detach key keeps detaching", { skip: !posix, timeout: 60000 }, async (t) => {
  const { laptop, sessions, emulator } = await pairedStudio(t);
  const shell = emulator(laptop, ["shell", "studio", "--kitty-keys"], 100, 12, { kitty: true });
  const name = await shell.attached();
  await shell.shows("$");
  // cns asked the terminal once, before attaching; nothing the session asks reaches it.
  assert.deepEqual(shell.sent, ["\x1b[?0u", "\x1b[?1;2c"]);
  shell.write(`${ASK_KEYBOARD}\r`);
  await shell.shows("speaks=:?0u:?1;2.");
  assert.equal(shell.sent.length, 2, "the session's screen answers, not the terminal");
  assert.deepEqual(await shell.keyboard(), [0, 0, 0, 0], "a program that sets no mode leaves the terminal's alone");
  // The program asks for a mode: the terminal has it, in one entry of cns's.
  shell.write("printf '\\033[>5u'; cat -v\r");
  await shell.keyboardIs([5, 1, 0, 0]);
  // Shift+Enter, as the terminal now reports it, reaches the program as its own key.
  shell.write("\x1b[13;2u\r");
  await shell.shows("^[[13;2u");
  // Ctrl-], as the terminal now reports it.
  shell.write("\x1b[93;5u");
  assert.equal(await shell.exited, 0);
  assert.match(shell.output, new RegExp(`detached from ${name}; it keeps running on studio`));
  assert.deepEqual(await shell.keyboard(), [0, 0, 0, 0], "detaching gives the terminal its own keyboard mode back");
  assert.deepEqual(await sessions(), [name]);

  // A terminal that joins later is put in the mode the program set before it came.
  const back = emulator(laptop, ["shell", "studio", "--attach", name, "--kitty-keys"], 100, 12, { kitty: true });
  await back.shows("cat -v");
  await back.keyboardIs([5, 1, 0, 0]);
  // A full-screen program's own mode, on the alternate screen, and the way out of it.
  back.write("\x03");
  await pause(300);
  back.write("printf '\\033[?1049h\\033[>15u\\033[3;1Heditor'; cat -v\r");
  await back.shows("editor");
  await back.keyboardIs([5, 1, 15, 1]);
  // Ctrl-], as a terminal reports it to a program that asked for modifyOtherKeys.
  back.write("\x1b[27;5;93~");
  assert.equal(await back.exited, 0);
  assert.deepEqual(await back.keyboard(), [0, 0, 0, 0]);
  assert.equal((await back.state()).screen, "normal");

  // Without --kitty-keys the same terminal is asked nothing and keeps its mode.
  const plain = emulator(laptop, ["shell", "studio", "--attach", name], 100, 12, { kitty: true });
  await plain.shows("editor");
  assert.deepEqual(plain.sent, []);
  assert.deepEqual(await plain.keyboard(), [0, 0, 0, 0]);
  plain.write("\x1d");
  assert.equal(await plain.exited, 0);
});

test("--kitty-keys at a terminal without the protocol says so and changes nothing", { skip: !posix, timeout: 60000 }, async (t) => {
  const { laptop, emulator } = await pairedStudio(t);
  const shell = emulator(laptop, ["shell", "studio", "--kitty-keys"], 100, 12);
  await shell.attached();
  assert.match(shell.output, /this terminal does not speak the kitty keyboard protocol; --kitty-keys changes nothing here/);
  await shell.shows("$");
  shell.write(`${ASK_KEYBOARD}\r`);
  await shell.shows("speaks=:?1;2.");
  // A program that sets a mode without asking gets nowhere, and Ctrl-] is a byte as ever.
  shell.write("printf '\\033[>5u'; cat -v\r");
  await pause(300);
  assert.deepEqual(await shell.keyboard(), [0, 0, 0, 0]);
  shell.write("\x1d");
  assert.equal(await shell.exited, 0);
});

test("stopping cns while a program has set the terminal's keyboard mode gives the terminal its own mode back", { skip: !posix, timeout: 60000 }, async (t) => {
  const { laptop, gone, emulator } = await pairedStudio(t);
  // CNS_KITTY_KEYS is the same setting as --kitty-keys.
  const keyed = emulator({ env: { ...laptop.env, CNS_KITTY_KEYS: "1" } }, ["shell", "studio"], 100, 12, { kitty: true });
  const name = await keyed.attached();
  await keyed.shows("$");
  keyed.write("printf '\\033[>1u\\033[?1049h\\033[>15u\\033[3;1Hfull-screen'; cat\r");
  await keyed.shows("full-screen");
  await keyed.keyboardIs([1, 1, 15, 1]);
  keyed.terminate();
  assert.equal(await keyed.exited, 143);
  assert.deepEqual(await keyed.keyboard(), [0, 0, 0, 0]);
  assert.equal((await keyed.state()).screen, "normal");
  await gone(name);
});

// cns waits a second for the terminal's answer. One that comes later used to have nowhere to
// go but the session, where the shell read it as typed keys.
test("a terminal that answers too late is treated as one without the protocol, and its answer is not typed into the session", { skip: !posix, timeout: 60000 }, async (t) => {
  const { laptop, emulator } = await pairedStudio(t);
  const shell = emulator(laptop, ["shell", "studio", "--kitty-keys"], 100, 12, { kitty: true, answerAfterMs: 2500 });
  await shell.attached();
  assert.match(shell.output, /this terminal did not say in time whether it speaks the kitty keyboard protocol; --kitty-keys changes nothing here/);
  await shell.shows("$");
  // cat -v shows every byte that reaches the session, the answer included if it did.
  shell.write("cat -v\r");
  await pause(2500);
  assert.deepEqual(shell.sent, ["\x1b[?0u", "\x1b[?1;2c"], "the terminal did answer");
  shell.write("typed\r");
  await shell.shows("typed");
  const rows = (await shell.drawn()).join("\n");
  assert.doesNotMatch(rows, /0u|22c|\^\[/, rows);
  shell.write("\x1d");
  assert.equal(await shell.exited, 0);
});

test("keys typed while cns asks the terminal about its keyboard reach the session", { skip: !posix, timeout: 60000 }, async (t) => {
  const { laptop, emulator } = await pairedStudio(t);
  const shell = emulator(laptop, ["shell", "studio", "--kitty-keys"], 100, 12, { kitty: true });
  // Typed before cns has started, so it is waiting when the terminal's answers arrive.
  shell.write("echo early-$((40+2)); exit 6\r");
  assert.equal(await shell.exited, 6);
  assert.match(shell.output, /early-42/);
});

test("a device that may only watch sessions does not land in another terminal's session", { skip: !posix, timeout: 60000 }, async (t) => {
  const { laptop, pair, terminal } = await pairedStudio(t);
  const viewer = await pair("viewer", "sessions:view");
  const shell = terminal(laptop, ["shell", "studio"]);
  const name = await shell.attached();
  const watching = terminal(viewer, ["shell", "studio"]);
  const outcome = await Promise.race([watching.exited, watching.attached().then((session) => `attached to ${session}`, () => "neither")]);
  assert.notEqual(outcome, `attached to ${name}`, "the viewer joined laptop's terminal");
  // It may not start a session or open a terminal, so it is refused, saying what to grant.
  assert.equal(outcome, 4);
  assert.match(watching.output, /Permission denied: shell not granted/);
});

// What stayed: reconnecting, discarding keys typed blind, grants and replaced sessions.

test("a terminal's session can be attached, captured and typed into from elsewhere while it runs", { skip: !posix, timeout: 60000 }, async (t) => {
  const { cli, laptop, sessions, terminal } = await pairedStudio(t);
  const shell = terminal(laptop, ["shell", "studio"]);
  const name = await shell.attached();
  shell.write("echo marker-$((6*7))\r");
  await shell.waitFor("marker-42");

  // cns screen captures its screen, and cns keys types into it.
  const screen = await cli(laptop, ["screen", "studio", name, "--until", "marker-42"]);
  assert.equal(screen.code, 0, screen.stderr);
  assert.match(screen.stdout, /marker-42/);
  assert.equal((await cli(laptop, ["keys", "studio", name, "echo keys-$((2+2))", "Enter"])).code, 0);
  await shell.waitFor("keys-4");

  // A second terminal joins it with --attach: it is redrawn there, and what it types reaches the first.
  const second = terminal(laptop, ["shell", "studio", "--attach", name]);
  assert.equal(await second.attached(), name);
  await second.waitFor("marker-42");
  const from = shell.output.length;
  second.write("echo second-$((3+3))\r");
  await shell.waitFor("second-6", from);

  // The MCP session tools reach it by its name too.
  const invocation = cliInvocation(["mcp", "studio"]);
  const client = new Client({ name: "cns-tests", version: "1" });
  await client.connect(new StdioClientTransport({ command: invocation.file, args: invocation.args, env: cliEnvironment(laptop.env) as Record<string, string>, stderr: "pipe" }));
  t.after(async () => { await client.close(); });
  const listed = await client.callTool({ name: "list_sessions", arguments: {} }) as CallToolResult;
  assert.deepEqual((listed.structuredContent as { sessions: Array<{ name: string }> }).sessions.map((session) => session.name), [name]);
  const read = await client.callTool({ name: "read_screen", arguments: { name, until: "second-6" } }) as CallToolResult;
  assert.equal(read.isError, undefined, JSON.stringify(read.content));
  assert.match((read.structuredContent as { screen: { text: string } }).screen.text, /second-6/);
  const sent = await client.callTool({ name: "send_keys", arguments: { name, keys: ["echo mcp-$((4+5))", "Enter"], until: "mcp-9" } }) as CallToolResult;
  assert.equal(sent.isError, undefined, JSON.stringify(sent.content));
  await shell.waitFor("mcp-9");

  // The second terminal detaches and leaves the session running for the terminal that started it.
  second.write("\x1d");
  assert.equal(await second.exited, 0);
  assert.deepEqual(await sessions(), [name]);
  const after = shell.output.length;
  shell.write("echo still-$((5+5))\r");
  await shell.waitFor("still-10", after);
});

test("a terminal survives an outage and discards keys typed while disconnected", { skip: !posix, timeout: 60000 }, async (t) => {
  const { root, laptop, throughProxy, emulator } = await pairedStudio(t);
  const proxy = await throughProxy();
  const shell = emulator(laptop, ["shell", "studio"], 100, 30);
  const name = await shell.attached();
  shell.write("echo hi-$((40+2))\r");
  await shell.waitFor("hi-42");
  const blind = path.join(root, "BLIND");
  proxy.refusing = true;
  proxy.cut();
  await shell.waitFor("the connection to studio was lost; reconnecting");
  shell.write(`touch ${blind}\r`);
  await pause(800);
  proxy.refusing = false;
  await shell.waitFor(`reattached to studio/${name} via a direct link`);
  await shell.waitFor("bytes typed while disconnected");
  const from = shell.output.length;
  shell.write("echo after-$((1+1))\r");
  await shell.waitFor("after-2", from);
  assert.equal(existsSync(blind), false, "the blind command never ran");
  // The redrawn screen is the session's alone: what cns said about the outage is above it,
  // in the scrollback, and the next output lands where the session's cursor is.
  const screen = await shell.shows("after-2");
  assert.ok(screen.some((row) => row === "hi-42") && screen.every((row) => !row.includes("[cns:")), screen.join("\n"));
  const kept = (await shell.scrollback()).join("\n");
  assert.match(kept, /the connection to studio was lost; reconnecting[\s\S]*reattached to studio[\s\S]*hi-42[\s\S]*after-2/);
});

test("a device granted only shell gets an unnamed terminal, and a watcher may not type", { skip: !posix, timeout: 60000 }, async (t) => {
  const { laptop, pair, terminal } = await pairedStudio(t);
  const shellOnly = await pair("shellonly", "shell");
  const viewer = await pair("viewer", "sessions:view");
  const plain = terminal(shellOnly, ["shell", "studio"]);
  await plain.waitFor("opening a terminal that ends with the connection");
  plain.write("exit 5\r");
  assert.equal(await plain.exited, 5);

  const shell = terminal(laptop, ["shell", "studio"]);
  const name = await shell.attached();
  const watching = terminal(viewer, ["shell", "studio", "--attach", name]);
  assert.equal(await watching.attached(), name);
  watching.write("x");
  await watching.waitFor(`lets this device watch ${name} but not type into it`);
  watching.write("\x1d");
  assert.equal(await watching.exited, 0);
});

test("a session replaced while disconnected is not silently joined", { skip: !posix, timeout: 60000 }, async (t) => {
  const { cli, laptop, throughProxy, terminal } = await pairedStudio(t);
  const proxy = await throughProxy();
  const shell = terminal(laptop, ["shell", "studio"]);
  const name = await shell.attached();
  proxy.refusing = true;
  proxy.cut();
  await shell.waitFor("reconnecting");
  await proxy.bypass();
  assert.equal((await cli(laptop, ["kill", "studio", name])).code, 0);
  assert.equal((await cli(laptop, ["shell", "studio", "--name", name, "--", "sleep 30"])).code, 0);
  proxy.refusing = false;
  assert.equal(await shell.exited, 1);
  assert.match(shell.output, new RegExp(`${name} on studio ended and was replaced while disconnected`));
});
