import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as signBytes, verify as verifyBytes, type KeyObject } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { checkConfigDirectory, configDirectory, isPrivateFile, requirePrivateStateSupport } from "./config.js";

/**
 * A device's identity: a long-lived Ed25519 key pair in the configuration
 * directory. Its public key names the device on the wire; its fingerprint is what
 * people compare when pairing. Losing or replacing the file makes this a new
 * device that every peer must pair with again.
 */

/** Base64url of the raw 32-byte Ed25519 public key, as it appears on the wire and in peers files. */
export type PublicKey = string;

const base64url = /^[A-Za-z0-9_-]+$/;
const publicKeySchema = z.string().regex(base64url).refine((value) => Buffer.from(value, "base64url").length === 32, "A public key is 32 bytes.");
const identityFileSchema = z.strictObject({
  version: z.literal(1),
  publicKey: publicKeySchema,
  /** PKCS#8 DER of the private key, base64url. */
  privateKey: z.string().regex(base64url).refine((value) => Buffer.from(value, "base64url").length === 48, "An Ed25519 PKCS#8 key is 48 bytes."),
  createdAt: z.iso.datetime(),
});
type IdentityFile = z.infer<typeof identityFileSchema>;

export const PUBLIC_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;
/** SPKI DER prefix for an Ed25519 public key; the raw key follows it. */
const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");

export interface Identity {
  publicKey: PublicKey;
  fingerprint: string;
  createdAt: string;
  /** Sign bytes with this device's key. */
  sign(data: Uint8Array): Uint8Array;
}

export function identityPath(): string { return path.join(configDirectory(), "identity.json"); }

/** The fingerprint people compare: SHA-256 of the raw public key in base32, six groups of four. */
export function fingerprint(publicKey: PublicKey): string {
  const digest = createHash("sha256").update(publicKeyBytes(publicKey)).digest();
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, value = 0, text = "";
  for (const byte of digest) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { text += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return text.slice(0, 24).match(/.{4}/g)!.join("-");
}

export function publicKeyBytes(publicKey: PublicKey): Buffer {
  const bytes = Buffer.from(publicKeySchema.parse(publicKey), "base64url");
  return bytes;
}

/** Verify a signature made by the device with `publicKey`. */
export function verify(publicKey: PublicKey, data: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== SIGNATURE_BYTES) return false;
  const key = createPublicKey({ key: Buffer.concat([spkiPrefix, publicKeyBytes(publicKey)]), format: "der", type: "spki" });
  return verifyBytes(null, data, key, signature);
}

function identityFrom(file: IdentityFile): Identity {
  const privateKey: KeyObject = createPrivateKey({ key: Buffer.from(file.privateKey, "base64url"), format: "der", type: "pkcs8" });
  const derived = (createPublicKey(privateKey).export({ format: "der", type: "spki" }) as Buffer).subarray(-PUBLIC_KEY_BYTES).toString("base64url");
  if (derived !== file.publicKey) throw new Error(`Identity file is inconsistent: its public key does not belong to its private key: ${identityPath()}`);
  return {
    publicKey: file.publicKey, fingerprint: fingerprint(file.publicKey), createdAt: file.createdAt,
    sign: (data) => new Uint8Array(signBytes(null, data, privateKey)),
  };
}

/** A fresh identity that is not stored anywhere, for tests and pairing dry runs. */
export function generateIdentity(): Identity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return identityFrom({
    version: 1,
    publicKey: (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-PUBLIC_KEY_BYTES).toString("base64url"),
    privateKey: (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64url"),
    createdAt: new Date().toISOString(),
  });
}

/** This device's identity, if the file exists. The file must be private and consistent. */
export function loadIdentity(): Identity | undefined {
  requirePrivateStateSupport("Device identities");
  const file = identityPath();
  let fd: number;
  try { checkConfigDirectory(); fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    if (!isPrivateFile(fstatSync(fd))) throw new Error(`Identity must be a private file owned by your user: ${file}`);
    return identityFrom(identityFileSchema.parse(JSON.parse(readFileSync(fd, "utf8"))));
  } finally { closeSync(fd); }
}

/** This device's identity, created on first use. Returns whether it was created now. */
export function ensureIdentity(): { identity: Identity; created: boolean } {
  requirePrivateStateSupport("Device identities");
  const existing = loadIdentity();
  if (existing) return { identity: existing, created: false };
  checkConfigDirectory(true);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const file: IdentityFile = {
    version: 1,
    publicKey: (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-PUBLIC_KEY_BYTES).toString("base64url"),
    privateKey: (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).toString("base64url"),
    createdAt: new Date().toISOString(),
  };
  // Exclusive creation: never replace an identity, even one written a moment ago by another cns.
  const fd = openSync(identityPath(), "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(file, null, 2) + "\n"); } finally { closeSync(fd); }
  return { identity: identityFrom(file), created: true };
}
