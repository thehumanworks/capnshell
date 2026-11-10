import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { cliEnvironment, cliInvocation, launchCli, unusedPort } from "./test-support.js";

const posix = process.platform !== "win32";
const decoder = new TextDecoder();

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
  return {
    write: (text: string) => child.terminal!.write(text),
    /** Close the terminal, as closing its window does: cns gets SIGHUP. */
    close: () => child.terminal!.close(),
    get output() { return output; },
    exited: child.exited,
    waitFor: (needle: string, from = 0) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Waiting for ${JSON.stringify(needle)} in ${JSON.stringify(output.slice(-600))}`)), 15000);
      notify = () => { if (output.indexOf(needle, from) >= 0) { clearTimeout(timer); resolve(); } };
      notify();
    }),
  };
}

test("cns tty DEVICE at a terminal: a session per terminal, outages, blind typing, races and grants", { skip: !posix, timeout: 120000 }, async (t) => {
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
  const shellOnly = await pair("shellonly", "shell");
  const viewer = await pair("viewer", "sessions:view");

  // Laptop reaches studio through a proxy that can cut connections and refuse new ones.
  let refusing = false;
  const sockets: net.Socket[] = [];
  const proxy = net.createServer((client) => {
    if (refusing) { client.destroy(); return; }
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
  const cut = () => { for (const socket of sockets.splice(0)) socket.destroy(); };

  /** The names of studio's sessions now, as laptop lists them. */
  const sessions = async () => {
    const listed = await cli(laptop, ["sessions", "studio", "--json"]);
    assert.equal(listed.code, 0, listed.stderr);
    return (JSON.parse(listed.stdout) as Array<{ name: string }>).map((session) => session.name).sort();
  };
  const gone = async (name: string) => {
    for (let tries = 0; (await sessions()).includes(name); tries++) {
      if (tries > 50) assert.fail(`${name} is still listed on studio`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const named = (output: string) => /as session (tty-\d+)/.exec(output)?.[1];

  // At a terminal, cns tty studio starts a session of its own and attaches it.
  const first = inTerminal(t, ["tty", "studio"], laptop.env);
  await first.waitFor("started a login shell on studio as session tty-1");
  first.write("echo hi-$((40+2))\r");
  await first.waitFor("hi-42");

  // Keys typed while disconnected are discarded, never run on reattach.
  const blind = path.join(root, "BLIND");
  refusing = true;
  cut();
  await first.waitFor("the connection to studio was lost; reconnecting");
  first.write(`touch ${blind}\r`);
  await new Promise((resolve) => setTimeout(resolve, 800));
  refusing = false;
  await first.waitFor("reattached to studio/tty-1 via a direct link");
  await first.waitFor("bytes typed while disconnected");
  const from = first.output.length;
  first.write("echo after-$((1+1))\r");
  await first.waitFor("after-2", from);
  assert.equal(existsSync(blind), false, "the blind command never ran");

  // Ctrl-] detaches, leaves tty-1 running and says how to get back to it.
  first.write("\x1d");
  assert.equal(await first.exited, 0);
  assert.match(first.output, /detached from tty-1; it keeps running on studio: cns tty studio --attach tty-1 returns to it/);
  assert.deepEqual(await sessions(), ["tty-1"]);

  // Two terminals starting at once each get a session of their own; neither sees the other's.
  const [a, b] = [inTerminal(t, ["tty", "studio"], laptop.env), inTerminal(t, ["tty", "studio"], laptop.env)];
  await Promise.all([a.waitFor("Ctrl-] detaches"), b.waitFor("Ctrl-] detaches")]);
  const [nameA, nameB] = [named(a.output)!, named(b.output)!];
  assert.deepEqual([nameA, nameB].sort(), ["tty-2", "tty-3"]);
  a.write("echo only-$((2+3))-in-a\r");
  b.write("echo only-$((3+4))-in-b\r");
  await Promise.all([a.waitFor("only-5-in-a"), b.waitFor("only-7-in-b")]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.doesNotMatch(b.output, /only-5-in-a/);
  assert.doesNotMatch(a.output, /only-7-in-b/);
  assert.deepEqual(await sessions(), ["tty-1", "tty-2", "tty-3"]);

  // A terminal's session ends with its program, and is removed with it.
  a.write("exit 3\r");
  assert.equal(await a.exited, 3);
  await gone(nameA);

  // Closing a terminal ends the session it started, as closing an ssh window does.
  b.close();
  assert.equal(await b.exited, 129);
  await gone(nameB);
  assert.deepEqual(await sessions(), ["tty-1"]);

  // --attach rejoins a session, and the next new terminal takes the first free name.
  const rejoined = inTerminal(t, ["tty", "studio", "--attach", "tty-1"], laptop.env);
  const next = inTerminal(t, ["tty", "studio"], laptop.env);
  await rejoined.waitFor("session tty-1");
  await next.waitFor("started a login shell on studio as session tty-2");
  rejoined.write("echo back-$((4+4))\r");
  await rejoined.waitFor("back-8");
  assert.doesNotMatch(next.output, /back-8/);
  rejoined.write("\x1d");
  next.write("exit\r");
  assert.deepEqual([await rejoined.exited, await next.exited], [0, 0]);
  await gone("tty-2");

  // A device granted only shell gets a terminal of its own that ends with the connection.
  const plain = inTerminal(t, ["tty", "studio"], shellOnly.env);
  await plain.waitFor("does not let this device start sessions; opening a terminal");
  plain.write("exit 5\r");
  assert.equal(await plain.exited, 5);

  // A device that may only watch is told so when it types.
  const watching = inTerminal(t, ["tty", "studio", "--attach", "tty-1"], viewer.env);
  await watching.waitFor("session tty-1");
  watching.write("x");
  await watching.waitFor("lets this device watch tty-1 but not type into it");
  watching.write("\x1d");
  assert.equal(await watching.exited, 0);

  // A session replaced while disconnected is not silently joined.
  const again = inTerminal(t, ["tty", "studio"], laptop.env);
  await again.waitFor("Ctrl-] detaches");
  const replaced = named(again.output)!;
  refusing = true;
  cut();
  await again.waitFor("reconnecting");
  await writeFile(file, JSON.stringify(record), { mode: 0o600 });
  assert.equal((await cli(laptop, ["kill", "studio", replaced])).code, 0);
  assert.equal((await cli(laptop, ["tty", "studio", "--name", replaced, "--", "sleep 30"])).code, 0);
  refusing = false;
  assert.equal(await again.exited, 1);
  assert.match(again.output, new RegExp(`${replaced} on studio ended and was replaced while disconnected; cns tty studio opens a new terminal`));
});
