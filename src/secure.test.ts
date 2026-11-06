import assert from "node:assert/strict";
import test from "node:test";
import { newWebSocketRpcSession, RpcTarget } from "capnweb";
import { AuthError } from "./auth.js";
import { generateIdentity } from "./identity.js";
import { connectSecure, rpcSession, secureReady, SecureChannel, serverWire, type Timing, type Wire } from "./secure.js";
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
function pair(options: { expect?: string; authorize?: () => undefined | string; timing?: Timing; tap?: (data: string | Uint8Array, from: "laptop" | "studio") => (string | Uint8Array)[] } = {}) {
  const tap = options.tap ?? ((data) => [data]);
  let toStudio!: SecureChannel, toLaptop!: SecureChannel;
  const wire = (from: "laptop" | "studio"): Wire => ({
    send: (data) => {
      const copy = typeof data === "string" ? data : data.slice();
      queueMicrotask(() => { for (const item of tap(copy, from)) (from === "laptop" ? toStudio : toLaptop).deliver(item); });
    },
    close: (_code, reason) => queueMicrotask(() => (from === "laptop" ? toStudio : toLaptop).closed(reason)),
  });
  toStudio = SecureChannel.responder(wire("studio"), studio, { authorize: options.authorize ?? (() => undefined), timing: options.timing });
  toLaptop = SecureChannel.initiator(wire("laptop"), laptop, { expect: options.expect ?? studio.publicKey, timing: options.timing });
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
        // The first binary message is the stream header; records follow.
        if (records++ === 0) return [data];
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
        const channel = SecureChannel.responder(serverWire(ws), studio, { authorize: () => undefined });
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
  assert.ok(!seen.some((message) => message.includes(secret) || message.includes("echo")), "requests are encrypted");
  channel.close();

  // A legacy client speaks Cap'n Web at once: it is refused and gets nothing back.
  const socket = new WebSocket(url);
  const legacy = newWebSocketRpcSession<Echo>(socket);
  await assert.rejects(Promise.resolve(legacy.echo("hello")));
  legacy[Symbol.dispose]();

  await assert.rejects(connectSecure(url, laptop, { expect: generateIdentity().publicKey }), (error: AuthError) => error.code === "identity-changed");
});
