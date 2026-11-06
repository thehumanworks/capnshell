import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { publicKeyBytes, verify, type Identity, type PublicKey } from "./identity.js";

/**
 * Mutual authentication between two devices, run on a connection before Cap'n Web
 * starts, so that nothing is exported to a device that has not proved its identity.
 *
 * Each side proves possession of its Ed25519 key by signing a challenge made of both
 * nonces, both identity keys and both ephemeral key-exchange keys. During pairing,
 * the initiator also proves that it knows the invite secret. The ephemeral keys
 * (`kx`, libsodium crypto_kx) give the session keys that secure.ts encrypts the
 * connection with; signing them binds those keys to the authenticated identities.
 *
 * Wire: four JSON text messages, then secure.ts takes over the connection.
 *   initiator -> { t: "hello", v: 2, key, nonce, kx, invite?, mode? }   mode: "daemon" for a standing link between daemons
 *   responder -> { t: "hello", v: 2, key, nonce, kx, sig }      or { t: "refused", code, reason }
 *   initiator -> { t: "auth", sig, proof? }
 *   responder -> { t: "ok" }                                     or { t: "refused", code, reason }
 */

export const AUTH_VERSION = 2;
const NONCE_BYTES = 16;
const base64url = /^[A-Za-z0-9_-]+$/;
const keySchema = z.string().regex(base64url).refine((value) => Buffer.from(value, "base64url").length === 32);
const nonceSchema = z.string().regex(base64url).refine((value) => Buffer.from(value, "base64url").length === NONCE_BYTES);
const signatureSchema = z.string().regex(base64url).refine((value) => Buffer.from(value, "base64url").length === 64);
const inviteIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const modeSchema = z.enum(["daemon", "client"]);
export type LinkMode = z.infer<typeof modeSchema>;
const helloSchema = z.strictObject({ t: z.literal("hello"), v: z.literal(AUTH_VERSION), key: keySchema, nonce: nonceSchema, kx: keySchema, invite: inviteIdSchema.optional(), mode: modeSchema.optional(), sig: signatureSchema.optional() });
const authSchema = z.strictObject({ t: z.literal("auth"), sig: signatureSchema, proof: z.string().regex(base64url).optional() });
const codeSchema = z.enum(["protocol", "identity-changed", "refused", "not-paired", "invalid-proof", "closed"]);
const refusedSchema = z.strictObject({ t: z.literal("refused"), code: codeSchema, reason: z.string().max(512) });
const okSchema = z.strictObject({ t: z.literal("ok") });
const messageSchema = z.union([helloSchema, authSchema, refusedSchema, okSchema]);
type Message = z.infer<typeof messageSchema>;

export const MAX_HANDSHAKE_MESSAGE_BYTES = 4096;

/** Why the other device was not accepted. `code` is stable for exit statuses and scripts. */
export type AuthCode = z.infer<typeof codeSchema>;
export class AuthError extends Error {
  constructor(readonly code: AuthCode, message: string) {
    super(message);
    this.name = "AuthError";
  }
}

/** Why a device is not accepted: a plain reason, or one with a stable code such as "not-paired". */
export type Refusal = string | { code: AuthCode; reason: string };
export interface ResponderOptions {
  /**
   * Decide whether an authenticated device may connect. Return nothing to accept,
   * or the reason to refuse. `invite`, when present, has been checked: the initiator
   * knew the secret of the invite with that id, as `secretFor` returned it.
   */
  authorize(peer: PublicKey, invite?: { id: string }): Promise<Refusal | undefined> | Refusal | undefined;
  /** The secret of a pending invite, so its proof can be checked; undefined for an unknown invite. */
  secretFor?(id: string): Uint8Array | undefined;
}
export interface InitiatorOptions {
  /** The device this connection must reach; any other identity is "identity changed". */
  expect?: PublicKey;
  /** During pairing, prove knowledge of this invite's secret. */
  invite?: { id: string; secret: Uint8Array };
  /** "daemon" for a standing link between two daemons, which they deduplicate; "client" (the default) for one command's connection. */
  mode?: LinkMode;
}

export interface Step {
  send?: string;
  /** Set on the final step: the authenticated device and its ephemeral key-exchange key. */
  peer?: PublicKey;
  peerKx?: Uint8Array;
  invite?: { id: string };
  /** The initiator's declared link mode, on the responder's final step. */
  mode?: LinkMode;
}

/** An ephemeral key-exchange public key is 32 bytes. */
export const KX_BYTES = 32;

function transcript(initiatorNonce: Buffer, responderNonce: Buffer, initiatorKey: PublicKey, responderKey: PublicKey, initiatorKx: Uint8Array, responderKx: Uint8Array): Buffer {
  return createHash("sha256").update("cns-auth-2").update(initiatorNonce).update(responderNonce)
    .update(publicKeyBytes(initiatorKey)).update(publicKeyBytes(responderKey))
    .update(initiatorKx).update(responderKx).digest();
}
function kxBytes(value: Uint8Array): Uint8Array {
  if (value.length !== KX_BYTES) throw new Error("A key-exchange key is 32 bytes.");
  return value;
}
function challenge(role: "initiator" | "responder", base: Buffer): Buffer {
  return createHash("sha256").update(base).update(role).digest();
}
function proofOf(secret: Uint8Array, base: Buffer): Buffer { return createHmac("sha256", secret).update(base).digest(); }
function parse(text: string): Message {
  if (typeof text !== "string" || text.length > MAX_HANDSHAKE_MESSAGE_BYTES) throw new AuthError("protocol", "The peer sent an invalid handshake message.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { value = undefined; }
  if (typeof value !== "object" || value === null || Array.isArray(value) || typeof (value as { t?: unknown }).t !== "string") {
    throw new AuthError("protocol", "The peer did not start with an authentication handshake. It may run an older cns, or a browser.");
  }
  const parsed = messageSchema.safeParse(value);
  if (!parsed.success) throw new AuthError("protocol", "The peer sent an invalid handshake message.");
  return parsed.data;
}
function refusal(code: AuthCode, reason: string): string { return JSON.stringify({ t: "refused", code, reason }); }

/** The side that opened the connection. Call `start()`, send its result, then feed each reply to `receive()`. */
export class Initiator {
  #identity: Identity;
  #options: InitiatorOptions;
  #nonce = randomBytes(NONCE_BYTES);
  #state: "new" | "hello" | "auth" | "done" = "new";
  #base?: Buffer;
  #peer?: PublicKey;
  #kx: Uint8Array;
  #peerKx?: Uint8Array;
  /** `kx` is this side's ephemeral key-exchange public key for this connection. */
  constructor(identity: Identity, kx: Uint8Array, options: InitiatorOptions = {}) {
    this.#identity = identity;
    this.#kx = kxBytes(kx);
    this.#options = options;
  }
  start(): string {
    if (this.#state !== "new") throw new AuthError("protocol", "The handshake has already started.");
    this.#state = "hello";
    return JSON.stringify({
      t: "hello", v: AUTH_VERSION, key: this.#identity.publicKey, nonce: this.#nonce.toString("base64url"), kx: Buffer.from(this.#kx).toString("base64url"),
      ...this.#options.invite ? { invite: this.#options.invite.id } : {}, ...this.#options.mode ? { mode: this.#options.mode } : {},
    });
  }
  /** Returns what to send next, and `peer` once the other device is authenticated. */
  receive(text: string): Step {
    const message = parse(text);
    if (message.t === "refused") { this.#state = "done"; throw new AuthError(message.code, `The peer refused the connection: ${message.reason}`); }
    if (this.#state === "hello") {
      if (message.t !== "hello" || !message.sig) throw new AuthError("protocol", "The peer sent an invalid handshake message.");
      if (this.#options.expect !== undefined && message.key !== this.#options.expect) {
        this.#state = "done";
        throw new AuthError("identity-changed", "The peer's identity is not the one saved for it. Pair with it again if the device was replaced.");
      }
      const peerKx = Buffer.from(message.kx, "base64url");
      const base = transcript(this.#nonce, Buffer.from(message.nonce, "base64url"), this.#identity.publicKey, message.key, this.#kx, peerKx);
      if (!verify(message.key, challenge("responder", base), Buffer.from(message.sig, "base64url"))) throw new AuthError("protocol", "The peer could not prove its identity.");
      this.#base = base;
      this.#peer = message.key;
      this.#peerKx = peerKx;
      this.#state = "auth";
      const sig = Buffer.from(this.#identity.sign(challenge("initiator", base))).toString("base64url");
      const proof = this.#options.invite ? proofOf(this.#options.invite.secret, base).toString("base64url") : undefined;
      return { send: JSON.stringify({ t: "auth", sig, ...proof ? { proof } : {} }) };
    }
    if (this.#state === "auth") {
      if (message.t !== "ok") throw new AuthError("protocol", "The peer sent an invalid handshake message.");
      this.#state = "done";
      return { peer: this.#peer!, peerKx: this.#peerKx! };
    }
    throw new AuthError("protocol", "The handshake is over.");
  }
}

/** The side that accepted the connection. Feed it each message; send what it returns. */
export class Responder {
  #identity: Identity;
  #options: ResponderOptions;
  #nonce = randomBytes(NONCE_BYTES);
  #state: "hello" | "auth" | "done" = "hello";
  #base?: Buffer;
  #peer?: PublicKey;
  #invite?: string;
  #mode: LinkMode = "client";
  #kx: Uint8Array;
  #peerKx?: Uint8Array;
  /** `kx` is this side's ephemeral key-exchange public key for this connection. */
  constructor(identity: Identity, kx: Uint8Array, options: ResponderOptions) {
    this.#identity = identity;
    this.#kx = kxBytes(kx);
    this.#options = options;
  }
  /** Returns what to send next; `peer` is set once the other device is authenticated and authorized. A thrown AuthError's `send`, if any, has already been returned. */
  async receive(text: string): Promise<Step> {
    let message: Message;
    try { message = parse(text); }
    catch (error) {
      this.#state = "done";
      if (error instanceof AuthError) (error as AuthError & { send?: string }).send = refusal(error.code, error.message);
      throw error;
    }
    if (message.t === "refused") { this.#state = "done"; throw new AuthError(message.code, `The peer gave up: ${message.reason}`); }
    if (this.#state === "hello") {
      if (message.t !== "hello" || message.sig !== undefined) return this.#refuse("protocol", "The peer sent an invalid handshake message.");
      if (message.invite !== undefined && !this.#options.secretFor?.(message.invite)) return this.#refuse("refused", "Unknown or expired invite.");
      const peerKx = Buffer.from(message.kx, "base64url");
      const base = transcript(Buffer.from(message.nonce, "base64url"), this.#nonce, message.key, this.#identity.publicKey, peerKx, this.#kx);
      this.#base = base;
      this.#peer = message.key;
      this.#peerKx = peerKx;
      this.#invite = message.invite;
      this.#mode = message.mode ?? "client";
      this.#state = "auth";
      const sig = Buffer.from(this.#identity.sign(challenge("responder", base))).toString("base64url");
      return { send: JSON.stringify({ t: "hello", v: AUTH_VERSION, key: this.#identity.publicKey, nonce: this.#nonce.toString("base64url"), kx: Buffer.from(this.#kx).toString("base64url"), sig }) };
    }
    if (this.#state === "auth") {
      if (message.t !== "auth") return this.#refuse("protocol", "The peer sent an invalid handshake message.");
      if (!verify(this.#peer!, challenge("initiator", this.#base!), Buffer.from(message.sig, "base64url"))) return this.#refuse("protocol", "The peer could not prove its identity.");
      let invite: { id: string } | undefined;
      if (this.#invite !== undefined) {
        const secret = this.#options.secretFor?.(this.#invite);
        const expected = secret ? proofOf(secret, this.#base!) : undefined;
        const supplied = message.proof ? Buffer.from(message.proof, "base64url") : undefined;
        if (!expected || !supplied || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return this.#refuse("invalid-proof", "The invite proof is wrong or the invite has expired.");
        invite = { id: this.#invite };
      } else if (message.proof !== undefined) return this.#refuse("protocol", "The peer sent an invalid handshake message.");
      const reason = await this.#options.authorize(this.#peer!, invite);
      if (reason !== undefined) return this.#refuse(typeof reason === "string" ? "refused" : reason.code, typeof reason === "string" ? reason : reason.reason);
      this.#state = "done";
      return { send: JSON.stringify({ t: "ok" }), peer: this.#peer!, peerKx: this.#peerKx!, invite, mode: this.#mode };
    }
    throw new AuthError("protocol", "The handshake is over.");
  }
  #refuse(code: AuthError["code"], reason: string): never {
    this.#state = "done";
    const error = new AuthError(code, reason) as AuthError & { send?: string };
    error.send = refusal(code, reason);
    throw error;
  }
}

/** The refusal to send the peer for a failed responder handshake, if the error carries one. */
export function refusalFor(error: unknown): string | undefined {
  return error instanceof AuthError ? (error as AuthError & { send?: string }).send : undefined;
}
