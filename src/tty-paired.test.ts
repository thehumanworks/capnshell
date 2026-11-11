import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Client, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { cliEnvironment, cliInvocation, launchCli, unusedPort } from "./test-support.js";

const posix = process.platform !== "win32";
const decoder = new TextDecoder();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run cns on a pseudo-terminal, as a person at a terminal would. */
function inTerminal(t: TestContext, args: string[], env: Record<string, string>) {
  const invocation = cliInvocation(args);
  let output = "";
  let notify = () => {};
  const child = Bun.spawn([invocation.file, ...invocation.args], {
    env: cliEnvironment(env) as Record<string, string>,
    terminal: { cols: 100, rows: 30, name: "xterm-256color", data: (_terminal, data) => { output += decoder.decode(data, { stream: true }); notify(); } },
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

  return { root, cli, pair, laptop, sessions, gone, throughProxy, terminal: (dev: { env: Record<string, string> }, args: string[]) => inTerminal(t, args, dev.env) };
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
