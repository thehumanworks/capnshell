import { createHash, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import sodium from "libsodium-wrappers-sumo";
import { z } from "zod";
import { closeSocket, openSocket } from "./connect.js";
import { printable } from "./errors.js";
import { INVITE_PREFIX } from "./pairing.js";
import { MAX_ROOM_MESSAGE_BYTES, ROOM_GUEST_MS, roomEndpoint } from "./relay-hub.js";
import { WORDS } from "./words.js";

/**
 * Pairing codes: a short code, such as 42-orbit-canyon-velvet, that a person reads on one
 * device and types on another, in place of the long cns1: invite.
 *
 * The code never carries the invite. Its number names a room on the relay; its three words
 * are the password of a CPace exchange (draft-irtf-cfrg-cpace, ristretto255 with SHA-512)
 * between the device that shows the code (the host, CPace's initiator A) and the device
 * that types it (the guest, B). Only a guest that knew the words derives the host's key; the
 * host checks that before it sends anything else, and then sends its invite sealed under
 * that key. Pairing then continues exactly as with a pasted invite: the guest dials the
 * invite's addresses, pins the host's key, proves the invite's secret, and both people
 * confirm the other's fingerprint.
 *
 * Neither the relay nor anyone else can test guesses offline: each guess means running
 * the exchange with the host, which ends the code after MAX_WRONG_CODES wrong ones.
 * The ristretto255 operations are libsodium's; this file composes them as the draft
 * specifies, and pairing-code.test.ts checks it against the draft's test vectors.
 *
 * Wire, as text through the room (relay-hub.ts PairingRooms):
 *   host  -> guest: { t: "hello", v: 1, sid, y }        sid: 16 random bytes, y: Ya
 *   guest -> host:  { t: "reply", y, tag }              y: Yb, tag: B's key confirmation
 *   host  -> guest: { t: "invite", tag, nonce, box }    or { t: "wrong", left }
 */

export const CODE_WORDS = 3;
/** Wrong codes a host takes before the code stops working. */
export const MAX_WRONG_CODES = 3;
/** How often a host pings the relay, so the room's connection stays up while it waits. */
const ROOM_PING_MS = 25_000;
const PROTOCOL = "cns-pairing-code-1";

const DSI = Buffer.from("CPaceRistretto255");
/** SHA-512's input block size, which the generator string pads to. */
const S_IN_BYTES = 128;
const POINT_BYTES = 32;

/** A code as typed: the room's number and the words, each the full word from the list. */
export interface PairingCode { room: number; words: string[] }

const byPrefix = new Map(WORDS.map((word) => [word.slice(0, 4), word]));
const wordSet = new Set(WORDS);

/** Whether an argument looks like a pairing code rather than an invite. */
export function isPairingCode(text: string): boolean { return /^\s*\d/.test(text); }

export function formatCode(code: PairingCode): string { return [String(code.room), ...code.words].join("-"); }

/** Three random words from the list. */
export function randomWords(): string[] { return Array.from({ length: CODE_WORDS }, () => WORDS[randomInt(WORDS.length)]!); }

/**
 * The code in `parts`, as typed: dashes or spaces between its parts, any case, and the
 * first four letters of each word are enough. A word not on the list is refused here,
 * before anything is sent, so a typo costs nothing.
 */
export function parseCode(parts: string | readonly string[]): PairingCode {
  const tokens = (typeof parts === "string" ? [parts] : parts).join(" ").trim().toLowerCase().split(/[\s\-_.,]+/).filter(Boolean);
  const usage = "A pairing code is a number and three words, such as 42-orbit-canyon-velvet. Type the code cns pair shows on the other device.";
  if (!tokens.length || !/^[1-9][0-9]{0,5}$/.test(tokens[0]!)) throw new Error(usage);
  const words = tokens.slice(1);
  if (words.length !== CODE_WORDS) throw new Error(usage);
  return {
    room: Number(tokens[0]),
    words: words.map((typed) => {
      const word = wordSet.has(typed) ? typed : typed.length >= 4 ? byPrefix.get(typed.slice(0, 4)) : undefined;
      if (!word) throw new Error(`"${printable(typed).slice(0, 32)}" is not a word cns uses in pairing codes. Check the code on the other device; the first four letters of each word are enough.`);
      return word;
    }),
  };
}

// CPace, as draft-irtf-cfrg-cpace specifies it for ristretto255 and SHA-512.

/** The input with its length in front, as LEB128. */
export function prependLen(data: Uint8Array): Buffer {
  const length: number[] = [];
  let remaining = data.length;
  do {
    length.push(remaining < 128 ? remaining : (remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  } while (remaining);
  return Buffer.concat([Buffer.from(length), data]);
}
export function lvCat(...parts: Uint8Array[]): Buffer { return Buffer.concat(parts.map(prependLen)); }

export function generatorString(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Buffer {
  const zeroPad = Math.max(0, S_IN_BYTES - 1 - prependLen(prs).length - prependLen(DSI).length);
  return lvCat(DSI, prs, Buffer.alloc(zeroPad), ci, sid);
}

/** The generator for this password, channel and session: ristretto255's element derivation of SHA-512 of the generator string. */
export function calculateGenerator(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Uint8Array {
  return sodium.crypto_core_ristretto255_from_hash(createHash("sha512").update(generatorString(prs, ci, sid)).digest());
}

/** A random scalar: 32 random bytes with the bits above 252 cleared, as the draft recommends. */
export function sampleScalar(): Uint8Array {
  for (;;) {
    const scalar = randomBytes(32);
    scalar[31]! &= 0x0f;
    if (scalar.some((byte) => byte !== 0)) return scalar;
  }
}

export function scalarMult(scalar: Uint8Array, point: Uint8Array): Uint8Array { return sodium.crypto_scalarmult_ristretto255(scalar, point); }

/** scalar * point, or undefined when the point is not a valid encoding or the result is the identity: the exchange must then end. */
export function scalarMultVfy(scalar: Uint8Array, point: Uint8Array): Uint8Array | undefined {
  if (point.length !== POINT_BYTES || !sodium.crypto_core_ristretto255_is_valid_point(point)) return undefined;
  // libsodium refuses an identity result, which the draft's abort condition asks for.
  try { return sodium.crypto_scalarmult_ristretto255(scalar, point); } catch { return undefined; }
}

/** The intermediate session key, in the initiator-responder setting: H(lv_cat(DSI_ISK, sid, K) || lv_cat(Ya, ADa) || lv_cat(Yb, ADb)). */
export function intermediateKey(sid: Uint8Array, k: Uint8Array, ya: Uint8Array, ada: Uint8Array, yb: Uint8Array, adb: Uint8Array): Buffer {
  return createHash("sha512").update(lvCat(Buffer.concat([DSI, Buffer.from("_ISK")]), sid, k)).update(lvCat(ya, ada)).update(lvCat(yb, adb)).digest();
}

const EMPTY = new Uint8Array(0);

/** The keys both sides derive from one exchange: tags confirming each side's message (draft section 10.4), and the key the invite is sealed with. */
function sessionKeys(sid: Uint8Array, k: Uint8Array, ya: Uint8Array, yb: Uint8Array) {
  const isk = intermediateKey(sid, k, ya, EMPTY, yb, EMPTY);
  const macKey = createHash("sha512").update("CPaceMac").update(sid).update(isk).digest();
  return {
    hostTag: createHmac("sha512", macKey).update(lvCat(ya, EMPTY)).digest(),
    guestTag: createHmac("sha512", macKey).update(lvCat(yb, EMPTY)).digest(),
    boxKey: new Uint8Array(hkdfSync("sha256", isk, sid, `${PROTOCOL} invite`, sodium.crypto_secretbox_KEYBYTES)),
  };
}

/** What both sides bind the exchange to: the protocol, the relay as dialed, and the room. */
function channelId(relay: string, room: number): Buffer {
  return lvCat(Buffer.from(PROTOCOL), Buffer.from(new URL(roomEndpoint(relay)).host.toLowerCase()), Buffer.from(String(room)));
}
const password = (words: readonly string[]) => Buffer.from(words.join("-"));

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const bytesOf = (length?: number) => z.string().regex(/^[A-Za-z0-9_-]+$/).max(MAX_ROOM_MESSAGE_BYTES).transform((value) => new Uint8Array(Buffer.from(value, "base64url")))
  .refine((value) => length === undefined || value.length === length);
const helloSchema = z.strictObject({ t: z.literal("hello"), v: z.literal(1), sid: bytesOf(16), y: bytesOf(POINT_BYTES) });
const replySchema = z.strictObject({ t: z.literal("reply"), y: bytesOf(POINT_BYTES), tag: bytesOf(64) });
const hostAnswerSchema = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("invite"), tag: bytesOf(64), nonce: bytesOf(24), box: bytesOf() }),
  z.strictObject({ t: z.literal("wrong"), left: z.int().min(0).max(MAX_WRONG_CODES) }),
]);
const relayToHostSchema = z.discriminatedUnion("t", [
  z.strictObject({ t: z.literal("room"), room: z.int().min(1).max(999_999) }),
  z.strictObject({ t: z.literal("guest") }),
  z.strictObject({ t: z.literal("msg"), m: z.string().max(MAX_ROOM_MESSAGE_BYTES) }),
  z.strictObject({ t: z.literal("left") }),
  z.strictObject({ t: z.literal("pong") }),
]);

function parseJson<T extends z.ZodType>(schema: T, text: unknown): z.infer<T> | undefined {
  if (typeof text !== "string" || text.length > MAX_ROOM_MESSAGE_BYTES * 2) return undefined;
  try { const parsed = schema.safeParse(JSON.parse(text)); return parsed.success ? parsed.data : undefined; } catch { return undefined; }
}

/** Why a code did not work. `code` is stable for exit statuses. */
export class PairingCodeError extends Error {
  constructor(readonly code: "wrong" | "unknown" | "busy" | "expired" | "relay", message: string) {
    super(message);
    this.name = "PairingCodeError";
  }
}

/** Messages from a socket, one at a time, and how it closed. */
function inbox(socket: WebSocket) {
  const queue: unknown[] = [];
  let closed: { code: number; reason: string } | undefined;
  let wake: (() => void) | undefined;
  socket.addEventListener("message", (event) => { queue.push((event as MessageEvent).data); wake?.(); });
  socket.addEventListener("close", (event) => { closed = { code: (event as CloseEvent).code, reason: (event as CloseEvent).reason }; wake?.(); });
  return {
    /** The next message; undefined once the socket closed with nothing left to read. */
    async next(signal: AbortSignal): Promise<unknown> {
      for (;;) {
        if (queue.length) return queue.shift();
        if (closed) return undefined;
        if (signal.aborted) throw signal.reason;
        await new Promise<void>((resolve) => {
          const done = () => { signal.removeEventListener("abort", done); wake = undefined; resolve(); };
          wake = done;
          signal.addEventListener("abort", done, { once: true });
        });
      }
    },
    get closed() { return closed; },
  };
}

export interface HostedCode {
  /** The code to show, such as 42-orbit-canyon-velvet. */
  code: string;
  /**
   * Resolves once a device that knew the code has the invite. Rejects with a
   * PairingCodeError when the code stops working: too many wrong codes, or the room lost.
   */
  delivered: Promise<void>;
  /** End the room; the code stops working. */
  close(): void;
}

export interface HostEvents {
  /** A device sent a wrong code; `tries` wrong ones so far. */
  wrong?(tries: number): void;
}

/** Open a room at `relay` for `inviteText` and return its code; the room serves guests until the invite is delivered or it is closed. */
export async function hostCode(relay: string, inviteText: string, events: HostEvents = {}, signal = AbortSignal.timeout(ROOM_GUEST_MS)): Promise<HostedCode> {
  await sodium.ready;
  if (!inviteText.startsWith(INVITE_PREFIX)) throw new Error("Only a cns1: invite can be sent with a pairing code.");
  const socket = await openSocket(roomEndpoint(relay), signal);
  const messages = inbox(socket);
  const first = parseJson(relayToHostSchema, await messages.next(signal).catch((error: unknown) => { closeSocket(socket); throw error; }));
  if (first?.t !== "room") {
    closeSocket(socket);
    throw new PairingCodeError("relay", messages.closed?.reason ? `The relay refused a pairing code: ${printable(messages.closed.reason)}` : "The relay did not give a pairing code.");
  }
  const room = first.room;
  const words = randomWords();
  const ci = channelId(relay, room);
  const prs = password(words);
  const stop = new AbortController();
  const ping = setInterval(() => { try { socket.send(JSON.stringify({ t: "ping" })); } catch { /* Closing. */ } }, ROOM_PING_MS);
  const send = (value: unknown) => socket.send(JSON.stringify(value));
  const endGuest = (reason: string) => send({ t: "end", reason });

  const delivered = (async () => {
    let wrong = 0;
    /** The exchange with the current guest: this side's scalar, share and session id. */
    let attempt: { scalar: Uint8Array; share: Uint8Array; sid: Uint8Array } | undefined;
    try {
      for (;;) {
        const raw = await messages.next(stop.signal);
        if (raw === undefined) {
          const reason = messages.closed?.reason ? `: ${printable(messages.closed.reason)}` : "";
          throw new PairingCodeError("relay", `Lost the relay connection, so the code no longer works${reason}.`);
        }
        const message = parseJson(relayToHostSchema, raw);
        if (!message || message.t === "pong" || message.t === "room") continue;
        if (message.t === "left") { attempt = undefined; continue; }
        if (message.t === "guest") {
          const sid = randomBytes(16);
          const scalar = sampleScalar();
          const share = scalarMult(scalar, calculateGenerator(prs, ci, sid));
          attempt = { scalar, share, sid };
          send({ t: "send", m: JSON.stringify({ t: "hello", v: 1, sid: b64(sid), y: b64(share) }) });
          continue;
        }
        // A guest's message: its reply to this attempt's hello, or nothing this side reads.
        const reply = parseJson(replySchema, message.m);
        const current = attempt;
        attempt = undefined;
        if (!current || !reply) { endGuest("That was not a pairing code reply."); continue; }
        const k = scalarMultVfy(current.scalar, reply.y);
        const keys = k ? sessionKeys(current.sid, k, current.share, reply.y) : undefined;
        if (!keys || !timingSafeEqual(Buffer.from(reply.tag), keys.guestTag)) {
          wrong++;
          events.wrong?.(wrong);
          send({ t: "send", m: JSON.stringify({ t: "wrong", left: MAX_WRONG_CODES - wrong }) });
          endGuest("Wrong pairing code.");
          if (wrong >= MAX_WRONG_CODES) throw new PairingCodeError("wrong", `The code was typed wrong ${MAX_WRONG_CODES} times, so it no longer works. Run cns pair again for a new code. If nobody here mistyped it, someone else tried to use it.`);
          continue;
        }
        const nonce = randomBytes(sodium.crypto_secretbox_NONCEBYTES);
        const box = sodium.crypto_secretbox_easy(Buffer.from(inviteText), nonce, keys.boxKey);
        send({ t: "send", m: JSON.stringify({ t: "invite", tag: b64(keys.hostTag), nonce: b64(nonce), box: b64(box) }) });
        return;
      }
    } finally {
      clearInterval(ping);
      // The invite has gone, or the code is dead: either way the room ends.
      closeSocket(socket, "Pairing code finished");
    }
  })();
  // A caller that closed the room on purpose does not see that as a failure.
  let closedOnPurpose = false;
  const settled = delivered.catch((error: unknown) => { if (!closedOnPurpose) throw error; });
  // Handled here so a caller that looks later still sees the failure, without it counting as unhandled meanwhile.
  settled.catch(() => {});
  return {
    code: formatCode({ room, words }),
    delivered: settled,
    close() { closedOnPurpose = true; stop.abort(new Error("Closed.")); },
  };
}

/** Join the room of `code` at `relay` and get the invite it guards. */
export async function inviteForCode(relay: string, code: PairingCode, signal = AbortSignal.timeout(ROOM_GUEST_MS + 5_000)): Promise<string> {
  await sodium.ready;
  let socket: WebSocket;
  try { socket = await openSocket(roomEndpoint(relay, code.room), signal); }
  catch (error) { throw new PairingCodeError("relay", `Cannot reach the relay to exchange the pairing code: ${(error as Error).message}`); }
  const messages = inbox(socket);
  const refused = (): never => {
    const closed = messages.closed;
    const reason = closed?.reason ? printable(closed.reason) : "the relay closed the connection.";
    if (closed?.code === 4004) throw new PairingCodeError("unknown", `No device is showing code ${formatCode(code)}: it may have expired, been used or been mistyped. Run cns pair on the other device for a new code.`);
    if (closed?.code === 4009) throw new PairingCodeError("busy", reason);
    if (signal.aborted) throw new PairingCodeError("expired", "The other device did not answer in time. Check that cns pair still waits there, then try again.");
    throw new PairingCodeError("relay", `The pairing code exchange ended: ${reason}`);
  };
  try {
    const hello = parseJson(helloSchema, await messages.next(signal).catch(() => undefined));
    if (!hello) return refused();
    const ci = channelId(relay, code.room);
    const scalar = sampleScalar();
    const share = scalarMult(scalar, calculateGenerator(password(code.words), ci, hello.sid));
    const k = scalarMultVfy(scalar, hello.y);
    if (!k) throw new PairingCodeError("relay", "The other device sent an invalid pairing message.");
    const keys = sessionKeys(hello.sid, k, hello.y, share);
    socket.send(JSON.stringify({ t: "reply", y: b64(share), tag: b64(keys.guestTag) }));
    const answer = parseJson(hostAnswerSchema, await messages.next(signal).catch(() => undefined));
    if (!answer) return refused();
    if (answer.t === "wrong") {
      throw new PairingCodeError("wrong", answer.left
        ? `The code is wrong. Check the words on the other device and try again (${answer.left} ${answer.left === 1 ? "try" : "tries"} left).`
        : "The code is wrong, and that was its last try. Run cns pair on the other device for a new code.");
    }
    if (!timingSafeEqual(Buffer.from(answer.tag), keys.hostTag)) throw new PairingCodeError("wrong", "The other device could not prove it knows the code. Run cns pair there for a new code.");
    let opened: Uint8Array;
    try { opened = sodium.crypto_secretbox_open_easy(answer.box, answer.nonce, keys.boxKey); }
    catch { throw new PairingCodeError("wrong", "The invite did not open with this code. Run cns pair on the other device for a new code."); }
    const text = Buffer.from(opened).toString("utf8");
    if (!text.startsWith(INVITE_PREFIX)) throw new PairingCodeError("relay", "The other device sent something other than an invite.");
    return text;
  } finally {
    closeSocket(socket, "Pairing code finished");
  }
}
