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
import { cliEnvironment, cliInvocation, launchCli, unusedPort } from "./test-support.js";

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
 */
function inEmulator(t: TestContext, args: string[], env: Record<string, string>, cols: number, rows: number) {
  const screen = new Screen({ cols, rows, scrollback: 0, allowProposedApi: true });
  t.after(() => screen.dispose());
  /** Everything the emulator sent that nobody typed. */
  const sent: string[] = [];
  let send = (_text: string) => {};
  let recent = "";
  screen.onData((reply) => {
    sent.push(reply);
    send(reply.replace("\x1b[?1;2c", "\x1b[?62;22c").replace("\x1b[?2048;0$y", "\x1b[?2048;2$y"));
  });
  const terminal = inTerminal(t, args, env, { cols, rows, read: (data, write) => {
    send = write;
    screen.write(data);
    recent = (recent + Buffer.from(data).toString("latin1")).slice(-4096);
    if (!recent.includes("\x1b[?2048h")) return;
    recent = "";
    const report = `\x1b[48;${rows};${cols};0;0t`;
    sent.push(report);
    write(report);
  } });
  /** The rows of the emulator's screen, once it has drawn all it received. */
  const drawn = async () => {
    await new Promise<void>((resolve) => screen.write("", resolve));
    return Array.from({ length: rows }, (_, y) => screen.buffer.active.getLine(y)!.translateToString(true));
  };
  return Object.assign(terminal, {
    sent,
    drawn,
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
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "cns-tty-paired-")));
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
  cleanups.push(() => cli(studio, ["stop", "--state", studio.state]));
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
    emulator: (dev: { env: Record<string, string> }, args: string[], cols: number, rows: number) => inEmulator(t, args, dev.env, cols, rows),
  };
}

// What changed: cns tty DEVICE at a terminal used to join the device's session main, so every
// terminal on a device typed into the same shell. Each now starts a session of its own.

test("two terminals running cns tty DEVICE each get a shell of their own", { skip: !posix, timeout: 60000 }, async (t) => {
  const { laptop, sessions, terminal } = await pairedStudio(t);
  const [a, b] = [terminal(laptop, ["tty", "studio"]), terminal(laptop, ["tty", "studio"])];
  const [nameA, nameB] = await Promise.all([a.attached(), b.attached()]);
  assert.notEqual(nameA, nameB, `both terminals attached to the session ${nameA}`);
  assert.deepEqual([nameA, nameB].sort(), ["tty-1", "tty-2"]);
  a.write("echo typed-$((2+3))-in-a\r");
  b.write("echo typed-$((3+4))-in-b\r");
  await Promise.all([a.waitFor("typed-5-in-a"), b.waitFor("typed-7-in-b")]);
  await pause(300);
  assert.doesNotMatch(b.output, /typed-5-in-a/, "terminal b shows what was typed in terminal a");
  assert.doesNotMatch(a.output, /typed-7-in-b/, "terminal a shows what was typed in terminal b");
  assert.deepEqual(await sessions(), ["tty-1", "tty-2"]);
});

test("cns sessions without a device lists every paired device's sessions, and names the ones it may not list", { skip: !posix, timeout: 60000 }, async (t) => {
  const { cli, pair, laptop } = await pairedStudio(t);
  assert.equal((await cli(laptop, ["tty", "studio", "--name", "build", "--", "sleep 60"])).code, 0);
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
  assert.equal((await cli(laptop, ["tty", "studio", "--name", "build", "--", "exec bash --noprofile --norc"])).code, 0);
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
  // n starts the next tty-N there and opens it.
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
  assert.deepEqual(await sessions(), ["build", "tty-1"]);
  const listed = await cli(laptop, ["sessions", "studio", "--json"]);
  assert.ok((JSON.parse(listed.stdout) as Array<{ running: boolean }>).every((session) => session.running));
});

test("cns ui opens a session named on the command line, and the switcher's x kills after asking", { skip: !posix, timeout: 60000 }, async (t) => {
  const { cli, laptop, sessions, gone, terminal } = await pairedStudio(t);
  assert.equal((await cli(laptop, ["tty", "studio", "--name", "work", "--", "printf 'work-ready\\n'; exec bash --noprofile --norc"])).code, 0);
  assert.equal((await cli(laptop, ["tty", "studio", "--name", "spare", "--", "sleep 60"])).code, 0);
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
  for (const name of ["left", "right"]) assert.equal((await cli(laptop, ["tty", "studio", "--name", name, "--", "exec bash --noprofile --norc"])).code, 0);
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
  const shell = terminal(laptop, ["tty", "studio"]);
  const name = await shell.attached();
  assert.deepEqual(await sessions(), [name]);
  shell.write("exit 3\r");
  assert.equal(await shell.exited, 3);
  await gone(name);
});

test("closing a terminal ends the session it started, as closing an ssh window does", { skip: !posix, timeout: 60000 }, async (t) => {
  const { laptop, sessions, gone, terminal } = await pairedStudio(t);
  const shell = terminal(laptop, ["tty", "studio"]);
  const name = await shell.attached();
  assert.deepEqual(await sessions(), [name]);
  shell.close();
  const code = await shell.exited;
  await gone(name);
  assert.equal(code, 129, "cns exits as a process ended by SIGHUP does");
});

test("Ctrl-] leaves a terminal's session running, says how to return, and --attach NAME rejoins it", { skip: !posix, timeout: 60000 }, async (t) => {
  const { laptop, sessions, terminal } = await pairedStudio(t);
  const shell = terminal(laptop, ["tty", "studio"]);
  const name = await shell.attached();
  shell.write("\x1d");
  assert.equal(await shell.exited, 0);
  assert.deepEqual(await sessions(), [name], "the session keeps running");
  const back = terminal(laptop, ["tty", "studio", "--attach", name]);
  assert.equal(await back.attached(), name);
  back.write("echo back-$((4+4))\r");
  await back.waitFor("back-8");
  back.write("\x1d");
  assert.equal(await back.exited, 0);
  assert.match(shell.output, new RegExp(`detached from ${name}; it keeps running on studio: cns tty studio --attach ${name} returns to it`));
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
  const first = emulator(laptop, ["tty", "studio"], 100, 30);
  const name = await first.attached();
  // The program's own terminal passes its output on unchanged, as a full-screen program sets it.
  first.write(`stty raw -echo; "${process.execPath}" "${program}" "${result}"; stty sane; echo left-$((1+1))\r`);
  // The line feed between ab and cd moves the cursor down, and not to the first column.
  assert.deepEqual((await first.shows("size 100x30.")).slice(2, 4), ["         ab", "           cd"]);

  // A terminal of another size takes over: the program must learn the new size from the session.
  first.write("\x1d");
  assert.equal(await first.exited, 0);
  const second = emulator(laptop, ["tty", "studio", "--attach", name], 80, 20);
  assert.deepEqual((await second.shows("size 80x20.")).slice(2, 4), ["         ab", "           cd"]);

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
});

test("a device that may only watch sessions does not land in another terminal's session", { skip: !posix, timeout: 60000 }, async (t) => {
  const { laptop, pair, terminal } = await pairedStudio(t);
  const viewer = await pair("viewer", "sessions:view");
  const shell = terminal(laptop, ["tty", "studio"]);
  const name = await shell.attached();
  const watching = terminal(viewer, ["tty", "studio"]);
  const outcome = await Promise.race([watching.exited, watching.attached().then((session) => `attached to ${session}`, () => "neither")]);
  assert.notEqual(outcome, `attached to ${name}`, "the viewer joined laptop's terminal");
  // It may not start a session or open a terminal, so it is refused, saying what to grant.
  assert.equal(outcome, 4);
  assert.match(watching.output, /Permission denied: shell not granted/);
});

// What stayed: reconnecting, discarding keys typed blind, grants and replaced sessions.

test("a terminal's session can be attached, captured and typed into from elsewhere while it runs", { skip: !posix, timeout: 60000 }, async (t) => {
  const { cli, laptop, sessions, terminal } = await pairedStudio(t);
  const shell = terminal(laptop, ["tty", "studio"]);
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
  const second = terminal(laptop, ["tty", "studio", "--attach", name]);
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
  const { root, laptop, throughProxy, terminal } = await pairedStudio(t);
  const proxy = await throughProxy();
  const shell = terminal(laptop, ["tty", "studio"]);
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
});

test("a device granted only shell gets an unnamed terminal, and a watcher may not type", { skip: !posix, timeout: 60000 }, async (t) => {
  const { laptop, pair, terminal } = await pairedStudio(t);
  const shellOnly = await pair("shellonly", "shell");
  const viewer = await pair("viewer", "sessions:view");
  const plain = terminal(shellOnly, ["tty", "studio"]);
  await plain.waitFor("opening a terminal that ends with the connection");
  plain.write("exit 5\r");
  assert.equal(await plain.exited, 5);

  const shell = terminal(laptop, ["tty", "studio"]);
  const name = await shell.attached();
  const watching = terminal(viewer, ["tty", "studio", "--attach", name]);
  assert.equal(await watching.attached(), name);
  watching.write("x");
  await watching.waitFor(`lets this device watch ${name} but not type into it`);
  watching.write("\x1d");
  assert.equal(await watching.exited, 0);
});

test("a session replaced while disconnected is not silently joined", { skip: !posix, timeout: 60000 }, async (t) => {
  const { cli, laptop, throughProxy, terminal } = await pairedStudio(t);
  const proxy = await throughProxy();
  const shell = terminal(laptop, ["tty", "studio"]);
  const name = await shell.attached();
  proxy.refusing = true;
  proxy.cut();
  await shell.waitFor("reconnecting");
  await proxy.bypass();
  assert.equal((await cli(laptop, ["kill", "studio", name])).code, 0);
  assert.equal((await cli(laptop, ["tty", "studio", "--name", name, "--", "sleep 30"])).code, 0);
  proxy.refusing = false;
  assert.equal(await shell.exited, 1);
  assert.match(shell.output, new RegExp(`${name} on studio ended and was replaced while disconnected`));
});
