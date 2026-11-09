import assert from "node:assert/strict";
import { spyOn } from "bun:test";
import bun from "bun";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { spawn } from "node:child_process";
import { RpcTarget } from "capnweb";
import { ShellApi, type ExecSink, type PtyExit } from "../shell.js";
import { cliInvocation, launchCli as launch, LOOPBACK, settledLink, testDevices } from "../test-support.js";
import { plain } from "../terminal.js";
import type { PeerController } from "../console.js";
import { connectControl, removeStaleState, startDaemon, stateSchema } from "./daemon.js";
import { serveControl } from "./daemon-server.js";

async function temporaryState(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cns-daemon-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  return path.join(directory, "daemon.json");
}

/** Passed by reference, so a peer's PTY output travels back through the daemon. */
class CollectingSink extends RpcTarget {
  text = "";
  #finish!: (result: PtyExit) => void;
  exited = new Promise<PtyExit>((resolve) => { this.#finish = resolve; });
  output(data: Uint8Array) { this.text += new TextDecoder().decode(data); }
  exit(result: PtyExit) { this.#finish(result); }
}

/** Records a command's output as exec streams it through the daemon. */
class CollectingExecSink extends RpcTarget implements ExecSink {
  text = "";
  #waiters: { needle: string; resolve(): void }[] = [];
  output(_stream: "stdout" | "stderr", data: Uint8Array) {
    this.text += new TextDecoder().decode(data);
    this.#waiters = this.#waiters.filter((waiter) => {
      if (!this.text.includes(waiter.needle)) return true;
      waiter.resolve();
      return false;
    });
  }
  waitFor(needle: string) {
    if (this.text.includes(needle)) return Promise.resolve();
    return new Promise<void>((resolve) => { this.#waiters.push({ needle, resolve }); });
  }
}

function alive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function unusedPort(): Promise<string> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return String(address.port);
}

const emptyController: PeerController = {
  async peers() { return []; },
  async info() { throw new Error("unused"); },
  async run() { throw new Error("unused"); },
  async openPty() { throw new Error("unused"); },
  async ptySessions() { throw new Error("unused"); },
  async startPtySession() { throw new Error("unused"); },
  async ptySession() { throw new Error("unused"); },
  async shell() { throw new Error("unused"); },
};

test("daemon state accepts legacy IPv4 and explicit loopback only", () => {
  const legacy = { version: 1, pid: process.pid, port: 12345, token: "a".repeat(64) };
  assert.deepEqual(stateSchema.parse(legacy), legacy);
  for (const host of ["::1", "127.0.0.1"]) {
    const state = { ...legacy, version: 2, host };
    assert.deepEqual(stateSchema.parse(state), state);
  }
  for (const host of [undefined, "localhost", "0.0.0.0", "::", "[::1]", "192.0.2.1", "example.invalid", "::ffff:127.0.0.1"]) {
    assert.equal(stateSchema.safeParse({ ...legacy, version: 2, host }).success, false, String(host));
  }
  assert.equal(stateSchema.safeParse({ ...legacy, host: "::1" }).success, false);
  assert.equal(stateSchema.safeParse({ ...legacy, version: 3 }).success, false);
});

for (const code of ["EAFNOSUPPORT", "EPROTONOSUPPORT", "EADDRNOTAVAIL"]) {
  test(`daemon control falls back to IPv4 on ${code} and reads legacy state`, async (t) => {
    const statePath = await temporaryState(t);
    const originalServe = bun.serve;
    const hosts: unknown[] = [];
    const spy = spyOn(bun, "serve").mockImplementation(((options: Parameters<typeof bun.serve>[0]) => {
      hosts.push(options.hostname);
      if (options.hostname === "::1") throw Object.assign(new Error("IPv6 unavailable"), { code });
      return originalServe(options);
    }) as typeof bun.serve);
    try {
      const cleanup = await serveControl(emptyController, () => {}, statePath);
      t.after(cleanup);
    } finally { spy.mockRestore(); }
    assert.deepEqual(hosts, ["::1", "127.0.0.1"]);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual([state.version, state.host], [2, "127.0.0.1"]);
    const current = await connectControl(statePath);
    try { assert.equal((await plain(current.remote.status())).pid, process.pid); }
    finally { current.close(); }
    // Pre-upgrade state has no host; it must still select IPv4, not the new default.
    const { host: _host, ...legacy } = state;
    await writeFile(statePath, JSON.stringify({ ...legacy, version: 1 }));
    const old = await connectControl(statePath);
    try { assert.equal((await plain(old.remote.status())).pid, process.pid); }
    finally { old.close(); }
  });
}

test("daemon control does not hide unrelated bind failures or write state", async (t) => {
  const statePath = await temporaryState(t);
  const failure = Object.assign(new Error("Too many files"), { code: "EMFILE" });
  const spy = spyOn(bun, "serve").mockImplementation(() => { throw failure; });
  try {
    await assert.rejects(() => serveControl(emptyController, () => {}, statePath), (error) => error === failure);
    assert.equal(spy.mock.calls.length, 1);
    await assert.rejects(() => stat(statePath), { code: "ENOENT" });
  } finally { spy.mockRestore(); }
});

test("daemon control rejects unsafe and malformed state files", async (t) => {
  const statePath = await temporaryState(t);
  const state = JSON.stringify({ version: 1, pid: process.pid, port: 12345, token: "a".repeat(64) });
  await mkdir(statePath);
  await assert.rejects(() => connectControl(statePath), /private file/);
  await rm(statePath, { recursive: true });
  await writeFile(statePath, "not JSON", { mode: 0o600 });
  await assert.rejects(() => connectControl(statePath));
  await writeFile(statePath, state);
  if (process.platform !== "win32") {
    await chmod(statePath, 0o644);
    await assert.rejects(() => connectControl(statePath), /private file/);
    await chmod(statePath, 0o600);
    const link = `${statePath}.link`;
    await symlink(statePath, link);
    await assert.rejects(() => connectControl(link), /private file/);
  }
});

test("daemon state is validated and read from the same opened file", { skip: process.platform === "win32" }, async (t) => {
  const statePath = await temporaryState(t);
  const replacement = `${statePath}.replacement`;
  await writeFile(statePath, "not JSON", { mode: 0o600 });
  await writeFile(replacement, JSON.stringify({ version: 1, pid: process.pid, port: 12345, token: "a".repeat(64) }), { mode: 0o600 });
  const originalOpen = fs.open;
  let replaced = false;
  const spy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (args[0] === statePath) {
      await rename(replacement, statePath);
      replaced = true;
    }
    return handle;
  });
  try {
    await assert.rejects(() => connectControl(statePath), SyntaxError);
    assert.equal(replaced, true);
  } finally { spy.mockRestore(); }
});

test("daemon state refuses a symlink substituted after its initial check", { skip: process.platform === "win32" }, async (t) => {
  const statePath = await temporaryState(t);
  const replacement = `${statePath}.replacement`;
  await writeFile(statePath, "{}", { mode: 0o600 });
  await writeFile(replacement, "{}", { mode: 0o600 });
  const originalLstat = fs.lstat;
  let replaced = false;
  const spy = spyOn(fs, "lstat").mockImplementation((async (...args: Parameters<typeof fs.lstat>) => {
    const result = await originalLstat(...args);
    if (args[0] === statePath) {
      await rm(statePath);
      await symlink(replacement, statePath);
      replaced = true;
    }
    return result;
  }) as typeof fs.lstat);
  try {
    await assert.rejects(() => connectControl(statePath), { code: "ELOOP" });
    assert.equal(replaced, true);
  } finally { spy.mockRestore(); }
});

test("local control authenticates before upgrade and exclusively owns private state", async (t) => {
  const statePath = await temporaryState(t);
  const shell = new ShellApi();
  t.after(() => shell[Symbol.dispose]());
  const controller = {
    async peers() { return [{ id: "p1", info: shell.info() }]; },
    async info(id: string) { assert.equal(id, "p1"); return shell.info(); },
    async run(id: string, command: string) { assert.equal(id, "p1"); return shell.run(command); },
    async openPty() { throw new Error("unused"); },
    async ptySessions() { throw new Error("unused"); },
    async startPtySession() { throw new Error("unused"); },
    async ptySession() { throw new Error("unused"); },
    async shell() { throw new Error("unused"); },
  };
  const cleanup = await serveControl(controller, () => {}, statePath, { url: "ws://127.0.0.1:47381", bind: "127.0.0.1", port: 47381, remote: false });
  t.after(cleanup);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (process.platform !== "win32") assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  assert.deepEqual([state.version, state.host], [2, LOOPBACK]);
  const url = `http://${state.host === "::1" ? "[::1]" : state.host}:${state.port}`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: "Bearer bad-token" } })).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${state.token}`, Origin: "https://example.invalid" } })).status, 401);
  assert.equal((await fetch(url, { headers: { Authorization: `Bearer ${state.token}` } })).status, 400);
  await assert.rejects(() => serveControl(controller, () => {}, statePath), /Another daemon/);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).token, state.token);
  const connection = await connectControl(statePath);
  try {
    assert.equal((await connection.controller.peers())[0]?.info.pid, process.pid);
    assert.equal((await connection.controller.info("p1")).pid, process.pid);
  } finally { connection.close(); }
  await cleanup();
  await assert.rejects(() => stat(statePath), { code: "ENOENT" });
});

test("control cleanup never removes another daemon's state", async (t) => {
  const statePath = await temporaryState(t);
  const shell = new ShellApi();
  const cleanup = await serveControl({
    async peers() { return []; },
    async info() { return shell.info(); },
    async run() { throw new Error("unused"); },
    async openPty() { throw new Error("unused"); },
    async ptySessions() { throw new Error("unused"); },
    async startPtySession() { throw new Error("unused"); },
    async ptySession() { throw new Error("unused"); },
    async shell() { throw new Error("unused"); },
  }, () => {}, statePath);
  const replacement = { ...JSON.parse(await readFile(statePath, "utf8")), token: "f".repeat(64) };
  await writeFile(statePath, JSON.stringify(replacement));
  await cleanup();
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).token, replacement.token);
});

test("cns up, status, attach and stop use local control independently of the peer bind", async (t) => {
  const devices = await testDevices(t);
  const studio = await devices.device("studio");
  await devices.up(studio); // The peer listener remains on IPv4 even when control uses IPv6.
  const state = JSON.parse(await readFile(studio.state, "utf8"));
  assert.deepEqual([state.version, state.host], [2, LOOPBACK]);
  const again = await devices.cli(studio, ["up", "--state", studio.state]);
  assert.equal(again.code, 0, again.output);
  assert.match(again.stdout, /Running as/);
  assert.equal(JSON.parse(await readFile(studio.state, "utf8")).pid, state.pid);
  const status = await devices.cli(studio, ["status", "--json", "--state", studio.state]);
  assert.equal(status.code, 0, status.output);
  assert.match(status.stdout, new RegExp(`"pid":\\s*${state.pid}`));
  const attached = await devices.cli(studio, ["attach", "--state", studio.state], ":peers\n:quit\n");
  assert.equal(attached.code, 0, attached.output);
  const stopped = await devices.cli(studio, ["stop", "--state", studio.state]);
  assert.equal(stopped.code, 0, stopped.output);
  await assert.rejects(() => stat(studio.state), { code: "ENOENT" });
});

test("the daemon starts, proxies a linked device to attached consoles, survives detach, rejects a duplicate start and stops", { skip: process.platform === "win32", timeout: 60000 }, async (t) => {
  const devices = await testDevices(t);
  const studio = await devices.device("studio");
  const laptop = await devices.device("laptop");
  const port = await devices.up(studio);
  await devices.up(laptop);
  // Laptop lets studio use all of it; studio's console and control clients then reach laptop over the daemons' link.
  await devices.pair(studio, laptop, { hostGrants: "all", guestGrants: "all" });
  const url = `ws://127.0.0.1:${port}`;
  const statePath = studio.state;
  const state = JSON.parse(await readFile(statePath, "utf8"));
  // A second start with the same state file fails and leaves the running daemon's state alone.
  const spare = Number(await unusedPort());
  await assert.rejects(() => startDaemon({ bind: "127.0.0.1", port: spare, url, state: statePath }, { invocation: cliInvocation }), /already exists/);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).token, state.token);
  const connection = await connectControl(statePath);
  t.after(() => connection.close());
  const id = await settledLink(connection, "laptop");
  const laptopPid = JSON.parse(await readFile(laptop.state, "utf8")).pid;

  const attachment = launch(t, ["attach", "--state", statePath], { env: studio.env });
  await attachment.waitFor("Type a shell command");
  await attachment.send(":peers", "laptop (paired");
  await attachment.send(`:use ${id}`, id);
  await attachment.send(":info", `"pid": ${laptopPid}`);
  const command = "printf ATTACHED_RUN";
  await attachment.send(command, "ATTACHED_RUN");
  await attachment.waitFor("[exit=0;");
  await attachment.send(":tty", ":tty and :attach require an interactive local terminal");
  attachment.child.stdin.write(":quit\n");
  assert.equal(await attachment.exited, 0, attachment.output);
  // EOF may arrive before asynchronous RPCs finish. Drain queued commands without
  // trying to redraw a readline interface that has already closed.
  const piped = launch(t, ["attach", "--state", statePath], { env: studio.env });
  piped.child.stdin.end(`:peers\n:use ${id}\n:info\n${command}\n:sessions\n:quit\n`);
  assert.equal(await piped.exited, 0, piped.output);
  assert.match(piped.stdout, /ATTACHED_RUN/);
  assert.match(piped.stdout, /No named PTY sessions\./);
  assert.equal(piped.stderr, "");

  assert.equal((await connection.controller.peers()).length, 1);
  // status() tells a client that found the state file what the daemon listens on.
  const status = await plain(connection.remote.status());
  assert.equal(status.pid, state.pid);
  assert.deepEqual([status.url, status.bind, status.remote, status.peers], [url, "127.0.0.1", false, 1]);
  assert.ok(status.startedAt <= Date.now());
  // shell(id) forks the device's whole ShellApi through the daemon: commands and files alike.
  const shell = await connection.controller.shell(id);
  try {
    const forked = await plain(shell.run("printf SHELL_VIA_DAEMON"));
    assert.equal(forked.stdout, "SHELL_VIA_DAEMON");
    const file = path.join(laptop.dir, "via-daemon.txt");
    await shell.writeFile(file, new TextEncoder().encode("files via daemon"));
    const chunk = await plain(shell.readFile(file));
    assert.equal(new TextDecoder().decode(chunk.data), "files via daemon");
    assert.equal((await plain(shell.stat(file))).kind, "file");
    assert.ok((await plain(shell.readdir(laptop.dir))).some((entry) => entry.name === "via-daemon.txt"));
  } finally { shell[Symbol.dispose](); }
  // exec streams through the daemon, and releasing the fork kills the command.
  const streaming = await connection.controller.shell(id);
  const streamed = new CollectingExecSink();
  const execution = streaming.exec(streamed, "printf 'pid=%s;' \"$$\"; printf STREAMED; exec sleep 30");
  await streamed.waitFor("STREAMED");
  const pid = Number(/pid=(\d+);/.exec(streamed.text)?.[1]);
  assert.ok(alive(pid));
  streaming[Symbol.dispose]();
  // The killed command reports its signal, unless the released fork rejects the call first.
  const outcome = await Promise.resolve(execution).then((result) => result, (error: unknown) => error);
  if (!(outcome instanceof Error)) assert.notEqual((outcome as { signal: unknown }).signal, null);
  const killed = Date.now() + 5000;
  while (alive(pid) && Date.now() < killed) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(alive(pid), false, "releasing the fork must kill the command");
  const finished = await connection.controller.shell(id);
  try {
    const done = new CollectingExecSink();
    const result = await plain(finished.exec(done, "printf one; printf two >&2; exit 6"));
    assert.deepEqual([done.text, result.exitCode], ["onetwo", 6]);
  } finally { finished[Symbol.dispose](); }
  // The attached client's sink and the device's session are both proxied by the daemon.
  const sink = new CollectingSink();
  const pty = await connection.controller.openPty(id, sink, { command: "read -r line; printf 'VIA_DAEMON:%s' \"$line\"; exit 3" });
  // The terminal buffers input until the program reads it.
  await pty.write(new TextEncoder().encode("ok\r"));
  const result = await sink.exited;
  assert.match(sink.text, /VIA_DAEMON:ok/);
  assert.equal(result.exitCode, 3);
  const screen = await pty.capture();
  pty[Symbol.dispose]();
  assert.match(screen.text, /^ok\nVIA_DAEMON:ok/);

  // Named sessions and their handles are proxied too.
  const info = await connection.controller.startPtySession(id, "via", { command: "printf 'NAMED_VIA_DAEMON'; read -r _; exit 4" });
  assert.deepEqual([info.name, info.running], ["via", true]);
  assert.equal((await connection.controller.ptySessions(id))[0]?.name, "via");
  const session = await connection.controller.ptySession(id, "via");
  assert.equal((await plain(session.wait({ text: "NAMED_VIA_DAEMON", timeoutMs: 10000 }))).matched, true);
  const viewer = new CollectingSink();
  const viewing = await session.attach(viewer);
  await session.keys(["Enter"]);
  assert.equal((await viewer.exited).exitCode, 4);
  assert.match(viewer.text, /NAMED_VIA_DAEMON/);
  viewing[Symbol.dispose]();
  assert.equal((await plain(session.kill())).exitCode, 4);
  session[Symbol.dispose]();
  assert.deepEqual(await connection.controller.ptySessions(id), []);

  const stopped = await devices.cli(studio, ["stop", "--state", statePath]);
  assert.equal(stopped.code, 0, stopped.output);
  assert.match(stopped.stdout, /Daemon stopped/);
  await assert.rejects(() => stat(statePath), { code: "ENOENT" });
});

test("stale state is removed only once its daemon's process is gone", { skip: process.platform === "win32", timeout: 15000 }, async (t) => {
  const statePath = await temporaryState(t);
  // A process that has exited, and a port nothing answers on.
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  const port = Number(await unusedPort());
  const write = (pid: number) => writeFile(statePath, JSON.stringify({ version: 1, pid, port, token: "a".repeat(64) }), { mode: 0o600 });
  assert.equal(await removeStaleState(statePath), false, "no state file");
  await write(process.pid);
  assert.equal(await removeStaleState(statePath), false, "the recorded process still runs");
  assert.ok(await stat(statePath));
  await writeFile(statePath, "{", { mode: 0o600 });
  assert.equal(await removeStaleState(statePath), false, "a file being written is left alone");
  await write(child.pid!);
  assert.equal(await removeStaleState(statePath), true);
  await assert.rejects(() => stat(statePath), { code: "ENOENT" });

  // cns up recovers from a crashed daemon's state by itself.
  const devices = await testDevices(t);
  const studio = await devices.device("studio");
  await writeFile(studio.state, JSON.stringify({ version: 1, pid: child.pid!, port, token: "a".repeat(64) }), { mode: 0o600 });
  await devices.up(studio);
  const connection = await connectControl(studio.state);
  try {
    const status = await plain(connection.remote.status());
    assert.equal(status.port, Number(studio.port));
    await connection.remote.stop();
  } finally { connection.close(); }
});

test("daemon startup reports a listener failure and leaves no state", { skip: process.platform === "win32", timeout: 15000 }, async (t) => {
  const devices = await testDevices(t);
  const studio = await devices.device("studio");
  const occupied = net.createServer();
  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
  const address = occupied.address();
  assert.ok(address && typeof address !== "string");
  const started = await devices.cli(studio, ["up", "--bind", "127.0.0.1", "--port", String(address.port), "--state", studio.state]);
  assert.equal(started.code, 1, started.output);
  assert.match(started.output, /exited during startup/);
  await assert.rejects(() => stat(studio.state), { code: "ENOENT" });
});

test("concurrent daemon starts cannot replace the winner's state", { skip: process.platform === "win32", timeout: 20000 }, async (t) => {
  const devices = await testDevices(t);
  const studio = await devices.device("studio");
  const ports = await Promise.all([unusedPort(), unusedPort()]);
  const results = await Promise.all(ports.map((port) => devices.cli(studio, ["up", "--bind", "127.0.0.1", "--port", port, "--state", studio.state])));
  const connection = await connectControl(studio.state);
  t.after(async () => {
    try { await connection.remote.stop(); } catch { /* Already stopped. */ }
    finally { connection.close(); }
  });
  // One start wins; the other fails or finds the winner running. Either way one daemon runs, on one of the two ports.
  assert.ok(results.some((result) => result.code === 0), results.map((result) => result.output).join("\n"));
  const status = await plain(connection.remote.status());
  assert.ok(ports.includes(String(status.port)));
  const other = ports.find((port) => port !== String(status.port))!;
  const probe = net.connect(Number(other), "127.0.0.1");
  const event = await new Promise<string>((resolve) => { probe.once("connect", () => resolve("connect")); probe.once("error", () => resolve("error")); });
  probe.destroy();
  assert.equal(event, "error", "the losing daemon does not keep running");
  assert.deepEqual(await connection.controller.peers(), []);
});
