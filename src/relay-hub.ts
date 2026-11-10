/**
 * The relay: a meeting point for paired devices that cannot reach each other directly.
 * It forwards the messages of encrypted links (secure.ts) without being able to read
 * them, and it needs no account: a device proves its identity to register.
 *
 *   GET /v1/accept/KEY      A daemon registers for its key. The relay sends a challenge:
 *                             relay -> { t: "challenge", nonce }
 *                             daemon -> { t: "proof", sig }     Ed25519 over the challenge, see challengeBytes
 *                             relay -> { t: "ready" }, later { t: "incoming", id } per dialer, { t: "pong" }
 *   GET /v1/dial/KEY        A device dials the daemon registered for KEY. The relay asks it to
 *                           answer and holds the dialer's first messages until it does.
 *   GET /v1/answer/KEY/ID   The daemon answers one dialer; the relay then forwards both ways.
 *   GET /v1/room            A device showing a pairing code opens a room; the relay gives it a number.
 *   GET /v1/room/N          A device given that code joins room N, one at a time; see PairingRooms.
 *
 * Every request must come from the cns binary: it carries the Cns-Client header, an HMAC
 * of the request under a client key built into cns (see clientProof). Anything else is
 * refused before it reaches a room. That key ships in every copy of cns, so it keeps out
 * other programs, not a determined person; docs/adr/0001-built-in-relay.md says why that
 * is enough and what would be stronger. Links stay authenticated end to end whatever the
 * relay does.
 *
 * This file uses only WebCrypto and WebSocket-like objects, so the Cloudflare Worker
 * (relay/worker.ts) and the Bun relay the tests run (relay-server.ts) share the same code.
 */

export const RELAY_PROTOCOL = "cns-relay-1";
/** Dialers waiting for, or connected through, one registered daemon. */
export const MAX_PIPES_PER_KEY = 32;
/** How long a dialer waits for the daemon to answer. */
export const ANSWER_MS = 10_000;
/** How long a registering daemon has to answer the challenge. */
export const CHALLENGE_MS = 10_000;
/** What the relay holds for a dialer before the daemon answers. */
export const MAX_HELD_MESSAGES = 16;
export const MAX_HELD_BYTES = 256 * 1024;
/** Dialers from one address to one key at once, so nobody can fill a key's pipes alone. */
export const MAX_DIALS_PER_ADDRESS = 8;
/** Messages larger than this are refused; encrypted links send 64 KiB records. */
export const MAX_RELAY_MESSAGE_BYTES = 1024 * 1024;

export type RelayData = string | ArrayBuffer | Uint8Array;
/** The side of a WebSocket the relay holds. */
export interface RelaySocket {
  send(data: RelayData): void;
  close(code: number, reason: string): void;
}
/** What the runtime calls on the relay for one accepted socket. */
export interface RelayHandlers {
  message(data: RelayData): void;
  close(): void;
}

const encoder = new TextEncoder();
const keyPattern = /^[A-Za-z0-9_-]{43}$/;
const idPattern = /^[A-Za-z0-9_-]{22}$/;
const roomPattern = /^[1-9][0-9]{0,5}$/;

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
export function size(data: RelayData): number { return typeof data === "string" ? encoder.encode(data).length : data.byteLength; }
export const randomId = () => base64url(crypto.getRandomValues(new Uint8Array(16)));

/**
 * What a registering daemon signs: SHA-256 over the protocol name, the relay's host as
 * the daemon dialed it, its own key and the relay's nonce. Binding the host means a
 * proof made for one relay cannot be replayed to register at another.
 */
export async function challengeBytes(host: string, key: string, nonce: string): Promise<Uint8Array<ArrayBuffer>> {
  const parts = [encoder.encode(RELAY_PROTOCOL), new Uint8Array([0]), encoder.encode(host.toLowerCase()), new Uint8Array([0]), fromBase64url(key), fromBase64url(nonce)];
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) { joined.set(part, offset); offset += part.length; }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", joined));
}

/** Whether `sig` is the daemon with `key` signing this relay's challenge. */
export async function verifyProof(host: string, key: string, nonce: string, sig: string): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey("raw", fromBase64url(key), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, publicKey, fromBase64url(sig), await challengeBytes(host, key, nonce));
  } catch { return false; }
}

/** The request header that shows a request comes from cns. */
export const CLIENT_HEADER = "Cns-Client";
/**
 * The client key built into cns. Every copy of cns carries it, so it identifies the
 * program, not a person, and anyone who takes cns apart can use it: it keeps other
 * programs off the relay, not a determined person (docs/adr/0001-built-in-relay.md).
 * To rotate it, add a new key, release cns with it, and drop the old one from
 * ACCEPTED_CLIENT_KEYS once those releases are no longer in use.
 */
export const CLIENT_KEY = "yoWi1vx4unhXq7psUZ5NiD78vsTdctrQ8_1wJq3a5VU";
/** The client keys the relay accepts. */
export const ACCEPTED_CLIENT_KEYS: readonly string[] = [CLIENT_KEY];
/** How far a client's clock may be from the relay's. */
export const CLIENT_SKEW_MS = 60 * 60 * 1000;
const CLIENT_SCHEME = "cns-client-1";

function clientBytes(host: string, path: string, time: number, nonce: string): Uint8Array<ArrayBuffer> {
  return encoder.encode([CLIENT_SCHEME, host.toLowerCase(), path, String(time), nonce].join("\0"));
}
const hmacKey = (key: string, usage: "sign" | "verify") => crypto.subtle.importKey("raw", fromBase64url(key), { name: "HMAC", hash: "SHA-256" }, false, [usage]);

/**
 * The Cns-Client header for a request to `url`: `cns-client-1 TIME NONCE MAC`, where MAC is
 * HMAC-SHA256 under the client key over the relay's host as dialed, the path, the time in
 * seconds and a random nonce. Binding the host and path means a header seen for one request
 * does not open another, and the time means it stops working within CLIENT_SKEW_MS.
 */
export async function clientProof(url: string, key = CLIENT_KEY, now = Date.now()): Promise<string> {
  const { host, pathname } = new URL(url);
  const time = Math.floor(now / 1000);
  const nonce = randomId();
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(key, "sign"), clientBytes(host, pathname, time, nonce)));
  return `${CLIENT_SCHEME} ${time} ${nonce} ${base64url(mac)}`;
}

/** Whether `header` shows that the request for `host` and `path` comes from cns: a MAC under an accepted key, made within CLIENT_SKEW_MS of `now`. */
export async function verifyClient(header: string | null | undefined, host: string, path: string, keys: readonly string[] = ACCEPTED_CLIENT_KEYS, now = Date.now()): Promise<boolean> {
  if (!header || header.length > 256) return false;
  const [scheme, timeText, nonce, mac, ...rest] = header.split(" ");
  if (scheme !== CLIENT_SCHEME || rest.length || !timeText || !/^\d{1,12}$/.test(timeText) || !nonce || !idPattern.test(nonce) || !mac || !keyPattern.test(mac)) return false;
  const time = Number(timeText);
  if (Math.abs(now - time * 1000) > CLIENT_SKEW_MS) return false;
  const data = clientBytes(host, path, time, nonce);
  for (const key of keys) {
    // subtle.verify compares in constant time.
    try { if (await crypto.subtle.verify("HMAC", await hmacKey(key, "verify"), fromBase64url(mac), data)) return true; } catch { /* Not this key. */ }
  }
  return false;
}

function json(socket: RelaySocket, value: unknown) { try { socket.send(JSON.stringify(value)); } catch { /* Gone. */ } }
function safeClose(socket: RelaySocket, code: number, reason: string) { try { socket.close(code, reason); } catch { /* Already closed. */ } }

interface Pipe { dialer: RelaySocket; address: string; answer?: RelaySocket; held: RelayData[]; heldBytes: number; timer?: ReturnType<typeof setTimeout> }

/**
 * Everything the relay knows about one key: its registered daemon, if any, and the
 * dialers waiting for or connected to it. A Cloudflare Durable Object holds one room;
 * `cns relay` holds one per key in memory.
 */
export class RelayRoom {
  #key: string;
  #host: string;
  #listener?: RelaySocket;
  #pipes = new Map<string, Pipe>();
  constructor(key: string, host: string) {
    this.#key = key;
    this.#host = host;
  }
  get listening(): boolean { return this.#listener !== undefined; }
  get pipes(): number { return this.#pipes.size; }

  /**
   * A daemon registering for this key. It is only listening once it has proved the key
   * for `host`, the name devices use for this relay (by default the room's).
   */
  listen(socket: RelaySocket, host = this.#host): RelayHandlers {
    const nonce = randomId();
    let proved = false;
    let checking = false;
    let closed = false;
    const timer = setTimeout(() => { if (!proved) safeClose(socket, 4008, "No proof of the key in time."); }, CHALLENGE_MS);
    json(socket, { t: "challenge", nonce });
    return {
      message: (data) => {
        if (typeof data !== "string" || size(data) > 4096) { safeClose(socket, 4008, "Invalid relay message."); return; }
        let message: { t?: unknown; sig?: unknown };
        try { message = JSON.parse(data); } catch { safeClose(socket, 4008, "Invalid relay message."); return; }
        if (proved) {
          if (message.t === "ping") json(socket, { t: "pong" });
          return;
        }
        if (message.t !== "proof" || typeof message.sig !== "string" || checking) { safeClose(socket, 4008, "Invalid relay message."); return; }
        checking = true;
        void verifyProof(host, this.#key, nonce, message.sig).then((ok) => {
          clearTimeout(timer);
          // A socket that left while its proof was checked must not displace the live one.
          if (closed) return;
          if (!ok) { safeClose(socket, 4003, "The proof does not match the key."); return; }
          proved = true;
          // The newest registration wins: it is the daemon that restarted.
          if (this.#listener && this.#listener !== socket) safeClose(this.#listener, 4000, "Another daemon registered for this key.");
          this.#listener = socket;
          json(socket, { t: "ready" });
        });
      },
      close: () => {
        closed = true;
        clearTimeout(timer);
        if (this.#listener !== socket) return;
        this.#listener = undefined;
        // Dialers still waiting for an answer will not get one.
        for (const [id, pipe] of this.#pipes) {
          if (pipe.answer) continue;
          this.#drop(id, 4004, "The device left the relay.");
        }
      },
    };
  }

  /** Whether a dialer from `address` could be taken now; check before accepting its socket. */
  dialable(address = ""): { ok: true } | { ok: false; status: number; reason: string } {
    if (!this.#listener) return { ok: false, status: 404, reason: "No device with this key is registered at this relay." };
    if (this.#pipes.size >= MAX_PIPES_PER_KEY) return { ok: false, status: 503, reason: "Too many connections to this device through the relay." };
    if (address && [...this.#pipes.values()].filter((pipe) => pipe.address === address).length >= MAX_DIALS_PER_ADDRESS) {
      return { ok: false, status: 429, reason: "Too many connections to this device from this address." };
    }
    return { ok: true };
  }

  /** A device dialing this key from `address`. Its messages are held until the daemon answers. */
  dial(socket: RelaySocket, address = ""): RelayHandlers {
    const check = this.dialable(address);
    if (!check.ok) {
      safeClose(socket, 4004, check.reason);
      return { message() {}, close() {} };
    }
    const id = randomId();
    const pipe: Pipe = { dialer: socket, address, held: [], heldBytes: 0 };
    pipe.timer = setTimeout(() => this.#drop(id, 4004, "The device did not answer through the relay."), ANSWER_MS);
    this.#pipes.set(id, pipe);
    try { this.#listener!.send(JSON.stringify({ t: "incoming", id })); }
    catch { this.#drop(id, 4004, "The device's relay connection failed."); }
    return {
      message: (data) => {
        if (size(data) > MAX_RELAY_MESSAGE_BYTES) { this.#drop(id, 4009, "Message too large for the relay."); return; }
        if (pipe.answer) { try { pipe.answer.send(data); } catch { this.#drop(id, 4000, "The device's connection failed."); } return; }
        pipe.held.push(data);
        pipe.heldBytes += size(data);
        if (pipe.held.length > MAX_HELD_MESSAGES || pipe.heldBytes > MAX_HELD_BYTES) this.#drop(id, 4009, "Too much sent before the device answered.");
      },
      close: () => this.#drop(id, 1000, "The other side closed the connection."),
    };
  }

  /** The registered daemon answering dialer `id`; from now on the relay forwards both ways. */
  answer(id: string, socket: RelaySocket): RelayHandlers {
    const pipe = idPattern.test(id) ? this.#pipes.get(id) : undefined;
    if (!pipe || pipe.answer) {
      safeClose(socket, 4004, "No dialer is waiting with this id.");
      return { message() {}, close() {} };
    }
    clearTimeout(pipe.timer);
    pipe.answer = socket;
    for (const data of pipe.held.splice(0)) socket.send(data);
    pipe.heldBytes = 0;
    return {
      message: (data) => {
        if (size(data) > MAX_RELAY_MESSAGE_BYTES) { this.#drop(id, 4009, "Message too large for the relay."); return; }
        try { pipe.dialer.send(data); } catch { this.#drop(id, 4000, "The dialer's connection failed."); }
      },
      close: () => this.#drop(id, 1000, "The other side closed the connection."),
    };
  }

  #drop(id: string, code: number, reason: string) {
    const pipe = this.#pipes.get(id);
    if (!pipe) return;
    this.#pipes.delete(id);
    clearTimeout(pipe.timer);
    safeClose(pipe.dialer, code, reason);
    if (pipe.answer) safeClose(pipe.answer, code, reason);
  }
}

/** How long a device that joined a pairing room has to finish the code exchange. */
export const ROOM_GUEST_MS = 15_000;
/** How long a pairing room stays open at most: as long as the longest invite. */
export const ROOM_MS = 60 * 60 * 1000;
/** A room's number is not given out again for this long after it closes, so a late guest does not reach a newer room. */
export const ROOM_REUSE_MS = 2 * 60 * 1000;
/** Messages in a pairing room are small: two points, two tags and a sealed invite. */
export const MAX_ROOM_MESSAGE_BYTES = 64 * 1024;
/** Rooms open at once, and guests one address may hold at once across all rooms. */
export const MAX_ROOMS = 10_000;
export const MAX_GUESTS_PER_ADDRESS = 4;

interface Guest { socket: RelaySocket; address: string; timer: ReturnType<typeof setTimeout> }
interface Room { host: RelaySocket; timer: ReturnType<typeof setTimeout>; guest?: Guest }

/**
 * Rooms where two devices exchange a pairing code (src/pairing-code.ts). The device that
 * shows the code opens a room and gets its number; a device given the code joins it by
 * number. The relay pipes their messages and nothing else: the code itself never reaches
 * it, and what passes through is a password-authenticated key exchange and an invite
 * sealed under its key. One guest at a time, for ROOM_GUEST_MS; the host decides whether
 * a guest knew the code and ends it either way.
 *
 *   host  -> relay: { t: "send", m }   m goes to the guest as it is
 *                   { t: "end", reason } the guest is closed
 *                   { t: "ping" }       answered with { t: "pong" }
 *   relay -> host:  { t: "room", room } once; then { t: "guest" }, { t: "msg", m } for each guest message, { t: "left" }
 *   guest <-> relay: the host's messages and the guest's own, as text
 *
 * The Worker (relay/worker.ts) runs one instance in a Durable Object and the Bun relay one
 * in memory, so both behave the same.
 */
export class PairingRooms {
  #rooms = new Map<number, Room>();
  #released = new Map<number, number>();
  get size(): number { return this.#rooms.size; }

  /** The lowest number not in use and not closed within ROOM_REUSE_MS. */
  #free(now: number): number {
    for (const [room, at] of this.#released) if (now - at >= ROOM_REUSE_MS) this.#released.delete(room);
    for (let room = 1; ; room++) if (!this.#rooms.has(room) && !this.#released.has(room)) return room;
  }

  /** A device that shows a code opening a room. */
  open(socket: RelaySocket, now = Date.now()): RelayHandlers {
    if (this.#rooms.size >= MAX_ROOMS) {
      safeClose(socket, 4029, "The relay has too many pairing codes open. Try again later.");
      return { message() {}, close() {} };
    }
    const number = this.#free(now);
    const room: Room = { host: socket, timer: setTimeout(() => this.#close(number, room, 4000, "The pairing code expired."), ROOM_MS) };
    this.#rooms.set(number, room);
    json(socket, { t: "room", room: number });
    return {
      message: (data) => {
        if (this.#rooms.get(number) !== room) return;
        const message = parseRoomMessage(data);
        if (!message) { this.#close(number, room, 4008, "Invalid relay message."); return; }
        if (message.t === "ping") { json(socket, { t: "pong" }); return; }
        if (message.t === "send" && typeof message.m === "string") {
          if (room.guest) { try { room.guest.socket.send(message.m); } catch { this.#endGuest(room, 4000, "The connection failed."); } }
          return;
        }
        if (message.t === "end") {
          this.#endGuest(room, 4001, typeof message.reason === "string" ? message.reason.slice(0, 120) : "The other device ended the exchange.");
          return;
        }
        this.#close(number, room, 4008, "Invalid relay message.");
      },
      close: () => this.#close(number, room, 4004, "The device showing this code is gone."),
    };
  }

  /** Whether a device from `address` could join room `number` now, and why not. */
  joinable(number: number, address = ""): { ok: true } | { ok: false; code: number; reason: string } {
    const room = this.#rooms.get(number);
    if (!room) return { ok: false, code: 4004, reason: "No device is showing this code. It may have expired or been used: run cns pair on the other device for a new one." };
    if (room.guest) return { ok: false, code: 4009, reason: "Another device is using this code right now. Try again in a few seconds." };
    if (address && [...this.#rooms.values()].filter((other) => other.guest?.address === address).length >= MAX_GUESTS_PER_ADDRESS) {
      return { ok: false, code: 4029, reason: "Too many pairing codes in use from this address." };
    }
    return { ok: true };
  }

  /** A device given the code joining room `number` from `address`. */
  join(number: number, socket: RelaySocket, address = ""): RelayHandlers {
    const check = this.joinable(number, address);
    if (!check.ok) {
      safeClose(socket, check.code, check.reason);
      return { message() {}, close() {} };
    }
    const room = this.#rooms.get(number)!;
    const guest: Guest = { socket, address, timer: setTimeout(() => this.#endGuest(room, 4008, "The code exchange took too long."), ROOM_GUEST_MS) };
    room.guest = guest;
    json(room.host, { t: "guest" });
    return {
      message: (data) => {
        if (room.guest !== guest) return;
        if (typeof data !== "string" || size(data) > MAX_ROOM_MESSAGE_BYTES) { this.#endGuest(room, 4008, "Invalid relay message."); return; }
        json(room.host, { t: "msg", m: data });
      },
      close: () => {
        if (room.guest !== guest) return;
        clearTimeout(guest.timer);
        room.guest = undefined;
        if (this.#rooms.get(number) === room) json(room.host, { t: "left" });
      },
    };
  }

  #endGuest(room: Room, code: number, reason: string) {
    const guest = room.guest;
    if (!guest) return;
    clearTimeout(guest.timer);
    room.guest = undefined;
    safeClose(guest.socket, code, reason);
    json(room.host, { t: "left" });
  }

  #close(number: number, room: Room, code: number, reason: string) {
    if (this.#rooms.get(number) !== room) return;
    this.#rooms.delete(number);
    this.#released.set(number, Date.now());
    clearTimeout(room.timer);
    if (room.guest) {
      clearTimeout(room.guest.timer);
      safeClose(room.guest.socket, code === 4008 ? 4004 : code, reason);
      room.guest = undefined;
    }
    safeClose(room.host, code, reason);
  }
}

function parseRoomMessage(data: RelayData): { t?: unknown; m?: unknown; reason?: unknown } | undefined {
  if (typeof data !== "string" || size(data) > MAX_ROOM_MESSAGE_BYTES + 1024) return undefined;
  try {
    const value: unknown = JSON.parse(data);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
  } catch { return undefined; }
}

/** A request the relay understands, from its path and query. */
export type RelayRoute =
  | { kind: "accept"; key: string }
  | { kind: "dial"; key: string }
  | { kind: "answer"; key: string; id: string }
  | { kind: "room" }
  | { kind: "join"; room: number }
  | { kind: "health" };

/**
 * Parse a relay request; undefined for anything else. The built-in relay is served under
 * /relay on its host (src/relay-config.ts); the same paths also work at the root, as on
 * the Worker's workers.dev address and the Bun relay the tests run.
 */
export function route(url: URL): RelayRoute | undefined {
  let parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "relay") parts = parts.slice(1);
  if (!parts.length) return { kind: "health" };
  if (parts[0] !== "v1") return undefined;
  if (parts[1] === "room") {
    if (parts.length === 2) return { kind: "room" };
    if (parts.length === 3 && roomPattern.test(parts[2]!)) return { kind: "join", room: Number(parts[2]) };
    return undefined;
  }
  const [, kind, key, id] = parts;
  if (!key || !keyPattern.test(key)) return undefined;
  if (kind === "accept" && parts.length === 3) return { kind, key };
  if (kind === "dial" && parts.length === 3) return { kind, key };
  if (kind === "answer" && parts.length === 4 && id && idPattern.test(id)) return { kind, key, id };
  return undefined;
}

/** The relay endpoint for `kind`, from a relay's base URL (ws://, wss://, http:// or https://, with an optional path prefix). */
export function relayEndpoint(base: string, kind: "accept" | "dial" | "answer", key: string, id?: string): string {
  const url = new URL(base);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("A relay URL starts with wss://, ws://, https:// or http://.");
  if (url.username || url.password || url.search || url.hash) throw new Error("A relay URL has no credentials, query or fragment.");
  const prefix = url.pathname.replace(/\/+$/, "");
  url.pathname = `${prefix}/v1/${kind}/${key}${id ? `/${id}` : ""}`;
  return url.href;
}

/** The relay endpoint for pairing codes: opening a room, or with `room`, joining it. */
export function roomEndpoint(base: string, room?: number): string {
  const url = new URL(relayEndpoint(base, "accept", "A".repeat(43)));
  url.pathname = url.pathname.replace(/\/v1\/accept\/[A-Za-z0-9_-]{43}$/, `/v1/room${room === undefined ? "" : `/${room}`}`);
  return url.href;
}

/** Whether a URL is a request to a relay: registering, dialing, answering, or a pairing room. */
export function isRelayRequest(address: string): boolean {
  try {
    const { pathname } = new URL(address);
    return /\/v1\/(accept|dial|answer)\/[A-Za-z0-9_-]{43}(\/[A-Za-z0-9_-]{22})?\/?$/.test(pathname) || /\/v1\/room(\/[1-9][0-9]{0,5})?\/?$/.test(pathname);
  } catch { return false; }
}

/** Whether a saved address reaches a device through a relay rather than directly. */
export function isRelayAddress(address: string): boolean {
  try { return /\/v1\/dial\/[A-Za-z0-9_-]{43}\/?$/.test(new URL(address).pathname); } catch { return false; }
}

/**
 * The addresses to dial a paired device at: its saved ones and, when none of them is a
 * relay but this device has one, that relay too. Devices that share a relay reach each
 * other there even when the record was saved before the other device had the relay.
 */
export function dialAddresses(peer: { publicKey: string; addresses: readonly string[] }, relay: string | undefined): string[] {
  if (!relay || peer.addresses.some(isRelayAddress)) return [...peer.addresses];
  return [...peer.addresses, relayEndpoint(relay, "dial", peer.publicKey)];
}
