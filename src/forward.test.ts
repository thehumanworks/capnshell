import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import test, { type TestContext } from "node:test";
import { MessageChannel } from "node:worker_threads";
import { newMessagePortRpcSession, RpcTarget, type RpcStub } from "capnweb";
import type { AuditEntry } from "./audit.js";
import { Final, openForward } from "./commands/forward.js";
import { carry, CONNECTION_WINDOW, Flow, FORWARD_CHUNK_BYTES, FORWARD_WINDOW, MAX_FORWARD_CONNECTIONS, MAX_FORWARDS, PortForward, type ForwardSink, type Tunnel } from "./forward.js";
import { GrantedShell } from "./granted-shell.js";
import { explainDenial, expandGrants } from "./peers.js";
import { ShellApi } from "./shell.js";

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const until = async (check: () => boolean, label: string, ms = 5000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** A TCP server on 127.0.0.1 that hands each connection to `handle`; closed after the test. */
async function server(t: TestContext, handle: (socket: net.Socket) => void, host = "127.0.0.1"): Promise<number> {
  const sockets = new Set<net.Socket>();
  const listener = net.createServer({ allowHalfOpen: true }, (socket) => { sockets.add(socket); socket.on("error", () => {}); handle(socket); });
  listener.listen(0, host);
  await once(listener, "listening");
  t.after(() => { for (const socket of sockets) socket.destroy(); listener.close(); });
  return (listener.address() as net.AddressInfo).port;
}

/** A device's shell over RPC, as `grants` let a paired device use it; `audit` gets its entries. */
function remoteShell(t: TestContext, grants: string[], owner: string, audit: AuditEntry[] = []) {
  const { port1, port2 } = new MessageChannel();
  const granted = new GrantedShell(new ShellApi(undefined, { owner }), { current: expandGrants(grants, { ports: true }) }, "laptop", owner, undefined, undefined, undefined, undefined, (entry) => audit.push(entry));
  newMessagePortRpcSession(port1, granted);
  const remote = newMessagePortRpcSession<ShellApi>(port2);
  t.after(() => { remote[Symbol.dispose](); granted[Symbol.dispose](); port1.close(); port2.close(); });
  return remote;
}

/** Carry one connection through `forward`, as cns forward does: returns this side's socket. */
async function through(t: TestContext, forward: { connect(sink: ForwardSink): PromiseLike<unknown> }, flow = new Flow(), tunnels = new Set<Tunnel>()) {
  const listener = net.createServer({ allowHalfOpen: true, pauseOnConnect: true });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const accepted = once(listener, "connection") as Promise<[net.Socket]>;
  const socket = net.connect({ host: "127.0.0.1", port: (listener.address() as net.AddressInfo).port, allowHalfOpen: true });
  const [inner] = await accepted;
  t.after(() => { socket.destroy(); inner.destroy(); listener.close(); });
  await carry(forward, inner, flow, tunnels);
  return socket;
}

/** Everything `socket` sends until its end. */
const readAll = (socket: net.Socket) => new Promise<Buffer>((resolve, reject) => {
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.once("end", () => resolve(Buffer.concat(chunks)));
  socket.once("error", reject);
});

test("a forward carries bytes in order both ways over RPC, and a half-closed connection still answers", async (t) => {
  const reply = randomBytes(3 * 1024 * 1024 + 17);
  // The service reads until the end, then answers with the hash of what it got and more bytes.
  const port = await server(t, (socket) => {
    void readAll(socket).then((got) => { socket.write(sha(got)); socket.end(reply); });
  });
  const audit: AuditEntry[] = [];
  const remote = remoteShell(t, ["shell"], "carry", audit);
  const forward = await remote.forward(port);
  const sent = randomBytes(5 * 1024 * 1024 + 3);
  const socket = await through(t, forward);
  const answer = readAll(socket);
  socket.end(sent);
  const got = await answer;
  assert.equal(got.subarray(0, 64).toString(), sha(sent));
  assert.equal(sha(got.subarray(64)), sha(reply));
  // One entry when it starts and one when it ends, with what it carried; none per connection.
  assert.deepEqual(audit.map((entry) => [entry.action, entry.target, entry.phase]), [["port.forward", `localhost:${port}`, "start"]]);
  await once(socket, "close");
  forward[Symbol.dispose]();
  await until(() => audit.length === 2, "the end line");
  const { phase: _phase, ...started } = audit[0]!;
  assert.deepEqual({ ...audit[1], end: undefined }, { ...started, end: undefined, connections: 1, bytesIn: sent.length, bytesOut: 64 + reply.length });
  assert.ok(Date.parse(audit[1]!.end!) >= Date.parse(audit[1]!.start));
});

test("a sink that never answers stops reads: the device reads no more of the port than the window holds", async (t) => {
  let service!: net.Socket;
  const port = await server(t, (socket) => { service = socket; });
  const forward = new PortForward(port, "window");
  t.after(() => forward[Symbol.dispose]());
  const calls: Uint8Array[] = [];
  const sink: ForwardSink = { data: (data) => { calls.push(data); return new Promise(() => {}); }, end() {}, closed() {} };
  using connection = await forward.connect(sink);
  void connection;
  await until(() => !!service, "the service's connection");
  // The service writes far more than the window: the device stops reading, so the kernel's buffers fill and its writes back up.
  const big = Buffer.alloc(64 * 1024 * 1024);
  service.write(big);
  await until(() => calls.length === CONNECTION_WINDOW, "the window's calls");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(calls.length, CONNECTION_WINDOW);
  assert.ok(calls.every((call) => call.byteLength <= FORWARD_CHUNK_BYTES));
  assert.ok(service.writableLength > 32 * 1024 * 1024, `the service's own buffer holds what was not read: ${service.writableLength}`);

  // Three connections share the forward's window: their own windows would allow 12 calls
  // unanswered, and together they never have more than FORWARD_WINDOW.
  assert.ok(3 * CONNECTION_WINDOW > FORWARD_WINDOW);
  const services: net.Socket[] = [];
  const second = await server(t, (socket) => { services.push(socket); });
  const shared = new PortForward(second, "window");
  t.after(() => shared[Symbol.dispose]());
  const counted: Uint8Array[] = [];
  const quiet: ForwardSink = { data: (data) => { counted.push(data); return new Promise(() => {}); }, end() {}, closed() {} };
  const connections = [];
  for (let i = 0; i < 3; i++) {
    connections.push(await shared.connect(quiet));
    await until(() => services.length === i + 1, "the service's connection");
  }
  for (const each of services) each.write(big);
  await until(() => counted.length === FORWARD_WINDOW, "the forward's window");
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(counted.length, FORWARD_WINDOW);
  for (const each of connections) each[Symbol.dispose]();
});

test("the forwarding device may not have more than the forward's window unanswered over all its connections", async (t) => {
  const services: net.Socket[] = [];
  // The service reads nothing, so once its buffers are full the device's writes stay unanswered.
  const port = await server(t, (socket) => { services.push(socket); socket.pause(); });
  const forward = new PortForward(port, "receive-window");
  t.after(() => forward[Symbol.dispose]());
  const closed: Array<string | undefined> = [];
  const connections = [];
  for (let i = 0; i < 3; i++) {
    connections.push(await forward.connect({ data() {}, end() {}, closed: (reason) => { closed.push(reason); } }));
    await until(() => services.length === i + 1, "the service's connection");
  }
  // Each connection keeps fewer than its own window unanswered, so only the forward's is passed.
  const chunk = new Uint8Array(FORWARD_CHUNK_BYTES);
  const pending = connections.map(() => 0);
  let refused: string | undefined;
  for (let round = 0; round < 6000 && refused === undefined; round++) {
    const at = round % connections.length;
    if (pending[at]! < CONNECTION_WINDOW - 1) {
      pending[at]!++;
      connections[at]!.write(chunk).then(() => { pending[at]!--; }, (error: unknown) => { refused ??= (error as Error).message; });
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.match(refused ?? "nothing was refused", new RegExp(`or ${FORWARD_WINDOW} on one forward`));
  assert.ok(pending.every((count) => count < CONNECTION_WINDOW));
  await until(() => closed.length >= 1, "the connection closing");
});

test("a forwarding device that sends more than the window allows is cut off", async (t) => {
  let service!: net.Socket;
  const port = await server(t, (socket) => { service = socket; socket.pause(); });
  const forward = new PortForward(port, "oversend");
  t.after(() => forward[Symbol.dispose]());
  const closed: Array<string | undefined> = [];
  const connection = await forward.connect({ data() {}, end() {}, closed: (reason) => { closed.push(reason); } });
  await until(() => !!service, "the service's connection");
  // The service reads nothing, so writes stay unanswered once its buffers are full; then one more than the window.
  const chunk = new Uint8Array(FORWARD_CHUNK_BYTES);
  const writes: Promise<void>[] = [];
  for (let sent = 0; sent < 512 && !closed.length; sent++) {
    writes.push(connection.write(chunk).catch(() => {}));
    await new Promise((resolve) => setImmediate(resolve));
  }
  await assert.rejects(connection.write(new Uint8Array(FORWARD_CHUNK_BYTES + 1)), /at most 65536 bytes/);
  await until(() => closed.length === 1, "the connection closing");
  assert.match(closed[0]!, new RegExp(`more than ${CONNECTION_WINDOW} chunks unanswered`));
  void writes;
});

test("a sink without data, end and closed is refused, and one that breaks closes only its own connection", async (t) => {
  const port = await server(t, (socket) => socket.write("hello from the service"));
  const remote = remoteShell(t, [`port:${port}`], "hostile");
  const forward = await remote.forward(port);
  for (const shape of [{}, [], { data() {}, end() {} }, { data: 1, end() {}, closed() {} }]) {
    await assert.rejects(async () => { await forward.connect(shape as unknown as ForwardSink); }, /A forward sink has data, end and closed\./);
  }

  // A sink whose calls throw: the connection closes with why, and nothing escapes into the socket's handler.
  const local = new PortForward(port, "hostile-local");
  t.after(() => local[Symbol.dispose]());
  const reasons: Array<string | undefined> = [];
  await local.connect({ data() { throw new Error("broken sink"); }, end() {}, closed(reason) { reasons.push(reason); throw new Error("broken again"); } });
  await until(() => reasons.length === 1, "the broken sink's connection closing");
  assert.equal(reasons[0], "broken sink");

  // A plain object's functions are stubs that capnweb releases once connect returns, so the
  // device's calls on them fail: each such connection closes and gives its slot back.
  for (let i = 0; i < MAX_FORWARD_CONNECTIONS; i++) await forward.connect({ data() {}, end() {}, closed() {} });
  class Sink extends RpcTarget implements ForwardSink { got = ""; data(data: Uint8Array) { this.got += Buffer.from(data).toString(); } end() {} closed() {} }
  const sink = new Sink();
  let connection: { [Symbol.dispose](): void } | undefined;
  for (const deadline = Date.now() + 5000; !connection;) {
    try { connection = await forward.connect(sink); }
    catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  await until(() => sink.got === "hello from the service", "the service's bytes through a sink that holds");
  connection[Symbol.dispose]();
});

test("connection 33 and forward 9 are refused, and a released one makes room", async (t) => {
  const held: net.Socket[] = [];
  const port = await server(t, (socket) => held.push(socket));
  const owner = "limits";
  const forwards = Array.from({ length: MAX_FORWARDS }, () => new PortForward(port, owner));
  t.after(() => { for (const forward of forwards) forward[Symbol.dispose](); });
  assert.throws(() => new PortForward(port, owner), new RegExp(`at most ${MAX_FORWARDS} forwards`));
  // Another device has room of its own.
  new PortForward(port, "another device")[Symbol.dispose]();
  forwards.shift()![Symbol.dispose]();
  forwards.push(new PortForward(port, owner));

  const sink: ForwardSink = { data() {}, end() {}, closed() {} };
  const forward = forwards[0]!;
  const connections = await Promise.all(Array.from({ length: MAX_FORWARD_CONNECTIONS }, () => forward.connect(sink)));
  await assert.rejects(forward.connect(sink), new RegExp(`at most ${MAX_FORWARD_CONNECTIONS} connections`));
  connections.pop()![Symbol.dispose]();
  await until(() => held.filter((socket) => !socket.destroyed && !socket.readableEnded).length <= MAX_FORWARD_CONNECTIONS, "one connection closing");
  await new Promise((resolve) => setTimeout(resolve, 50));
  connections.push(await forward.connect(sink));
  for (const connection of connections) connection[Symbol.dispose]();
});

test("forwarding needs shell, or the port's own word, and each connection checks it again", async (t) => {
  const port = await server(t, (socket) => socket.end("hello"));
  const unused = await server(t, () => {});
  assert.ok(await (await remoteShell(t, ["shell"], "grant-shell").forward(port)));
  const narrow = remoteShell(t, [`port:${port}`], "grant-port");
  const forward = await narrow.forward(port);
  const socket = await through(t, forward);
  assert.equal((await readAll(socket)).toString(), "hello");
  await assert.rejects(async () => { await narrow.forward(unused); }, new RegExp(`^Error: Permission denied: port:${unused} not granted to laptop\\.$`));
  // Every other grant together is not enough: only shell reaches every port.
  await assert.rejects(async () => { await remoteShell(t, ["files", "skills", "sessions", `port:${unused}`], "grant-others").forward(port); }, /Permission denied: port:\d+ not granted/);
  await assert.rejects(async () => { await narrow.forward(70000); }, /65535/);
  assert.equal(explainDenial(`Permission denied: port:${unused} not granted to laptop.`, "studio"),
    `Permission denied: port:${unused} not granted to laptop. To allow it, run on studio: cns peer grant laptop port:${unused}`);

  // A grant taken away while the forward is open stops new connections at once.
  const holder = { current: expandGrants([`port:${port}`], { ports: true }) };
  const granted = new GrantedShell(new ShellApi(undefined, { owner: "recheck" }), holder, "laptop");
  t.after(() => granted[Symbol.dispose]());
  const live = granted.forward(port);
  const sink: ForwardSink = { data() {}, end() {}, closed() {} };
  (await live.connect(sink))[Symbol.dispose]();
  holder.current = [];
  await assert.rejects(async () => { await live.connect(sink); }, new RegExp(`Permission denied: port:${port} not granted to laptop`));
});

test("the forward tries 127.0.0.1, then ::1, and says when nothing listens", async (t) => {
  const ipv6 = await new Promise<boolean>((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(0, "::1", () => { probe.close(); resolve(true); });
  });
  const free = await server(t, () => {});
  // Released, so nothing listens there now.
  const closed = new PortForward(free, "dial");
  t.after(() => closed[Symbol.dispose]());
  const sink: ForwardSink = { data() {}, end() {}, closed() {} };
  const nobody = await new Promise<number>((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => { const { port } = probe.address() as net.AddressInfo; probe.close(() => resolve(port)); });
  });
  const none = new PortForward(nobody, "dial");
  t.after(() => none[Symbol.dispose]());
  await assert.rejects(none.connect(sink), new RegExp(`^Error: nothing listens on port ${nobody} there\\. Start the service, then connect again\\.$`));
  if (!ipv6) { t.diagnostic("no IPv6 loopback here: ::1 not tested"); return; }
  const port = await server(t, (socket) => socket.end("six"), "::1");
  const six = new PortForward(port, "dial");
  t.after(() => six[Symbol.dispose]());
  const socket = await through(t, six);
  assert.equal((await readAll(socket)).toString(), "six");
});

test("a device that runs a cns from before cns forward is named, with the command that updates it", async (t) => {
  // An older device's shell has no forward: capnweb answers "'forward' is not a function".
  class Older extends RpcTarget { info() { return {}; } }
  const { port1, port2 } = new MessageChannel();
  newMessagePortRpcSession(port1, new Older());
  const remote = newMessagePortRpcSession<ShellApi>(port2);
  t.after(() => { remote[Symbol.dispose](); port1.close(); port2.close(); });
  await assert.rejects(openForward(remote as unknown as RpcStub<ShellApi>, "studio", 5432, true), (error: unknown) => {
    assert.ok(error instanceof Final);
    assert.equal(error.message, "studio runs a cns from before cns forward; update it: cns upgrade studio");
    assert.equal(error.code, 1);
    return true;
  });
});
