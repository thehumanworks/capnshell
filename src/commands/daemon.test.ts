import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { RpcTarget } from "capnweb";
import { ShellApi, type PtyExit } from "../shell.js";
import { launchCli as launch } from "../test-support.js";
import { plain } from "../terminal.js";
import { connectControl, serveControl } from "./daemon.js";

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

async function unusedPort(): Promise<string> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return String(address.port);
}

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
  };
  const cleanup = await serveControl(controller, () => {}, statePath);
  t.after(cleanup);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  if (process.platform !== "win32") assert.equal((await stat(statePath)).mode & 0o777, 0o600);
  const url = `http://127.0.0.1:${state.port}`;
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
  }, () => {}, statePath);
  const replacement = { ...JSON.parse(await readFile(statePath, "utf8")), token: "f".repeat(64) };
  await writeFile(statePath, JSON.stringify(replacement));
  await cleanup();
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).token, replacement.token);
});

test("daemon starts, attaches bidirectionally, survives detach, rejects duplicate start and stops", { timeout: 30000 }, async (t) => {
  const statePath = await temporaryState(t);
  const port = await unusedPort();
  const url = `ws://127.0.0.1:${port}`;
  const started = launch(t, ["listen", "--daemon", "--state", statePath], {
    env: { CNS_BIND: "127.0.0.1", CNS_PORT: port },
  });
  assert.equal(await started.exited, 0, started.output);
  assert.match(started.output, /Daemon listening/);
  // Keep the authenticated connection usable even if another cleanup removes the file.
  const cleanupConnection = await connectControl(statePath);
  t.after(async () => {
    try { await cleanupConnection.remote.stop(); } catch { /* Already stopped. */ }
    finally { cleanupConnection.close(); }
  });
  const state = JSON.parse(await readFile(statePath, "utf8"));
  const duplicate = launch(t, ["listen", "--daemon", "--state", statePath, "--port", await unusedPort()]);
  assert.equal(await duplicate.exited, 1, duplicate.output);
  assert.match(duplicate.output, /already exists/);
  assert.equal(JSON.parse(await readFile(statePath, "utf8")).token, state.token);
  const peer = launch(t, ["connect", url]);
  await peer.waitFor("Connected to");
  const attachment = launch(t, ["attach", "--state", statePath]);
  await attachment.waitFor("Type a shell command");
  await attachment.send(":peers", "p1");
  await attachment.send(":info", `"pid": ${peer.child.pid}`);
  await peer.send(":info", `"pid": ${state.pid}`);
  const command = process.platform === "win32" ? "[Console]::Write('ATTACHED_RUN')" : "printf ATTACHED_RUN";
  await attachment.send(command, "ATTACHED_RUN");
  await attachment.waitFor("[exit=0;");
  await attachment.send(":tty", ":tty and :attach require an interactive local terminal");
  attachment.child.stdin.write(":quit\n");
  assert.equal(await attachment.exited, 0, attachment.output);
  // EOF may arrive before asynchronous RPCs finish. Drain queued commands without
  // trying to redraw a readline interface that has already closed.
  const piped = launch(t, ["attach", "--state", statePath]);
  piped.child.stdin.end(`:peers\n:use p1\n:info\n${command}\n:sessions\n:quit\n`);
  assert.equal(await piped.exited, 0, piped.output);
  assert.match(piped.stdout, /ATTACHED_RUN/);
  assert.match(piped.stdout, /No named PTY sessions\./);
  assert.equal(piped.stderr, "");
  await peer.send(":info", `"pid": ${state.pid}`);
  const connection = await connectControl(statePath);
  try {
    assert.equal((await connection.controller.peers()).length, 1);
    if (process.platform !== "win32") {
      // The attached client's sink and the peer's session are both proxied by the daemon.
      const sink = new CollectingSink();
      const pty = await connection.controller.openPty("p1", sink, { command: "read -r line; printf 'VIA_DAEMON:%s' \"$line\"; exit 3" });
      // The terminal buffers input until the program reads it.
      await pty.write(new TextEncoder().encode("ok\r"));
      const result = await sink.exited;
      assert.match(sink.text, /VIA_DAEMON:ok/);
      assert.equal(result.exitCode, 3);
      const screen = await pty.capture();
      pty[Symbol.dispose]();
      assert.match(screen.text, /^ok\nVIA_DAEMON:ok/);

      // Named sessions and their handles are proxied too.
      const info = await connection.controller.startPtySession("p1", "via", { command: "printf 'NAMED_VIA_DAEMON'; read -r _; exit 4" });
      assert.deepEqual([info.name, info.running], ["via", true]);
      assert.equal((await connection.controller.ptySessions("p1"))[0]?.name, "via");
      const session = await connection.controller.ptySession("p1", "via");
      assert.equal((await plain(session.wait({ text: "NAMED_VIA_DAEMON", timeoutMs: 10000 }))).matched, true);
      const viewer = new CollectingSink();
      const attachment = await session.attach(viewer);
      await session.keys(["Enter"]);
      assert.equal((await viewer.exited).exitCode, 4);
      assert.match(viewer.text, /NAMED_VIA_DAEMON/);
      attachment[Symbol.dispose]();
      assert.equal((await plain(session.kill())).exitCode, 4);
      session[Symbol.dispose]();
      assert.deepEqual(await connection.controller.ptySessions("p1"), []);
    }
  } finally { connection.close(); }
  const stopped = launch(t, ["stop", "--state", statePath]);
  assert.equal(await stopped.exited, 0, stopped.output);
  assert.match(stopped.output, /Daemon stopped/);
  await assert.rejects(() => stat(statePath), { code: "ENOENT" });
  assert.equal(await peer.exited, 0, peer.output);
});


test("daemon startup reports a listener failure and leaves no state", { timeout: 15000 }, async (t) => {
  const statePath = await temporaryState(t);
  const occupied = net.createServer();
  occupied.listen(0, "127.0.0.1");
  await once(occupied, "listening");
  t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
  const address = occupied.address();
  assert.ok(address && typeof address !== "string");
  const started = launch(t, ["listen", "--daemon", "--state", statePath, "--port", String(address.port)]);
  assert.equal(await started.exited, 1, started.output);
  assert.match(started.output, /exited during startup/);
  await assert.rejects(() => stat(statePath), { code: "ENOENT" });
});

test("concurrent daemon starts cannot replace the winner's state", { timeout: 15000 }, async (t) => {
  const statePath = await temporaryState(t);
  const ports = await Promise.all([unusedPort(), unusedPort()]);
  const children = ports.map((port) => launch(t, ["listen", "--daemon", "--state", statePath, "--port", port]));
  const codes = await Promise.all(children.map((child) => child.exited));
  const connection = await connectControl(statePath);
  t.after(async () => {
    try { await connection.remote.stop(); } catch { /* Already stopped. */ }
    finally { connection.close(); }
  });
  assert.deepEqual(codes.sort(), [0, 1], children.map((child) => child.output).join("\n"));
  assert.deepEqual(await connection.controller.peers(), []);
  const stopped = launch(t, ["stop", "--state", statePath]);
  assert.equal(await stopped.exited, 0, stopped.output);
  await assert.rejects(() => stat(statePath), { code: "ENOENT" });
});
