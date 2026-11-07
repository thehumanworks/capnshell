import assert from "node:assert/strict";
import test from "node:test";
import { startRelay } from "./relay-server.js";
import { generateIdentity } from "./identity.js";
import { challengeBytes, CLIENT_HEADER, CLIENT_KEY, CLIENT_SKEW_MS, clientProof, dialAddresses, isRelayAddress, isRelayRequest, MAX_DIALS_PER_ADDRESS, relayEndpoint, route, verifyClient } from "./relay-hub.js";
import { LOOPBACK } from "./test-support.js";

/** The client header cns sends, made for `url`, or for `host` in its place, as a relay behind a proxy sees it. */
async function client(url: string, host?: string): Promise<Record<string, string>> {
  const signed = new URL(url);
  if (host) { signed.port = ""; signed.host = host; }
  return { [CLIENT_HEADER]: await clientProof(signed.href) };
}

/** A test socket that records messages and can wait for one. It sends the cns client header unless `headers` replaces it. */
async function open(url: string, headers?: Record<string, string>) {
  const socket = new WebSocket(url, { headers: headers ?? await client(url) });
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
const dialStatus = async (url: string, headers?: Record<string, string>) => (await fetch(url.replace(/^ws/, "http"), { headers: { Upgrade: "websocket", Connection: "Upgrade", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13", ...headers ?? await client(url) } })).status;

async function register(base: string, identity: ReturnType<typeof generateIdentity>, sign = identity, host?: string, clientHost = host) {
  const url = relayEndpoint(base, "accept", identity.publicKey);
  const listener = await open(url, await client(url, clientHost));
  const challenge = await listener.json();
  assert.equal(challenge.t, "challenge");
  const sig = Buffer.from(sign.sign(await challengeBytes(host ?? new URL(url).host, identity.publicKey, challenge.nonce))).toString("base64url");
  listener.socket.send(JSON.stringify({ t: "proof", sig }));
  return listener;
}

test("relay URLs and routes", () => {
  const key = generateIdentity().publicKey;
  assert.equal(relayEndpoint("https://relay.example/base/", "accept", key), `wss://relay.example/base/v1/accept/${key}`);
  assert.equal(relayEndpoint("https://relay.example/base", "dial", key), `wss://relay.example/base/v1/dial/${key}`);
  // Relays take no token or other query: a URL with one is a mistake.
  assert.throws(() => relayEndpoint("wss://relay.example/?token=t", "accept", key));
  assert.equal(relayEndpoint("ws://127.0.0.1:47380", "answer", key, "A".repeat(22)), `ws://127.0.0.1:47380/v1/answer/${key}/${"A".repeat(22)}`);
  assert.throws(() => relayEndpoint("ftp://x", "dial", key));
  assert.throws(() => relayEndpoint("wss://user:pass@x", "dial", key));
  assert.ok(isRelayAddress(relayEndpoint("wss://relay.example", "dial", key)));
  assert.ok(!isRelayAddress("ws://192.168.1.10:47381/"));
  assert.ok(isRelayRequest(relayEndpoint("wss://relay.example", "accept", key)));
  assert.ok(isRelayRequest(relayEndpoint("wss://relay.example", "answer", key, "A".repeat(22))));
  assert.ok(!isRelayRequest("ws://192.168.1.10:47381/"));
  assert.deepEqual(route(new URL(`wss://x/v1/accept/${key}`)), { kind: "accept", key });
  assert.equal(route(new URL("wss://x/v1/accept/short")), undefined);
  assert.equal(route(new URL(`wss://x/v1/answer/${key}/bad`)), undefined);
  assert.deepEqual(route(new URL("https://x/")), { kind: "health" });
});

test("dialAddresses adds the relay only when the record has no relay address", () => {
  const key = generateIdentity().publicKey;
  const direct = ["ws://192.168.1.68:47381", "ws://100.107.74.1:47381"];
  assert.deepEqual(dialAddresses({ publicKey: key, addresses: direct }, undefined), direct);
  assert.deepEqual(dialAddresses({ publicKey: key, addresses: direct }, "wss://relay.example"), [...direct, `wss://relay.example/v1/dial/${key}`]);
  assert.deepEqual(dialAddresses({ publicKey: key, addresses: [] }, "wss://relay.example"), [`wss://relay.example/v1/dial/${key}`]);
  const saved = [...direct, "wss://other.example/v1/dial/" + key];
  assert.deepEqual(dialAddresses({ publicKey: key, addresses: saved }, "wss://relay.example"), saved);
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

test("the client header shows a request comes from cns, for one host and path, for a while", async () => {
  const key = generateIdentity().publicKey;
  const url = relayEndpoint("wss://relay.example", "dial", key);
  const header = await clientProof(url);
  assert.match(header, /^cns-client-1 \d+ [A-Za-z0-9_-]{22} [A-Za-z0-9_-]{43}$/);
  assert.ok(await verifyClient(header, "relay.example", `/v1/dial/${key}`));
  // Another relay, another path, another key, a stale or future time, or anything malformed: refused.
  assert.ok(!(await verifyClient(header, "other.example", `/v1/dial/${key}`)));
  assert.ok(!(await verifyClient(header, "relay.example", `/v1/accept/${key}`)));
  assert.ok(!(await verifyClient(header, "relay.example", `/v1/dial/${key}`, [Buffer.alloc(32, 7).toString("base64url")])));
  assert.ok(!(await verifyClient(await clientProof(url, CLIENT_KEY, Date.now() - CLIENT_SKEW_MS - 5000), "relay.example", `/v1/dial/${key}`)));
  assert.ok(!(await verifyClient(await clientProof(url, CLIENT_KEY, Date.now() + CLIENT_SKEW_MS + 5000), "relay.example", `/v1/dial/${key}`)));
  assert.ok(await verifyClient(await clientProof(url, CLIENT_KEY, Date.now() - CLIENT_SKEW_MS + 5000), "relay.example", `/v1/dial/${key}`));
  const [scheme, time, nonce, mac] = header.split(" ");
  for (const bad of [null, "", "cns-client-1", `${scheme} ${time} ${nonce}`, `cns-client-2 ${time} ${nonce} ${mac}`, `${scheme} ${time} ${nonce} ${mac} extra`,
    `${scheme} ${Number(time) + 1} ${nonce} ${mac}`, `${scheme} ${time} ${"B".repeat(22)} ${mac}`, `${scheme} ${time} ${nonce} ${"A".repeat(43)}`, `${scheme} ${time} ${nonce} !!!`]) {
    assert.ok(!(await verifyClient(bad, "relay.example", `/v1/dial/${key}`)), String(bad));
  }
  // The host is compared as a host is: without regard to case.
  assert.ok(await verifyClient(header, "RELAY.example", `/v1/dial/${key}`));
});

test("the relay refuses every request that does not come from cns", async (t) => {
  let base = external;
  if (!base) {
    const relay = startRelay({ bind: LOOPBACK, port: 0 });
    t.after(() => relay.stop());
    base = relay.url;
  }
  const studio = generateIdentity();
  const listener = await register(base, studio);
  assert.deepEqual(await listener.json(), { t: "ready" });
  const accept = relayEndpoint(base, "accept", generateIdentity().publicKey);
  const dial = relayEndpoint(base, "dial", studio.publicKey);
  const answer = relayEndpoint(base, "answer", studio.publicKey, "A".repeat(22));
  const forged = { [CLIENT_HEADER]: await clientProof(dial, Buffer.alloc(32, 7).toString("base64url")) };
  // Without the header, with one made under another key, or one made for another request.
  for (const [url, headers] of [[accept, {}], [dial, {}], [answer, {}], [dial, forged], [dial, await client(accept)]] as const) {
    assert.equal(await dialStatus(url, headers), 401, url);
    assert.equal(await open(url, headers).then(() => "open", () => "refused"), "refused");
  }
  // Nothing reached the registered daemon.
  await new Promise((resolve) => setTimeout(resolve, 200));
  const dialer = await open(dial);
  assert.equal((await listener.json()).t, "incoming", "the first message is cns's own dialer");
  dialer.socket.close();
  listener.socket.close();
  // A relay that accepts other keys refuses this build's.
  if (!external) {
    const other = startRelay({ bind: LOOPBACK, port: 0, clientKeys: [Buffer.alloc(32, 7).toString("base64url")] });
    t.after(() => other.stop());
    assert.equal(await dialStatus(relayEndpoint(other.url, "dial", studio.publicKey)), 401);
  }
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
  // The client header is made for the public host, as cns dialing wss://relay.example.com makes it.
  for (const host of [undefined, "other-relay.example"]) {
    const wrong = await register(relay.url, studio, studio, host, "relay.example.com");
    assert.equal((await wrong.closed).code, 4003);
  }
  const right = await register(relay.url, studio, studio, "relay.example.com");
  assert.deepEqual(await right.json(), { t: "ready" });
  right.socket.close();
});

test("the built-in relay needs no setting; CNS_RELAY replaces it only for development", async () => {
  const { builtInRelay, DEFAULT_RELAY } = await import("./relay-config.js");
  const saved = process.env.CNS_RELAY;
  try {
    delete process.env.CNS_RELAY;
    assert.equal(builtInRelay(), DEFAULT_RELAY);
    assert.match(DEFAULT_RELAY, /^wss:\/\/[^/?#]+$/);
    process.env.CNS_RELAY = "off";
    assert.equal(builtInRelay(), undefined);
    process.env.CNS_RELAY = "ws://127.0.0.1:8787";
    assert.equal(builtInRelay(), "ws://127.0.0.1:8787");
    process.env.CNS_RELAY = "wss://relay.example/?token=t";
    assert.throws(() => builtInRelay(), /CNS_RELAY must be a relay URL or off/);
  } finally { process.env.CNS_RELAY = saved; }
});
