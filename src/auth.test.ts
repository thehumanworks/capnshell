import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { AuthError, Initiator, Responder, refusalFor, type InitiatorOptions, type ResponderOptions } from "./auth.js";
import { generateIdentity } from "./identity.js";

const laptop = generateIdentity();
const studio = generateIdentity();
const stranger = generateIdentity();

/** Run a whole handshake in process, optionally tampering with each message in flight. */
async function handshake(initiator: InitiatorOptions, responder: ResponderOptions, tamper: (text: string, index: number) => string = (text) => text) {
  const a = new Initiator(laptop, initiator);
  const b = new Responder(studio, responder);
  let index = 0;
  let toB = tamper(a.start(), index++);
  for (;;) {
    let fromB: string | undefined;
    try { const step = await b.receive(toB); fromB = step.send; if (step.peer) { assert.equal(step.peer, laptop.publicKey); } }
    catch (error) { fromB = refusalFor(error); if (!fromB) throw error; }
    if (fromB === undefined) throw new Error("responder sent nothing");
    const step = a.receive(tamper(fromB, index++));
    if (step.peer) return step.peer;
    toB = tamper(step.send!, index++);
  }
}

test("paired devices authenticate each other in three messages", async () => {
  const seen: string[] = [];
  const peer = await handshake({ expect: studio.publicKey }, { authorize: (key) => { seen.push(key); return undefined; } });
  assert.equal(peer, studio.publicKey);
  assert.deepEqual(seen, [laptop.publicKey]);
});

test("the responder refuses an unauthorized device before anything else happens, with the reason", async () => {
  await assert.rejects(handshake({}, { authorize: () => ({ code: "not-paired", reason: "Not paired with this device." }) }),
    (error: AuthError) => error.code === "not-paired" && /Not paired/.test(error.message));
  await assert.rejects(handshake({}, { authorize: () => "Busy." }), (error: AuthError) => error.code === "refused" && /Busy/.test(error.message));
});

test("an unexpected responder identity is reported as changed, not accepted", async () => {
  await assert.rejects(handshake({ expect: stranger.publicKey }, { authorize: () => undefined }),
    (error: AuthError) => error.code === "identity-changed");
});

test("forged or tampered messages fail the handshake", async () => {
  // A responder whose signature is not over this transcript.
  await assert.rejects(handshake({}, { authorize: () => undefined }, (text, index) => {
    if (index !== 1) return text;
    const message = JSON.parse(text);
    message.sig = Buffer.from(stranger.sign(randomBytes(32))).toString("base64url");
    return JSON.stringify(message);
  }), (error: AuthError) => error.code === "protocol" && /prove its identity/.test(error.message));
  // An initiator whose key is swapped after it signed.
  await assert.rejects(handshake({}, { authorize: () => undefined }, (text, index) => {
    if (index !== 0) return text;
    return JSON.stringify({ ...JSON.parse(text), key: stranger.publicKey });
  }), (error: AuthError) => error.code === "protocol");
  // Not a handshake at all: an older cns speaks Cap'n Web first.
  const responder = new Responder(studio, { authorize: () => undefined });
  await assert.rejects(responder.receive('["push",1]'), (error: AuthError) => error.code === "protocol" && /older cns/.test(error.message) && refusalFor(error) !== undefined);
  await assert.rejects(responder.receive("{}"), (error: AuthError) => error.code === "protocol");
  // A replayed responder hello from another run does not verify against fresh nonces.
  const first = new Responder(studio, { authorize: () => undefined });
  const replay = (await first.receive(new Initiator(laptop).start())).send!;
  const second = new Initiator(laptop);
  second.start();
  assert.throws(() => second.receive(replay), (error: AuthError) => error.code === "protocol");
});

test("pairing proves knowledge of the invite secret", async () => {
  const secret = randomBytes(16);
  const invites = { secretFor: (id: string) => id === "inv1" ? secret : undefined };
  const accepted: Array<{ id: string } | undefined> = [];
  const authorize: ResponderOptions["authorize"] = (_peer, invite) => { accepted.push(invite); return undefined; };
  assert.equal(await handshake({ invite: { id: "inv1", secret } }, { authorize, ...invites }), studio.publicKey);
  assert.deepEqual(accepted, [{ id: "inv1" }]);
  await assert.rejects(handshake({ invite: { id: "inv1", secret: randomBytes(16) } }, { authorize, ...invites }),
    (error: AuthError) => error.code === "invalid-proof");
  await assert.rejects(handshake({ invite: { id: "expired", secret } }, { authorize, ...invites }),
    (error: AuthError) => error.code === "refused" && /Unknown or expired invite/.test(error.message));
  // A proof without an invite is not a valid message.
  await assert.rejects(handshake({}, { authorize, ...invites }, (text, index) => index === 2 ? JSON.stringify({ ...JSON.parse(text), proof: "AAAA" }) : text),
    (error: AuthError) => error.code === "protocol");
  assert.equal(accepted.length, 1);
});

test("a finished or refused handshake accepts nothing further", async () => {
  const a = new Initiator(laptop);
  const b = new Responder(studio, { authorize: () => undefined });
  const hello = (await b.receive(a.start())).send!;
  const auth = a.receive(hello).send!;
  const done = await b.receive(auth);
  assert.equal(a.receive(done.send!).peer, studio.publicKey);
  assert.throws(() => a.receive(done.send!), (error: AuthError) => error.code === "protocol");
  await assert.rejects(b.receive(auth), (error: AuthError) => error.code === "protocol");
  assert.throws(() => a.start(), /already started/);
});
