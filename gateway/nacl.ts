/**
 * crypto_kx and crypto_secretstream_xchacha20poly1305 in plain JavaScript, byte for byte
 * what libsodium does. cns uses libsodium.js, which compiles WebAssembly when it loads;
 * Cloudflare Workers forbid that, so the gateway uses these instead (see sodium.ts).
 * nacl.test.ts checks them against libsodium in both directions.
 */
import { chacha20, hchacha } from "@noble/ciphers/chacha.js";
import { poly1305 } from "@noble/ciphers/_poly1305.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { blake2b } from "@noble/hashes/blake2.js";

export interface KeyPair { publicKey: Uint8Array; privateKey: Uint8Array }
export interface SessionKeys { sharedRx: Uint8Array; sharedTx: Uint8Array }
/** One direction of a secretstream: the current key and the 12-byte ChaCha20 nonce, counter first. */
export interface StreamState { k: Uint8Array; nonce: Uint8Array }

const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));
function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

export function kxKeypair(): KeyPair {
  const privateKey = random(32);
  return { publicKey: x25519.getPublicKey(privateKey), privateKey };
}

/** BLAKE2b-512 of the shared point and both public keys, client's first, as libsodium does. */
function sessionHash(shared: Uint8Array, clientKey: Uint8Array, serverKey: Uint8Array): Uint8Array {
  return blake2b(concat(shared, clientKey, serverKey), { dkLen: 64 });
}

export function kxClientSessionKeys(clientPublic: Uint8Array, clientPrivate: Uint8Array, serverPublic: Uint8Array): SessionKeys {
  const hash = sessionHash(x25519.getSharedSecret(clientPrivate, serverPublic), clientPublic, serverPublic);
  return { sharedRx: hash.slice(0, 32), sharedTx: hash.slice(32) };
}

export function kxServerSessionKeys(serverPublic: Uint8Array, serverPrivate: Uint8Array, clientPublic: Uint8Array): SessionKeys {
  const hash = sessionHash(x25519.getSharedSecret(serverPrivate, clientPublic), clientPublic, serverPublic);
  return { sharedRx: hash.slice(32), sharedTx: hash.slice(0, 32) };
}

export const HEADERBYTES = 24;
export const ABYTES = 17;
export const TAG_MESSAGE = 0;
export const TAG_REKEY = 2;

/** "expand 32-byte k" as little-endian words. */
const SIGMA = new Uint32Array([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
const words = (bytes: Uint8Array) => new Uint32Array(bytes.slice().buffer);
function hchacha20(key: Uint8Array, nonce16: Uint8Array): Uint8Array {
  const out = new Uint32Array(8);
  hchacha(SIGMA, words(key), words(nonce16), out);
  return new Uint8Array(out.buffer);
}

function freshNonce(inonce: Uint8Array): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce[0] = 1;
  nonce.set(inonce, 4);
  return nonce;
}

function state(key: Uint8Array, header: Uint8Array): StreamState {
  return { k: hchacha20(key, header.subarray(0, 16)), nonce: freshNonce(header.subarray(16, 24)) };
}

function rekey(stream: StreamState) {
  const next = chacha20(stream.k, stream.nonce, concat(stream.k, stream.nonce.subarray(4)));
  stream.k = next.slice(0, 32);
  stream.nonce = freshNonce(next.subarray(32, 40));
}

/** After each message: mix the MAC into the nonce, count it, and rekey when asked or when the counter wraps. */
function advance(stream: StreamState, mac: Uint8Array, tag: number) {
  for (let i = 0; i < 8; i++) stream.nonce[4 + i]! ^= mac[i]!;
  const view = new DataView(stream.nonce.buffer, stream.nonce.byteOffset, 4);
  const counter = (view.getUint32(0, true) + 1) >>> 0;
  view.setUint32(0, counter, true);
  if ((tag & TAG_REKEY) !== 0 || counter === 0) rekey(stream);
}

function le64(value: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), true);
  return bytes;
}

function mac(stream: StreamState, ad: Uint8Array, block: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const auth = poly1305.create(chacha20(stream.k, stream.nonce, new Uint8Array(64)).subarray(0, 32));
  auth.update(ad);
  auth.update(new Uint8Array((16 - (ad.length % 16)) % 16));
  auth.update(block);
  auth.update(ciphertext);
  // libsodium pads by (0x10 - 64 + mlen) & 0xf, which is mlen % 16, not the usual AEAD padding.
  auth.update(new Uint8Array(ciphertext.length & 15));
  auth.update(le64(ad.length));
  auth.update(le64(64 + ciphertext.length));
  return auth.digest();
}

export function initPush(key: Uint8Array): { state: StreamState; header: Uint8Array } {
  const header = random(HEADERBYTES);
  return { state: state(key, header), header };
}

export function initPull(header: Uint8Array, key: Uint8Array): StreamState {
  if (header.length !== HEADERBYTES) throw new Error("A secretstream header is 24 bytes.");
  return state(key, header);
}

export function push(stream: StreamState, message: Uint8Array, ad: Uint8Array = new Uint8Array(0), tag = TAG_MESSAGE): Uint8Array {
  const block = new Uint8Array(64);
  block[0] = tag;
  const encryptedBlock = chacha20(stream.k, stream.nonce, block, undefined, 1);
  const ciphertext = chacha20(stream.k, stream.nonce, message, undefined, 2);
  const tagMac = mac(stream, ad, encryptedBlock, ciphertext);
  advance(stream, tagMac, tag);
  return concat(encryptedBlock.subarray(0, 1), ciphertext, tagMac);
}

/** The message and its tag, or undefined when the record fails authentication; the state then stays as it was. */
export function pull(stream: StreamState, record: Uint8Array, ad: Uint8Array = new Uint8Array(0)): { message: Uint8Array; tag: number } | undefined {
  if (record.length < ABYTES) return undefined;
  const first = new Uint8Array(64);
  first[0] = record[0]!;
  const block = chacha20(stream.k, stream.nonce, first, undefined, 1);
  const tag = block[0]!;
  block[0] = record[0]!;
  const ciphertext = record.subarray(1, record.length - 16);
  const stored = record.subarray(record.length - 16);
  const expected = mac(stream, ad, block, ciphertext);
  let difference = 0;
  for (let i = 0; i < 16; i++) difference |= expected[i]! ^ stored[i]!;
  if (difference !== 0) return undefined;
  const message = chacha20(stream.k, stream.nonce, ciphertext, undefined, 2);
  advance(stream, expected, tag);
  return { message, tag };
}
