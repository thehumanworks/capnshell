import sodium from "libsodium-wrappers";
import { RpcSession, type RpcStub, type RpcTransport } from "capnweb";
import type { ServerWebSocket } from "bun";
import { AuthError, Initiator, refusalFor, Responder, type InitiatorOptions, type LinkMode, type ResponderOptions, type Step } from "./auth.js";
import { closeReason, closeSocket, openSocket } from "./connect.js";
import type { Identity, PublicKey } from "./identity.js";
import { isRelayAddress } from "./relay-hub.js";

/**
 * Encrypted, mutually authenticated connections between paired devices.
 *
 * The connection starts with auth.ts's handshake, in which each side also sends an
 * ephemeral libsodium crypto_kx public key that the signatures cover. crypto_kx then
 * gives each direction its own session key, and every later message is a libsodium
 * secretstream record (XChaCha20-Poly1305): encrypted, authenticated, in order, and
 * never accepted twice. Records carry fragments of Cap'n Web messages and heartbeats.
 * Nothing in this file implements a cipher; it composes libsodium's constructions.
 *
 * Wire after the handshake, as binary WebSocket messages:
 *   each side -> its secretstream header (24 bytes), then a heartbeat record at once
 *   then      -> records: secretstream(kind byte + payload)
 * A side is open only once the other's first record has opened under the derived keys,
 * which confirms that both sides hold them.
 *
 * Close frames travel outside the encryption, so the channel sends only fixed reasons
 * and keeps the details for `done`.
 */

/** How long a device has to finish authenticating. */
export const HANDSHAKE_MS = 10_000;
/** An idle link sends a heartbeat this often, so the other side knows it is alive. */
export const HEARTBEAT_MS = 15_000;
/** A link that delivers nothing authenticated for this long is closed as lost. */
export const LINK_TIMEOUT_MS = 45_000;
/** Cap'n Web messages travel in records carrying at most this many bytes each; a record adds 18 bytes. */
export const FRAGMENT_BYTES = 64 * 1024;
/** A reassembled Cap'n Web message may be at most this large. */
export const MAX_MESSAGE_BYTES = 32 * 1024 * 1024;

const MORE = 1;
const LAST = 2;
const PING = 3;
/** libsodium.js allocates each secretstream state on its heap and never frees it. */
const STATE_BYTES = 52;

/** Load libsodium. Every channel needs it; call it once before accepting connections. */
export async function secureReady(): Promise<void> { await sodium.ready; }

/** The two directions of one connection: what the channel sends, and how it closes it. */
export interface Wire {
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
}

/** Who is on the other end, once the channel is open. */
export interface Established {
  peer: PublicKey;
  /** For a responder: the invite the initiator proved, if it came to pair. */
  invite?: { id: string };
  /** "daemon" for a standing link between daemons; "client" for one command's connection. */
  mode: LinkMode;
}

export interface Timing { handshakeMs?: number; heartbeatMs?: number; timeoutMs?: number }

type Incoming = string | ArrayBuffer | Uint8Array;

/**
 * One encrypted connection. Feed it every incoming WebSocket message with `deliver`
 * and the socket's closing with `closed`; once `ready` resolves, it is a Cap'n Web
 * transport (see `rpcSession`).
 */
export class SecureChannel implements RpcTransport {
  readonly ready: Promise<Established>;
  /** Resolves with the reason once the channel has closed, for whatever reason. */
  readonly done: Promise<string>;
  #wire: Wire;
  #role: "initiator" | "responder";
  #auth: Initiator | Responder;
  #kx: { publicKey: Uint8Array; privateKey: Uint8Array };
  #mode: LinkMode;
  #phase: "auth" | "header" | "confirm" | "open" | "closed" = "auth";
  #established?: Established;
  #rx?: Uint8Array;
  #push?: number;
  #pull?: number;
  #pending: Incoming[] = [];
  #busy = false;
  #fragments: Uint8Array[] = [];
  #fragmentBytes = 0;
  #messages: string[] = [];
  #waiters: Array<{ resolve: (message: string) => void; reject: (error: Error) => void }> = [];
  #resolveReady!: (value: Established) => void;
  #rejectReady!: (error: unknown) => void;
  #resolveDone!: (reason: string) => void;
  #closedError?: Error;
  #handshakeTimer: ReturnType<typeof setTimeout>;
  #heartbeat?: ReturnType<typeof setInterval>;
  #lastSent = Date.now();
  #lastReceived = Date.now();
  #timing: Required<Timing>;

  private constructor(wire: Wire, role: "initiator" | "responder", identity: Identity, options: (InitiatorOptions | ResponderOptions) & { timing?: Timing }) {
    this.#wire = wire;
    this.#role = role;
    this.#timing = { handshakeMs: HANDSHAKE_MS, heartbeatMs: HEARTBEAT_MS, timeoutMs: LINK_TIMEOUT_MS, ...options.timing };
    this.#kx = sodium.crypto_kx_keypair();
    this.#mode = role === "initiator" ? (options as InitiatorOptions).mode ?? "client" : "client";
    this.#auth = role === "initiator"
      ? new Initiator(identity, this.#kx.publicKey, options as InitiatorOptions)
      : new Responder(identity, this.#kx.publicKey, options as ResponderOptions);
    this.ready = new Promise((resolve, reject) => { this.#resolveReady = resolve; this.#rejectReady = reject; });
    this.ready.catch(() => {});
    this.done = new Promise((resolve) => { this.#resolveDone = resolve; });
    this.#handshakeTimer = setTimeout(() => this.#fail(new AuthError("protocol", "The peer did not finish authenticating in time.")), this.#timing.handshakeMs);
    this.#handshakeTimer.unref?.();
  }

  /** The dialing side; it sends the first handshake message at once. Call `secureReady` first. */
  static initiator(wire: Wire, identity: Identity, options: InitiatorOptions & { timing?: Timing } = {}): SecureChannel {
    const channel = new SecureChannel(wire, "initiator", identity, options);
    channel.#send((channel.#auth as Initiator).start());
    return channel;
  }

  /** The accepting side; it waits for the initiator. Call `secureReady` first. */
  static responder(wire: Wire, identity: Identity, options: ResponderOptions & { timing?: Timing }): SecureChannel {
    return new SecureChannel(wire, "responder", identity, options);
  }

  get established(): Established | undefined { return this.#established; }
  /** Read the phase afresh, after an await may have changed it. */
  #closed(): boolean { return this.#phase === "closed"; }
  get open(): boolean { return this.#phase === "open"; }

  /** Hand the channel a message the socket received. Messages are processed in order. */
  deliver(data: Incoming): void {
    if (this.#phase === "closed") return;
    this.#pending.push(data);
    void this.#pump();
  }

  /** The socket closed; `reason` is what to tell anyone still waiting. */
  closed(reason = "The connection closed."): void {
    if (this.#phase === "closed") return;
    this.#finish(new AuthError("closed", reason), reason);
  }

  /**
   * Close the channel and its socket. `reason` goes to the other side in the clear, so
   * pass a fixed phrase, never text from the other side or from an error.
   */
  close(reason = "Connection ended", code = 1000): void {
    if (this.#phase === "closed") return;
    this.#finish(new AuthError("closed", reason), reason);
    try { this.#wire.close(code, reason); } catch { /* Already closed. */ }
  }

  // ---- Cap'n Web transport ----

  send(message: string): void {
    if (this.#phase !== "open") throw this.#closedError ?? new Error("The secure channel is not open.");
    const bytes = Buffer.from(message, "utf8");
    if (bytes.length > MAX_MESSAGE_BYTES) throw new Error("An RPC message is too large for the secure channel.");
    for (let offset = 0; offset < bytes.length || offset === 0; offset += FRAGMENT_BYTES) {
      const chunk = bytes.subarray(offset, offset + FRAGMENT_BYTES);
      const last = offset + FRAGMENT_BYTES >= bytes.length;
      this.#record(last ? LAST : MORE, chunk);
      if (last) break;
    }
  }

  receive(): Promise<string> {
    const message = this.#messages.shift();
    if (message !== undefined) return Promise.resolve(message);
    if (this.#closedError) return Promise.reject(this.#closedError);
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }

  /** Cap'n Web gave up on the session. Its reason stays here: close frames are not encrypted. */
  abort(reason: unknown): void {
    if (this.#phase === "closed") return;
    const detail = reason instanceof Error ? reason.message : "The RPC session ended.";
    this.#finish(new AuthError("closed", detail), detail);
    try { this.#wire.close(1011, "RPC session ended"); } catch { /* Already closed. */ }
  }

  // ---- internals ----

  async #pump() {
    if (this.#busy) return;
    this.#busy = true;
    try {
      while (this.#pending.length && this.#phase !== "closed") {
        const data = this.#pending.shift()!;
        try { await this.#handle(data); }
        catch (error) { this.#fail(error); }
      }
    } finally { this.#busy = false; }
  }

  async #handle(data: Incoming) {
    if (this.#phase === "auth") {
      if (typeof data !== "string") throw new AuthError("protocol", "The peer did not start with an authentication handshake. It may run an older cns.");
      let step: Step;
      try { step = this.#role === "initiator" ? (this.#auth as Initiator).receive(data) : await (this.#auth as Responder).receive(data); }
      catch (error) {
        const refusal = refusalFor(error);
        if (refusal && !this.#closed()) this.#send(refusal);
        throw error;
      }
      // The channel may have closed while the responder decided; then nothing more is sent.
      if (this.#closed()) return;
      if (step.send) this.#send(step.send);
      if (step.peer && step.peerKx) this.#keys(step);
      return;
    }
    const bytes = typeof data === "string" ? undefined : data instanceof Uint8Array ? data : new Uint8Array(data);
    if (!bytes) throw new AuthError("protocol", "The peer sent an unencrypted message on an encrypted link.");
    this.#lastReceived = Date.now();
    if (this.#phase === "header") {
      if (bytes.length !== sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES) throw new AuthError("protocol", "The peer sent an invalid stream header.");
      this.#pull = sodium.crypto_secretstream_xchacha20poly1305_init_pull(bytes, this.#rx!) as unknown as number;
      this.#rx!.fill(0);
      this.#phase = "confirm";
      return;
    }
    if (this.#phase !== "open" && this.#phase !== "confirm") return;
    let opened: { message: Uint8Array; tag: number } | false;
    try { opened = sodium.crypto_secretstream_xchacha20poly1305_pull(this.#pull as never, bytes, null); }
    catch { opened = false; }
    if (!opened || !opened.message.length) {
      throw this.#phase === "confirm"
        ? new AuthError("protocol", "The other side does not hold this connection's keys; the link was closed.")
        : new Error("A message on the secure link failed authentication; the link was closed.");
    }
    const kind = opened.message[0];
    const payload = opened.message.subarray(1);
    if (this.#phase === "confirm") {
      // The first record proves the other side derived the same keys: only then is the channel open.
      if (kind !== PING) throw new AuthError("protocol", "The peer sent an invalid first record.");
      this.#phase = "open";
      clearTimeout(this.#handshakeTimer);
      this.#heartbeat = setInterval(() => this.#tick(), Math.max(50, Math.floor(this.#timing.heartbeatMs / 3)));
      this.#heartbeat.unref?.();
      this.#resolveReady(this.#established!);
      return;
    }
    if (kind === PING) return;
    if (kind !== MORE && kind !== LAST) throw new Error("The peer sent an unknown record on the secure link.");
    this.#fragmentBytes += payload.length;
    if (this.#fragmentBytes > MAX_MESSAGE_BYTES) throw new Error("The peer sent an RPC message that is too large.");
    this.#fragments.push(payload.slice());
    if (kind === MORE) return;
    const message = Buffer.concat(this.#fragments).toString("utf8");
    this.#fragments = [];
    this.#fragmentBytes = 0;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(message);
    else this.#messages.push(message);
  }

  /** Derive this connection's keys from both ephemeral keys and send this side's stream header. */
  #keys(step: Step) {
    const keys = this.#role === "initiator"
      ? sodium.crypto_kx_client_session_keys(this.#kx.publicKey, this.#kx.privateKey, step.peerKx!)
      : sodium.crypto_kx_server_session_keys(this.#kx.publicKey, this.#kx.privateKey, step.peerKx!);
    this.#kx.privateKey.fill(0);
    const pushed = sodium.crypto_secretstream_xchacha20poly1305_init_push(keys.sharedTx);
    keys.sharedTx.fill(0);
    this.#push = pushed.state as unknown as number;
    this.#rx = keys.sharedRx;
    this.#established = { peer: step.peer!, ...step.invite ? { invite: step.invite } : {}, mode: this.#role === "responder" ? step.mode ?? "client" : this.#mode };
    this.#phase = "header";
    this.#send(pushed.header);
    // Key confirmation: a record only the holder of these keys could have made.
    this.#record(PING, new Uint8Array(0));
  }

  #record(kind: number, payload: Uint8Array) {
    const plain = new Uint8Array(payload.length + 1);
    plain[0] = kind;
    plain.set(payload, 1);
    const sealed = sodium.crypto_secretstream_xchacha20poly1305_push(this.#push as never, plain, null, sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE);
    this.#send(sealed);
  }

  #tick() {
    if (this.#phase !== "open") return;
    const now = Date.now();
    if (now - this.#lastReceived >= this.#timing.timeoutMs) {
      this.close("The link timed out: the other device stopped answering.", 1001);
      return;
    }
    if (now - this.#lastSent >= this.#timing.heartbeatMs) {
      try { this.#record(PING, new Uint8Array(0)); } catch { /* The wire has gone; closing follows. */ }
    }
  }

  #send(data: string | Uint8Array) {
    this.#lastSent = Date.now();
    this.#wire.send(data);
  }

  #fail(error: unknown) {
    if (this.#phase === "closed") return;
    const reason = error instanceof Error ? error.message : String(error);
    const authenticating = this.#phase === "auth" || this.#phase === "header" || this.#phase === "confirm";
    this.#finish(error instanceof Error ? error : new Error(reason), reason);
    // The details stay here; the frame says only what kind of failure it was.
    try { this.#wire.close(1008, authenticating ? "Authentication failed" : "Protocol error"); } catch { /* Already closed. */ }
  }

  #finish(error: Error, reason: string) {
    this.#phase = "closed";
    this.#closedError = error;
    clearTimeout(this.#handshakeTimer);
    clearInterval(this.#heartbeat);
    this.#rejectReady(error);
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
    this.#pending = [];
    this.#fragments = [];
    this.#kx.privateKey.fill(0);
    this.#rx?.fill(0);
    // libsodium.js never frees stream states; zero and free them so no key material lingers.
    const heap = (sodium as unknown as { libsodium: { HEAPU8: Uint8Array; _free(address: number): void } }).libsodium;
    for (const state of [this.#push, this.#pull]) {
      if (state === undefined) continue;
      heap.HEAPU8.fill(0, state, state + STATE_BYTES);
      heap._free(state);
    }
    this.#push = this.#pull = undefined;
    this.#resolveDone(reason);
  }
}

/** A Cap'n Web session over an open channel; returns the other side's main object. */
export function rpcSession<T>(channel: SecureChannel, localMain: unknown): RpcStub<T> {
  return new RpcSession<T & never>(channel, localMain).getRemoteMain() as unknown as RpcStub<T>;
}

/** The Wire of a client WebSocket. */
export function clientWire(socket: WebSocket): Wire {
  return {
    send: (data) => socket.send(data),
    close: (code, reason) => closeSocket(socket, reason, code),
  };
}

/** The Wire of a Bun server WebSocket. */
export function serverWire<T>(ws: ServerWebSocket<T>): Wire {
  return {
    send: (data) => { ws.send(data); },
    close: (code, reason) => { try { ws.close(code, closeReason(reason)); } catch { /* Already closed. */ } },
  };
}

/** Feed a client WebSocket's messages and closing into a channel. */
export function attachClientSocket(socket: WebSocket, channel: SecureChannel): void {
  socket.binaryType = "arraybuffer";
  socket.addEventListener("message", (event: MessageEvent) => channel.deliver(event.data as Incoming));
  socket.addEventListener("close", (event: CloseEvent) => channel.closed(event.reason ? `The other side closed the connection: ${event.reason}` : "The connection closed."));
  socket.addEventListener("error", () => channel.closed("The connection failed."));
}

/**
 * Dial `url` and open an encrypted channel to the device `options.expect` names (or
 * whoever answers, during pairing checks). Rejects with an AuthError when the device
 * refuses, is another device or does not authenticate, and with a plain Error when it
 * cannot be reached.
 */
export async function connectSecure(url: string, identity: Identity, options: InitiatorOptions & { signal?: AbortSignal; timing?: Timing } = {}): Promise<{ channel: SecureChannel; peer: PublicKey }> {
  await secureReady();
  const signal = options.signal ?? new AbortController().signal;
  const socket = await openSocket(url, signal);
  const channel = SecureChannel.initiator(clientWire(socket), identity, options);
  attachClientSocket(socket, channel);
  const abort = () => channel.close("Cancelled");
  signal.addEventListener("abort", abort, { once: true });
  try {
    const { peer } = await channel.ready;
    return { channel, peer };
  } catch (error) {
    channel.close("Authentication failed");
    // A timeout or cancellation is reported as itself, not as the closing it caused.
    throw signal.aborted && signal.reason instanceof Error ? signal.reason : error;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/** Rank how telling a failed connection is, so the most useful reason is reported. */
function weight(error: unknown): number {
  if (error instanceof AuthError) return error.code === "identity-changed" ? 4 : error.code === "not-paired" ? 3 : error.code === "closed" ? 1 : 2;
  return 0;
}

/**
 * Open a channel to a paired device at the first of its addresses that answers as that
 * device, trying them in order: direct addresses first, a relay last. Every address but
 * the last gets `perAddressMs` to answer. When none works, the most telling failure is
 * thrown: another device at an address, then a refusal, then unreachable.
 */
export async function connectFirst(addresses: readonly string[], identity: Identity, options: InitiatorOptions & { signal?: AbortSignal; perAddressMs?: number; timing?: Timing } = {}): Promise<{ channel: SecureChannel; peer: PublicKey; url: string }> {
  if (!addresses.length) throw new Error("No saved address. Add one with cns peer address NAME ws://HOST:PORT.");
  // Direct addresses first, in their saved order; relays last, however they were saved.
  const ordered = [...addresses.filter((url) => !isRelayAddress(url)), ...addresses.filter(isRelayAddress)];
  let failure: unknown;
  for (const [index, url] of ordered.entries()) {
    options.signal?.throwIfAborted();
    const attempt = new AbortController();
    const outer = options.signal;
    const relay = () => attempt.abort(outer!.reason);
    outer?.addEventListener("abort", relay, { once: true });
    const last = index === ordered.length - 1;
    const timer = last ? undefined : setTimeout(() => attempt.abort(new Error(`Timed out connecting to ${url}.`)), options.perAddressMs ?? 3000);
    try {
      const opened = await connectSecure(url, identity, { ...options, signal: attempt.signal });
      return { ...opened, url };
    } catch (error) {
      if (outer?.aborted) throw error;
      if (weight(error) >= weight(failure)) failure = error;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener("abort", relay);
    }
  }
  throw failure instanceof Error ? failure : new Error(String(failure));
}
