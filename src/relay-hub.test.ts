import assert from "node:assert/strict";
import test from "node:test";
import { startRelay } from "./commands/relay.js";
import { generateIdentity } from "./identity.js";
import { challengeBytes, isRelayAddress, MAX_DIALS_PER_ADDRESS, redactRelay, relayEndpoint, route } from "./relay-hub.js";
import { LOOPBACK } from "./test-support.js";

/** A test socket that records messages and can wait for one. */
async function open(url: string) {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const messages: Array<string | ArrayBuffer> = [];
  let notify = () => {};
  socket.addEventListener("message", (event) => { messages.push(event.data as string | ArrayBuffer); notify(); });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason })));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => reject(new Error(`cannot open ${url}`)), { once: true });
  });
  const next = async (): Promise<string | ArrayBuffer> => {
    const deadline = Date.now() + 5000;
    while (!messages.length) {
      if (Date.now() > deadline) throw new Error("no message");
      await new Promise<void>((resolve) => { notify = resolve; setTimeout(resolve, 50); });
    }
    return messages.shift()!;
  };
  return { socket, next, closed, json: async () => JSON.parse(await next() as string) };
}

/** An external relay to test instead of a local one, such as the Worker under wrangler dev. */
const external = process.env.CNS_TEST_RELAY_URL;
/** What a dialer would get, without opening a socket. */
const dialStatus = async (url: string) => (await fetch(url.replace(/^ws/, "http"), { headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13" } })).status;

async function register(base: string, identity: ReturnType<typeof generateIdentity>, sign = identity, host?: string) {
  const url = relayEndpoint(base, "accept", identity.publicKey);
  const listener = await open(url);
  const challenge = await listener.json();
  assert.equal(challenge.t, "challenge");
  const sig = Buffer.from(sign.sign(await challengeBytes(host ?? new URL(url).host, identity.publicKey, challenge.nonce))).toString("base64url");
  listener.socket.send(JSON.stringify({ t: "proof", sig }));
  return listener;
}

test("relay URLs and routes", () => {
  const key = generateIdentity().publicKey;
  assert.equal(relayEndpoint("https://relay.example/base/?token=t", "accept", key), `wss://relay.example/base/v1/accept/${key}?token=t`);
  // Only registering carries the token; dial addresses are shared with paired devices.
  assert.equal(relayEndpoint("https://relay.example/base/?token=t", "dial", key), `wss://relay.example/base/v1/dial/${key}`);
  assert.equal(redactRelay("wss://relay.example/?token=s3cret&x=1"), "wss://relay.example/?token=…&x=1");
  assert.equal(relayEndpoint("ws://127.0.0.1:47380", "answer", key, "A".repeat(22)), `ws://127.0.0.1:47380/v1/answer/${key}/${"A".repeat(22)}`);
  assert.throws(() => relayEndpoint("ftp://x", "dial", key));
  assert.throws(() => relayEndpoint("wss://user:pass@x", "dial", key));
  assert.ok(isRelayAddress(relayEndpoint("wss://relay.example", "dial", key)));
  assert.ok(!isRelayAddress("ws://192.168.1.10:47381/"));
  assert.deepEqual(route(new URL(`wss://x/v1/accept/${key}`)), { kind: "accept", key });
  assert.equal(route(new URL("wss://x/v1/accept/short")), undefined);
  assert.equal(route(new URL(`wss://x/v1/answer/${key}/bad`)), undefined);
  assert.deepEqual(route(new URL("https://x/")), { kind: "health" });
});

test("a daemon registers by proving its key, and the relay forwards dialers to it", async (t) => {
  let base = external;
  if (!base) {
    const relay = startRelay({ bind: LOOPBACK, port: 0 });
    t.after(() => relay.stop());
    base = relay.url;
  }
  const studio = generateIdentity();
  assert.equal(await (await fetch(base.replace("ws", "http"))).text(), "cns relay\n");

  // Nobody registered yet: dialing is refused before a socket is accepted.
  assert.equal(await dialStatus(relayEndpoint(base, "dial", studio.publicKey)), 404);

  // A proof made with another key is refused.
  const impostor = await register(base, studio, generateIdentity());
  assert.equal((await impostor.closed).code, 4003);

  const listener = await register(base, studio);
  assert.deepEqual(await listener.json(), { t: "ready" });
  listener.socket.send(JSON.stringify({ t: "ping" }));
  assert.deepEqual(await listener.json(), { t: "pong" });

  // The dialer's first messages wait until the daemon answers, then everything flows both ways.
  const dialer = await open(relayEndpoint(base, "dial", studio.publicKey));
  dialer.socket.send("hello from the dialer");
  dialer.socket.send(new Uint8Array([1, 2, 3]));
  const incoming = await listener.json();
  assert.equal(incoming.t, "incoming");
  const answer = await open(relayEndpoint(base, "answer", studio.publicKey, incoming.id));
  assert.equal(await answer.next(), "hello from the dialer");
  assert.deepEqual([...new Uint8Array(await answer.next() as ArrayBuffer)], [1, 2, 3]);
  answer.socket.send("hello from the daemon");
  assert.equal(await dialer.next(), "hello from the daemon");
  // An id answers once: refused before the upgrade (the Worker) or right after it (cns relay).
  const again = await open(relayEndpoint(base, "answer", studio.publicKey, incoming.id)).then((socket) => socket.closed.then(({ code }) => code), () => 404);
  assert.ok(again === 404 || again === 4004, `refused, not ${again}`);
  // Closing one side closes the other.
  answer.socket.close(1000, "done");
  assert.equal((await dialer.closed).code, 1000);

  // A newer registration replaces the older, as when a daemon restarts.
  const restarted = await register(base, studio);
  assert.deepEqual(await restarted.json(), { t: "ready" });
  assert.equal((await listener.closed).code, 4000);
  // A dialer whose daemon never answers is closed.
  restarted.socket.close();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(await dialStatus(relayEndpoint(base, "dial", studio.publicKey)), 404);
});

test("a dial refused while a daemon proves its key does not lose the registration", async (t) => {
  const relay = external ? { url: external } : startRelay({ bind: LOOPBACK, port: 0 });
  if ("stop" in relay) t.after(() => relay.stop());
  const studio = generateIdentity();
  const url = relayEndpoint(relay.url, "accept", studio.publicKey);
  const listener = await open(url);
  const challenge = await listener.json();
  // A dialer arrives before the proof: refused, but the registration in progress stands.
  assert.equal(await dialStatus(relayEndpoint(relay.url, "dial", studio.publicKey)), 404);
  listener.socket.send(JSON.stringify({ t: "proof", sig: Buffer.from(studio.sign(await challengeBytes(new URL(url).host, studio.publicKey, challenge.nonce))).toString("base64url") }));
  assert.deepEqual(await listener.json(), { t: "ready" });
  const dialer = await open(relayEndpoint(relay.url, "dial", studio.publicKey));
  assert.equal((await listener.json()).t, "incoming");
  dialer.socket.close();
  listener.socket.close();
});

test("a relay's token gates registering, not dialing", { skip: !!external }, async (t) => {
  const relay = startRelay({ bind: LOOPBACK, port: 0, token: "s3cret-token" });
  t.after(() => relay.stop());
  const studio = generateIdentity();
  for (const base of [relay.url, `${relay.url}/?token=wrong`]) {
    assert.equal(await open(relayEndpoint(base, "accept", studio.publicKey)).then(() => "open", () => "refused"), "refused");
  }
  const listener = await register(`${relay.url}/?token=s3cret-token`, studio);
  assert.deepEqual(await listener.json(), { t: "ready" });
  // A dialer needs no token: it can only reach a registered device, which authenticates it.
  const dialer = await open(relayEndpoint(`${relay.url}/?token=s3cret-token`, "dial", studio.publicKey));
  assert.equal((await listener.json()).t, "incoming");
  dialer.socket.close();
  listener.socket.close();
});

test("one address cannot fill a device's relay connections, and a departing daemon frees its dialers", { skip: !!external }, async (t) => {
  const relay = startRelay({ bind: LOOPBACK, port: 0 });
  t.after(() => relay.stop());
  const studio = generateIdentity();
  const listener = await register(relay.url, studio);
  assert.deepEqual(await listener.json(), { t: "ready" });
  const dialers = [];
  for (let index = 0; index < MAX_DIALS_PER_ADDRESS; index++) dialers.push(await open(relayEndpoint(relay.url, "dial", studio.publicKey)));
  assert.equal(await dialStatus(relayEndpoint(relay.url, "dial", studio.publicKey)), 429);
  listener.socket.close();
  // Nobody will answer them now: they are closed at once, not after the answer timeout.
  const started = Date.now();
  for (const dialer of dialers) assert.equal((await dialer.closed).code, 4004);
  assert.ok(Date.now() - started < 2000);
});

test("with a public host, only proofs for that host register", { skip: !!external }, async (t) => {
  const relay = startRelay({ bind: LOOPBACK, port: 0, publicHost: "relay.example.com" });
  t.after(() => relay.stop());
  const studio = generateIdentity();
  // Signed for the address dialed, or for another relay: refused, whatever Host header was sent.
  for (const host of [undefined, "other-relay.example"]) {
    const wrong = await register(relay.url, studio, studio, host);
    assert.equal((await wrong.closed).code, 4003);
  }
  const right = await register(relay.url, studio, studio, "relay.example.com");
  assert.deepEqual(await right.json(), { t: "ready" });
  right.socket.close();
});
