import assert from "node:assert/strict";
import test from "node:test";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { AuthError } from "./auth.js";
import { generateIdentity } from "./identity.js";
import { closeReason } from "./connect.js";
import { connectFirst, connectSecure, rpcSession, secureReady, SecureChannel, serverWire, type Timing, type Wire } from "./secure.js";
import { LOOPBACK, LOOPBACK_HOST } from "./test-support.js";

const laptop = generateIdentity();
const studio = generateIdentity();
await secureReady();

class Echo extends RpcTarget {
  echo(text: string) { return text; }
  size(text: string) { return text.length; }
}

/**
 * Two channels joined by in-memory wires. `tap` sees, and may change or drop, every
 * message in flight; it returns what to deliver.
 */
function pair(options: { expect?: string; mode?: "daemon" | "client"; authorize?: () => undefined | string | Promise<undefined | string>; timing?: Timing; tap?: (data: string | Uint8Array, from: "laptop" | "studio") => (string | Uint8Array)[]; closes?: Array<{ from: string; code: number; reason: string }>; dropCloseFrom?: "laptop" | "studio" } = {}) {
  const tap = options.tap ?? ((data) => [data]);
  let toStudio!: SecureChannel, toLaptop!: SecureChannel;
  const wire = (from: "laptop" | "studio"): Wire => ({
    send: (data) => {
      const copy = typeof data === "string" ? data : data.slice();
      queueMicrotask(() => { for (const item of tap(copy, from)) (from === "laptop" ? toStudio : toLaptop).deliver(item); });
    },
    close: (code, reason) => {
      options.closes?.push({ from, code, reason });
      if (options.dropCloseFrom !== from) queueMicrotask(() => (from === "laptop" ? toStudio : toLaptop).closed(reason));
    },
  });
  toStudio = SecureChannel.responder(wire("studio"), studio, { authorize: options.authorize ?? (() => undefined), timing: options.timing });
  toLaptop = SecureChannel.initiator(wire("laptop"), laptop, { expect: options.expect ?? studio.publicKey, mode: options.mode, timing: options.timing });
  return { laptop: toLaptop, studio: toStudio };
}

test("the devices authenticate, then carry Cap'n Web, including messages larger than one record", async (t) => {
  const { laptop: a, studio: b } = pair();
  t.after(() => { a.close(); b.close(); });
  assert.deepEqual(await b.ready, { peer: laptop.publicKey, mode: "client" });
  assert.deepEqual(await a.ready, { peer: studio.publicKey, mode: "client" });
  rpcSession(b, new Echo());
  using remote = rpcSession<Echo>(a, undefined);
  assert.equal(await remote.echo("hello"), "hello");
  const large = "é".repeat(1_500_000); // 3 MB of UTF-8, about 46 records
  assert.equal(await remote.size(large), large.length);
  assert.equal(await remote.echo(large), large);
});

test("a tampered, replayed or unencrypted record closes the link", async () => {
  for (const attack of ["tamper", "replay", "plaintext"] as const) {
    let records = 0;
    let captured: Uint8Array | undefined;
    const { laptop: a, studio: b } = pair({
      tap: (data, from) => {
        if (from !== "laptop" || typeof data === "string") return [data];
        // The first binary messages are the stream header and the record confirming the keys.
        if (records++ < 2) return [data];
        if (attack === "tamper") { data[data.length - 1]! ^= 1; return [data]; }
        if (attack === "replay") { if (!captured) { captured = data.slice(); return [data]; } return [data, captured]; }
        return [data, '["push",["pipeline",0,["run"],["rm -rf /"]]]'];
      },
    });
    await Promise.all([a.ready, b.ready]);
    rpcSession(b, new Echo());
    using remote = rpcSession<Echo>(a, undefined);
    const first = remote.echo("one").then(() => "ok", (error: Error) => error.message);
    const second = remote.echo("two").then(() => "ok", (error: Error) => error.message);
    const reason = await b.done;
    assert.match(reason, attack === "plaintext" ? /unencrypted message/ : /failed authentication/, attack);
    assert.ok([await first, await second].some((outcome) => outcome !== "ok"), `${attack}: the link ends`);
    a.close();
  }
});

test("heartbeats keep an idle link open, and a link that falls silent is closed", async () => {
  let silent = false;
  const timing = { heartbeatMs: 60, timeoutMs: 240 };
  const { laptop: a, studio: b } = pair({ timing, tap: (data, from) => silent && from === "studio" ? [] : [data] });
  await Promise.all([a.ready, b.ready]);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.ok(a.open && b.open, "an idle link with heartbeats stays open");
  silent = true;
  const started = Date.now();
  assert.match(await a.done, /timed out/);
  assert.ok(Date.now() - started < 600, "the silent link is noticed within the timeout");
  b.close();
});

test("the wrong device, or a refusal, never opens the channel", async () => {
  const wrong = pair({ expect: generateIdentity().publicKey });
  await assert.rejects(wrong.laptop.ready, (error: AuthError) => error.code === "identity-changed");
  const refused = pair({ authorize: () => "Not today." });
  await assert.rejects(refused.laptop.ready, (error: AuthError) => error.code === "refused" && /Not today/.test(error.message));
  await assert.rejects(refused.studio.ready);
  assert.ok(!refused.laptop.open && !refused.studio.open);
});

test("over a real WebSocket, nothing readable crosses the wire and an older cns is refused", async (t) => {
  const seen: string[] = [];
  interface Data { channel?: SecureChannel }
  const server = Bun.serve<Data>({
    hostname: LOOPBACK, port: 0,
    fetch(request, server) { if (server.upgrade(request, { data: {} })) return; return new Response("WebSocket required", { status: 400 }); },
    websocket: {
      open(ws) {
        const wire = serverWire(ws);
        const channel = SecureChannel.responder({ send: (data) => { seen.push(typeof data === "string" ? data : Buffer.from(data).toString("latin1")); wire.send(data); }, close: wire.close }, studio, { authorize: () => undefined });
        ws.data.channel = channel;
        channel.ready.then(() => rpcSession(channel, new Echo()), () => {});
      },
      message(ws, message) { seen.push(typeof message === "string" ? message : Buffer.from(message).toString("latin1")); ws.data.channel?.deliver(typeof message === "string" ? message : new Uint8Array(message)); },
      close(ws) { ws.data.channel?.closed(); },
    },
  });
  t.after(() => server.stop(true));
  const url = `ws://${LOOPBACK_HOST}:${server.port}`;
  const { channel, peer } = await connectSecure(url, laptop, { expect: studio.publicKey });
  assert.equal(peer, studio.publicKey);
  using remote = rpcSession<Echo>(channel, undefined);
  const secret = "correct horse battery staple";
  assert.equal(await remote.echo(secret), secret);
  assert.ok(!seen.some((message) => message.includes(secret) || message.includes("echo")), "requests and replies are encrypted");
  channel.close();

  // A legacy client speaks Cap'n Web at once: it is refused and gets nothing back.
  const socket = new WebSocket(url);
  const legacy = newWebSocketRpcSession<Echo>(socket);
  await assert.rejects(Promise.resolve(legacy.echo("hello")));
  legacy[Symbol.dispose]();

  await assert.rejects(connectSecure(url, laptop, { expect: generateIdentity().publicKey }), (error: AuthError) => error.code === "identity-changed");
});

/** Change one field of a JSON handshake message in flight. */
const rewrite = (field: string, value: unknown, which: "laptop" | "studio") => (data: string | Uint8Array, from: "laptop" | "studio") => {
  if (from !== which || typeof data !== "string") return [data];
  const message = JSON.parse(data);
  return message.t === "hello" ? [JSON.stringify({ ...message, [field]: value })] : [data];
};

test("the key-exchange keys and the link mode are bound to both signatures", async () => {
  const otherKx = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  for (const which of ["laptop", "studio"] as const) {
    const swapped = pair({ tap: rewrite("kx", otherKx, which) });
    await assert.rejects(swapped.laptop.ready, `a swapped key from ${which} is caught`);
    await assert.rejects(swapped.studio.ready);
  }
  const daemon = pair({ mode: "daemon" });
  assert.equal((await daemon.studio.ready).mode, "daemon");
  daemon.laptop.close();
  const promoted = pair({ tap: rewrite("mode", "daemon", "laptop") });
  // Studio signed what it received; laptop, which asked for a command's connection, refuses that signature.
  await assert.rejects(promoted.laptop.ready, (error: AuthError) => /prove its identity/.test(error.message));
  await assert.rejects(promoted.studio.ready);
});

test("a forged acceptance never opens the channel: the other side must prove it holds the keys", async () => {
  const timing = { handshakeMs: 300 };
  const forged = pair({
    timing,
    dropCloseFrom: "studio",
    authorize: () => "Not paired.",
    tap: (data, from) => {
      if (from !== "studio") return [data];
      if (typeof data === "string" && JSON.parse(data).t === "refused") return [JSON.stringify({ t: "ok" }), crypto.getRandomValues(new Uint8Array(24))];
      return [data];
    },
  });
  // A random header and no record that opens: laptop gives up when the handshake time runs out.
  await assert.rejects(forged.laptop.ready, (error: AuthError) => error.code === "protocol" && /in time/.test(error.message));
  assert.equal(forged.laptop.open, false);
});

test("a decision that arrives after the channel closed sends nothing and opens nothing", async () => {
  let decide!: (value: undefined) => void;
  const sent: unknown[] = [];
  const late = pair({ authorize: () => new Promise((resolve) => { decide = resolve; }), tap: (data, from) => { if (from === "studio") sent.push(data); return [data]; } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const before = sent.length;
  late.studio.closed("gone");
  decide(undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.length, before, "no ok or header after closing");
  assert.equal(late.studio.open, false);
  await assert.rejects(late.studio.ready);
  late.laptop.close();
});

test("close frames carry fixed phrases, never decrypted text, and long reasons cost nothing", async () => {
  const started = performance.now();
  const cut = closeReason("é".repeat(2_000_000));
  assert.ok(performance.now() - started < 50, "bounded work");
  assert.ok(Buffer.byteLength(cut) <= 123 && !cut.includes("\uFFFD"));
  const closes: Array<{ from: string; code: number; reason: string }> = [];
  const { laptop: a, studio: b } = pair({ closes });
  await Promise.all([a.ready, b.ready]);
  // What Cap'n Web reports for a message it cannot read stays on this side.
  b.abort(new Error("bad RPC message: [\"futureOp\",{\"token\":\"s3cr3t\"}]"));
  assert.match(await b.done, /s3cr3t/);
  assert.deepEqual(closes, [{ from: "studio", code: 1011, reason: "RPC session ended" }]);
});

test("connectFirst tries addresses in order and honours a cancelled signal", async (t) => {
  interface Data { channel?: SecureChannel }
  const server = Bun.serve<Data>({
    hostname: LOOPBACK, port: 0,
    fetch(request, server) { if (server.upgrade(request, { data: {} })) return; return new Response("no", { status: 400 }); },
    websocket: {
      open(ws) { const channel = SecureChannel.responder(serverWire(ws), studio, { authorize: () => undefined }); ws.data.channel = channel; },
      message(ws, message) { ws.data.channel?.deliver(typeof message === "string" ? message : new Uint8Array(message)); },
      close(ws) { ws.data.channel?.closed(); },
    },
  });
  t.after(() => server.stop(true));
  const good = `ws://${LOOPBACK_HOST}:${server.port}`;
  const opened = await connectFirst(["ws://127.0.0.1:1", good], laptop, { expect: studio.publicKey });
  assert.equal(opened.url, good);
  opened.channel.close();
  await assert.rejects(connectFirst(["ws://127.0.0.1:1"], laptop, { expect: studio.publicKey }), /Cannot connect/);
  // Another device at the first address is the reason given, even when a later one is unreachable.
  await assert.rejects(connectFirst([good, "ws://127.0.0.1:1"], laptop, { expect: generateIdentity().publicKey }), (error: AuthError) => error.code === "identity-changed");
  const cancelled = new AbortController();
  cancelled.abort(new Error("stopped"));
  await assert.rejects(connectFirst([good], laptop, { expect: studio.publicKey, signal: cancelled.signal }), /stopped/);
});

/** A device that authenticates as `studio`, counting the sockets opened and links made. */
function studioServer(t: { after(fn: () => void): void }) {
  interface Data { channel?: SecureChannel }
  const seen = { opened: 0, established: 0 };
  const server = Bun.serve<Data>({
    hostname: LOOPBACK, port: 0,
    fetch(request, server) { if (server.upgrade(request, { data: {} })) return; return new Response("no", { status: 400 }); },
    websocket: {
      open(ws) {
        seen.opened++;
        const channel = SecureChannel.responder(serverWire(ws), studio, { authorize: () => undefined });
        channel.ready.then(() => { seen.established++; }, () => {});
        ws.data.channel = channel;
      },
      message(ws, message) { ws.data.channel?.deliver(typeof message === "string" ? message : new Uint8Array(message)); },
      close(ws) { ws.data.channel?.closed(); },
    },
  });
  t.after(() => server.stop(true));
  return { url: `ws://${LOOPBACK_HOST}:${server.port}`, seen };
}

/** An address that accepts TCP and then never answers, like a host that moved away behind a NAT. */
function stalledAddress(t: { after(fn: () => void): void }) {
  const listener = Bun.listen({ hostname: LOOPBACK, port: 0, socket: { data() {} } });
  t.after(() => listener.stop(true));
  return `ws://${LOOPBACK_HOST}:${listener.port}`;
}

const relayPath = `/v1/dial/${"A".repeat(43)}`;

test("connectFirst dials direct addresses together", async (t) => {
  const good = studioServer(t);
  const started = performance.now();
  const opened = await connectFirst([stalledAddress(t), stalledAddress(t), good.url], laptop, { expect: studio.publicKey });
  assert.equal(opened.url, good.url);
  assert.ok(performance.now() - started < 1500, "a dead address does not hold up a live one");
  opened.channel.close();
});

test("connectFirst gives direct addresses a head start over a relay", async (t) => {
  const direct = studioServer(t);
  const relay = studioServer(t);
  const opened = await connectFirst([relay.url + relayPath, direct.url], laptop, { expect: studio.publicKey, relayDelayMs: 500 });
  assert.equal(opened.url, direct.url);
  opened.channel.close();
  await Bun.sleep(700);
  assert.equal(relay.seen.opened, 0, "the relay was not dialed once a direct address answered");

  // A dead direct address costs the head start, not the whole per-address timeout.
  const started = performance.now();
  const viaRelay = await connectFirst([stalledAddress(t), relay.url + relayPath], laptop, { expect: studio.publicKey, relayDelayMs: 200 });
  const elapsed = performance.now() - started;
  assert.equal(viaRelay.url, relay.url + relayPath);
  assert.ok(elapsed >= 150 && elapsed < 1500, `relay used after the head start (${Math.round(elapsed)} ms)`);
  viaRelay.channel.close();

  // When every direct address has already failed, the relay does not wait.
  const quick = performance.now();
  const fallback = await connectFirst(["ws://127.0.0.1:1", relay.url + relayPath], laptop, { expect: studio.publicKey, relayDelayMs: 5000 });
  assert.ok(performance.now() - quick < 1500);
  fallback.channel.close();
});

test("connectFirst makes one link even when several addresses reach the device", async (t) => {
  const device = studioServer(t);
  const opened = await connectFirst([device.url, device.url + "/", device.url + "/?again"], laptop, { expect: studio.publicKey });
  await Bun.sleep(200);
  assert.equal(device.seen.established, 1);
  opened.channel.close();
});

test("connectFirst reports the most telling failure when every address fails", async (t) => {
  const other = studioServer(t);
  const started = performance.now();
  await assert.rejects(connectFirst([stalledAddress(t), other.url, "ws://127.0.0.1:1"], laptop, { expect: generateIdentity().publicKey, perAddressMs: 300 }),
    (error: AuthError) => error.code === "identity-changed");
  assert.ok(performance.now() - started < 1500);
  const cancel = new AbortController();
  const pending = connectFirst([stalledAddress(t), stalledAddress(t)], laptop, { expect: studio.publicKey, signal: cancel.signal });
  setTimeout(() => cancel.abort(new Error("stopped")), 50);
  await assert.rejects(pending, /stopped/);
});

test("a device on another protocol version is told so", async () => {
  const { Responder } = await import("./auth.js");
  const responder = new Responder(studio, new Uint8Array(32), { authorize: () => undefined });
  await assert.rejects(responder.receive(JSON.stringify({ t: "hello", v: 1, key: laptop.publicKey, nonce: "AAAAAAAAAAAAAAAAAAAAAA" })), /protocol 1, this one 2\. Update cns on both devices/);
});
