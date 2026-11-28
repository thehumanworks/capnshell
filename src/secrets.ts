import { createHash } from "node:crypto";
import sodium from "libsodium-wrappers-sumo";
import { z } from "zod";
import { fingerprint, publicKeyBytes, verify, withSeed, type Identity, type PublicKey } from "./identity.js";
import type { MeshState } from "./mesh.js";
import { peerNamePattern, secretFiles } from "./peer-files.js";
import { publicKeySchema, revokedDevices } from "./peers.js";

/**
 * Secrets shared in a mesh (docs/adr/0007-mesh-secrets.md).
 *
 * A secret belongs to the member that set it, its owner, and is readable by every member of
 * the mesh, now and later, or by one member that the owner named (and the owner). The owner
 * signs a record: the mesh, its own key, the name, the member it is for if any, a version,
 * and the value encrypted once with a fresh key for that version. Each device keeps the
 * record with that key sealed to its own device key, so a secrets file holds only ciphertext.
 *
 * Daemons swap records over the links they already hold, beside the mesh member lists. A
 * device offers a member only the records that member may read, each with the key sealed
 * afresh to that member. A device keeps an offered record when its owner signed it, the
 * owner (and the member it is for) are in the mesh's current list, this device may read it,
 * the key it came with opens the value, and its version is newer than the one held here. Any
 * reader can pass a record on, none can change or forge it, and nothing rolls one back. A
 * removed secret is a signed record with no value, so an old copy cannot bring it back.
 *
 * Records whose owner, or the member they are for, leaves the mesh, and every record of a
 * mesh this device left, go at the next pruneSecrets. A member that left keeps the values it
 * could read while it was one; later versions are never sealed to it.
 */

export const SECRET_PROTOCOL = "cns-mesh-secret-1";
/** The longest value, in bytes: well under Windows' 32,767-character limit for an environment variable. */
export const MAX_VALUE_BYTES = 16 * 1024;
/** Secrets a device keeps for one mesh, counting every owner's and removed ones. */
export const MAX_SECRETS = 64;
/** At most 8 meshes of MAX_SECRETS each. */
const MAX_OFFER = 8 * MAX_SECRETS;
/** Environment-variable names, so a secret can always be put in a program's environment. */
export const secretNamePattern = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const base64url = /^[A-Za-z0-9_-]+$/;
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const decode = (text: string) => new Uint8Array(Buffer.from(text, "base64url"));
const VALUE_AD = new TextEncoder().encode(SECRET_PROTOCOL);
const signedBytes = (text: string) => Buffer.from(`${SECRET_PROTOCOL}\0${text}`, "utf8");

const recordSchema = z.strictObject({
  v: z.literal(1),
  mesh: z.string().regex(peerNamePattern),
  /** The mesh's admin, which with its name tells two meshes called the same apart. */
  admin: publicKeySchema,
  owner: publicKeySchema,
  name: z.string().regex(secretNamePattern),
  /** The one member that may read it, besides its owner; without it, every member may. */
  device: publicKeySchema.optional(),
  version: z.int().positive(),
  setAt: z.iso.datetime(),
  /** The value, encrypted with this version's key; absent once the owner removed the secret. */
  value: z.strictObject({
    nonce: z.string().regex(/^[A-Za-z0-9_-]{32}$/),
    box: z.string().regex(base64url).max(Math.ceil((MAX_VALUE_BYTES + 16) / 3) * 4),
  }).optional(),
});
export type SecretRecord = z.infer<typeof recordSchema>;

/** A record as it is kept and sent: the owner's signed text, and the version's key sealed to the device that keeps or receives it. */
const copySchema = z.strictObject({
  text: z.string().max(32 * 1024),
  sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  key: z.string().regex(base64url).max(128).optional(),
});
export type SecretCopy = z.infer<typeof copySchema>;

/** A secret this device keeps. */
export interface HeldSecret { id: string; record: SecretRecord; copy: SecretCopy; state: MeshState }

/** Which secret a record is a version of: one per mesh, owner, member it is for, and name. */
export function secretId(record: Pick<SecretRecord, "mesh" | "admin" | "owner" | "device" | "name">): string {
  return createHash("sha256").update([record.mesh, record.admin, record.owner, record.device ?? "", record.name].join("\0")).digest("hex").slice(0, 40);
}

/** The gateway is no member here: it never sets, reads or carries a mesh's secrets. */
const isMember = (state: MeshState, key: PublicKey) => state.list.members.some((member) => member.key === key && !member.gateway);

/** Whether `key` may read the record: a member of its mesh, and the member it is for or its owner when it names one. */
export function mayRead(record: SecretRecord, state: MeshState, key: PublicKey): boolean {
  return isMember(state, key) && (record.device === undefined || key === record.device || key === record.owner);
}

/**
 * The mesh in which this device keeps the record, if it still may: its owner, and the member it
 * is for, are members, and this device may read it. A device removed here (`revoked`, by
 * fingerprint) counts as no member, so what it set, or what was set for it, is not kept.
 */
function meshOf(record: SecretRecord, states: readonly MeshState[], self: PublicKey, revoked: ReadonlySet<string>): MeshState | undefined {
  const state = states.find((candidate) => candidate.name === record.mesh && candidate.admin === record.admin);
  const member = (key: PublicKey) => isMember(state!, key) && !revoked.has(fingerprint(key));
  if (!state || !member(record.owner) || (record.device !== undefined && !member(record.device))) return undefined;
  return mayRead(record, state, self) ? state : undefined;
}

/** The record a copy carries, once its owner's signature checks out. */
function openCopy(value: unknown): { record: SecretRecord; copy: SecretCopy } {
  const copy = copySchema.parse(value);
  const record = recordSchema.parse(JSON.parse(copy.text));
  if (!verify(record.owner, signedBytes(copy.text), decode(copy.sig))) throw new Error("The secret's signature is not its owner's.");
  return { record, copy };
}

/** This device's key pair for sealed boxes: its Ed25519 identity, converted. Wipe secretKey after use. */
function boxKeys(identity: Identity): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return withSeed(identity, (seed) => {
    const pair = sodium.crypto_sign_seed_keypair(seed);
    try {
      return { publicKey: sodium.crypto_sign_ed25519_pk_to_curve25519(pair.publicKey), secretKey: sodium.crypto_sign_ed25519_sk_to_curve25519(pair.privateKey) };
    } finally { sodium.memzero(pair.privateKey); }
  });
}

const sealTo = (key: Uint8Array, reader: PublicKey) => encode(sodium.crypto_box_seal(key, sodium.crypto_sign_ed25519_pk_to_curve25519(publicKeyBytes(reader))));

/** Run `use` with the version key a copy carries for this device, wiped afterwards. Throws when it does not open. */
function withKey<T>(copy: SecretCopy, keys: { publicKey: Uint8Array; secretKey: Uint8Array }, use: (key: Uint8Array) => T): T {
  if (copy.key === undefined) throw new Error("The secret carries no key for this device.");
  const key = sodium.crypto_box_seal_open(decode(copy.key), keys.publicKey, keys.secretKey);
  try { return use(key); } finally { sodium.memzero(key); }
}

const decrypt = (record: SecretRecord, key: Uint8Array) =>
  sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, decode(record.value!.box), VALUE_AD, decode(record.value!.nonce), key);

/**
 * A new version of a secret this device owns, signed, with its key sealed to this device.
 * Without `value`, the version records that the owner removed the secret.
 */
export function sealSecret(identity: Identity, fields: Omit<SecretRecord, "v" | "owner" | "value">, value?: Uint8Array): SecretCopy {
  if (value !== undefined && (value.length === 0 || value.length > MAX_VALUE_BYTES)) throw new Error(`A secret's value holds 1 to ${MAX_VALUE_BYTES} bytes.`);
  const key = sodium.crypto_aead_xchacha20poly1305_ietf_keygen();
  try {
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const sealed = value && { nonce: encode(nonce), box: encode(sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(value, VALUE_AD, null, nonce, key)) };
    const record = recordSchema.parse({ v: 1, ...fields, owner: identity.publicKey, ...sealed ? { value: sealed } : {} });
    const text = JSON.stringify(record);
    return { text, sig: encode(identity.sign(signedBytes(text))), ...sealed ? { key: sealTo(key, identity.publicKey) } : {} };
  } finally { sodium.memzero(key); }
}

/** A secret's value, which this device may read. */
export function openSecret(identity: Identity, held: HeldSecret): Uint8Array {
  if (!held.record.value) throw new Error(`The secret ${held.record.name} was removed.`);
  const keys = boxKeys(identity);
  try { return withKey(held.copy, keys, (key) => decrypt(held.record, key)); }
  finally { sodium.memzero(keys.secretKey); }
}

/** Save a version of a secret here, replacing the one held. */
export function keepSecret(copy: SecretCopy): void {
  const { record } = openCopy(copy);
  const id = secretId(record);
  const content = JSON.stringify(copy) + "\n";
  try { secretFiles.create(id, content); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    secretFiles.rewrite(id, content);
  }
}

/**
 * The secrets this device keeps and still may, given the meshes it is in, removed ones
 * included. A file that cannot be read or no longer counts is left out; pruneSecrets removes it.
 */
export function heldSecrets(self: PublicKey, states: readonly MeshState[]): HeldSecret[] {
  const revoked = revokedDevices();
  return secretFiles.names().flatMap((id) => {
    try {
      const content = secretFiles.read(id);
      if (content === undefined) return [];
      const { record, copy } = openCopy(JSON.parse(content));
      const state = secretId(record) === id ? meshOf(record, states, self, revoked) : undefined;
      return state ? [{ id, record, copy, state }] : [];
    } catch { return []; }
  });
}

/** Remove every secrets file heldSecrets leaves out, such as those of a mesh this device left or of a member removed from one. Returns how many went. */
export function pruneSecrets(self: PublicKey, states: readonly MeshState[]): number {
  const kept = new Set(heldSecrets(self, states).map((held) => held.id));
  let removed = 0;
  for (const id of secretFiles.names()) {
    if (kept.has(id)) continue;
    secretFiles.remove(id);
    removed++;
  }
  return removed;
}

/** The records to offer `peer`: those it may read, each with its key sealed to it. */
export function secretsFor(peer: PublicKey, identity: Identity, states: readonly MeshState[]): SecretCopy[] {
  // A device removed here has no record, so no link to ask on; and if it had, it would get nothing.
  if (peer === identity.publicKey || revokedDevices().has(fingerprint(peer))) return [];
  const offered = heldSecrets(identity.publicKey, states).filter(({ record, state }) => mayRead(record, state, peer)).slice(0, MAX_OFFER);
  if (!offered.length) return [];
  const keys = boxKeys(identity);
  try {
    return offered.flatMap(({ copy }) => {
      if (copy.key === undefined) return [{ text: copy.text, sig: copy.sig }];
      try { return [withKey(copy, keys, (key) => ({ text: copy.text, sig: copy.sig, key: sealTo(key, peer) }))]; }
      catch { return []; }
    });
  } finally { sodium.memzero(keys.secretKey); }
}

/**
 * Keep the records `from`, a member, offered that are newer than this device's and that it
 * may keep (see above), and return them. Anything else offered is ignored.
 */
export function takeSecrets(from: PublicKey, identity: Identity, states: readonly MeshState[], offered: unknown): SecretRecord[] {
  const revoked = revokedDevices();
  if (!Array.isArray(offered) || from === identity.publicKey || revoked.has(fingerprint(from))) return [];
  const self = identity.publicKey;
  const held = new Map(heldSecrets(self, states).map((secret) => [secret.id, secret.record]));
  const count = (mesh: string, admin: PublicKey) => [...held.values()].filter((record) => record.mesh === mesh && record.admin === admin).length;
  const kept: SecretRecord[] = [];
  let keys: ReturnType<typeof boxKeys> | undefined;
  try {
    for (const value of offered.slice(0, MAX_OFFER)) {
      let opened: ReturnType<typeof openCopy>;
      try { opened = openCopy(value); } catch { continue; }
      const { record } = opened;
      const state = meshOf(record, states, self, revoked);
      if (!state || !isMember(state, from)) continue;
      const id = secretId(record);
      const current = held.get(id);
      if (current ? record.version <= current.version : count(record.mesh, record.admin) >= MAX_SECRETS) continue;
      let copy: SecretCopy = { text: opened.copy.text, sig: opened.copy.sig };
      if (record.value) {
        keys ??= boxKeys(identity);
        // Keep only a key that opens the value its owner signed, or a good copy could never replace it.
        try { withKey(opened.copy, keys, (key) => sodium.memzero(decrypt(record, key))); } catch { continue; }
        copy = opened.copy;
      }
      keepSecret(copy);
      held.set(id, record);
      kept.push(record);
    }
  } finally { if (keys) sodium.memzero(keys.secretKey); }
  return kept;
}
