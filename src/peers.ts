import { z } from "zod";
import { createPeerFile, peerFile, peerNames, readPeerFile, revokedFiles, rewritePeerFile, validatePeerUrl } from "./peer-files.js";
import { isIP } from "node:net";
import { errorMessage } from "./errors.js";
import { fingerprint, type PublicKey } from "./identity.js";
import { isRelayAddress } from "./relay-hub.js";
import { CNS_VERSION } from "./version.js";

/**
 * Paired devices, each saved under an alias in the peers directory. Trust is keyed by the device's public key; the alias is only this user's
 * name for it. Grants are directional: `incoming` is what this device lets the peer
 * do here, enforced here; `outgoing` is what the peer said it lets this device do,
 * kept for display and enforced there.
 */

/**
 * `skills` reads this device's agent skills and nothing else; `files` can read them too, so
 * `all` leaves it out. It also keeps `all`, the default request when pairing, readable by a
 * cns from before skills.
 */
export const PERMISSIONS = ["shell", "files", "skills", "sessions:list", "sessions:create", "sessions:view", "sessions:control", "sessions:kill"] as const;
export type Permission = typeof PERMISSIONS[number];
export const PRESETS: Record<"shell" | "files" | "sessions" | "all", readonly Permission[]> = {
  shell: ["shell"],
  files: ["files"],
  sessions: ["sessions:list", "sessions:create", "sessions:view", "sessions:control", "sessions:kill"],
  all: PERMISSIONS.filter((permission) => permission !== "skills"),
};
const permissionSchema = z.enum(PERMISSIONS);
export const grantsSchema = z.array(permissionSchema).max(PERMISSIONS.length);

/** Expand presets and permissions, such as ["shell", "sessions"], into a canonical permission list; "none" adds nothing. */
export function expandGrants(words: readonly string[]): Permission[] {
  const set = new Set<Permission>();
  for (const word of words) {
    if (word === "none") continue;
    if (word in PRESETS) for (const permission of PRESETS[word as keyof typeof PRESETS]) set.add(permission);
    else set.add(permissionSchema.parse(word));
  }
  return PERMISSIONS.filter((permission) => set.has(permission));
}

/** Permissions as people read them: presets where a whole group is present. */
export function describeGrants(grants: readonly Permission[]): string {
  if (!grants.length) return "none";
  const words: string[] = [];
  const rest = new Set(grants);
  for (const preset of ["shell", "files", "sessions"] as const) {
    if (PRESETS[preset].every((permission) => rest.has(permission))) {
      words.push(preset);
      for (const permission of PRESETS[preset]) rest.delete(permission);
    }
  }
  return [...words, ...PERMISSIONS.filter((permission) => rest.has(permission))].join(", ");
}

/** The words `cns peer grant` takes for these permissions, comma-separated: presets where a whole group is present. */
export function grantWords(grants: readonly Permission[]): string {
  return describeGrants(grants).replaceAll(", ", ",");
}

const DENIAL = /^Permission denied: ((?:[a-z:]+)(?:, [a-z:]+)*) not granted to ([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.$/;

/**
 * A refusal from a paired device, with what to do about it: the grant that is missing and
 * the command to run on that device, where it calls this one by the alias the refusal names.
 * `device` is this device's name for the other one; other messages come back unchanged.
 */
export function explainDenial(message: string, device?: string): string {
  const match = DENIAL.exec(message);
  if (!match) return message;
  let missing: Permission[];
  try { missing = expandGrants(match[1]!.split(", ")); } catch { return message; }
  if (!missing.length) return message;
  const where = device ? `on ${device}` : "on the other device";
  // A mesh member gets what the device lets every member of the mesh use, so that is what to widen there.
  let entry: PeerEntry | undefined;
  try { entry = device ? getPeer(device) : undefined; } catch { entry = undefined; }
  if (entry?.mesh) return `${message} ${device} gives members of the mesh ${entry.mesh} what cns mesh allow set there. To allow it, run ${where}: cns mesh allow ${entry.mesh} ${grantWords(expandGrants([...entry.grants.outgoing, ...missing]))}`;
  return `${message} To allow it, run ${where}: cns peer grant ${match[2]} ${grantWords(missing)}`;
}

/**
 * Features a saved record can need. A field that restricts or changes what a device may
 * do, such as an expiry on its grants, belongs to a feature, and a record that holds it
 * names the feature in `needs`. A cns refuses a record that needs a feature it does not
 * know, rather than ignore the field and let the device do more than it should; any other
 * field it does not know, at the top or in `grants`, it ignores. None yet: a feature is
 * named here and its fields marked with it in PEER_FIELDS, and recordText then lists it in
 * `needs` of every record that holds one of them. PEER_FIELDS has the rules a new field
 * keeps.
 */
const FEATURES = [] as const;
type Feature = typeof FEATURES[number];
const knownFeatures: ReadonlySet<string> = new Set<string>(FEATURES);

/**
 * What a cns that does not know a field does with it, for every field of a record:
 * - `base`: does not happen, as every cns that reads `needs` knows the field. Only fields
 *   from before `needs` are base (peers.test.ts).
 * - `informational`: ignores it and keeps it when it rewrites the record, so the field must
 *   be safe to ignore and to go stale, as a label or a last-seen time is.
 * - a feature: refuses the record, which lists that feature in `needs` (neededFeatures).
 * Since a cns keeps the fields it does not know when it rewrites a record, three rules hold:
 * a field's name is never reused with a new meaning; a released feature never gains fields,
 * as a new field means a new feature; and a field in `grants` that widens access is a
 * feature, never informational, since an older cns keeps it through `cns peer revoke`.
 */
type FieldKind = "base" | "informational" | Feature;
export const PEER_FIELDS = {
  record: { version: "base", needs: "base", publicKey: "base", addresses: "base", pairedAt: "base", grants: "base", mesh: "base", gateway: "informational" },
  grants: { incoming: "base", outgoing: "base" },
} as const satisfies { record: Record<keyof PairedPeer, FieldKind>; grants: Record<keyof PairedPeer["grants"], FieldKind> };

const base64url = /^[A-Za-z0-9_-]+$/;
export const publicKeySchema = z.string().regex(base64url).refine((value) => Buffer.from(value, "base64url").length === 32, "A public key is 32 bytes.");
const addressSchema = z.string().max(2048).refine((value) => { try { validatePeerUrl(value); return true; } catch { return false; } }, "A peer address is a ws:// or wss:// URL.");
const needsSchema = z.array(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)).max(16);
/** Fields this cns does not know are dropped when it reads a record; see FEATURES. */
export const pairedPeerSchema = z.object({
  version: z.literal(2),
  /** The features the record needs (FEATURES). Written only when there is one, so 2.4.0 and older, which refuse any field they do not know, still read every record that has no field newer than them. */
  needs: needsSchema.refine((needs) => needs.every((feature) => knownFeatures.has(feature)), "The record needs a feature this cns does not know.").optional(),
  publicKey: publicKeySchema,
  /** Where this device has reached the peer; tried in order. */
  addresses: z.array(addressSchema).max(16),
  pairedAt: z.iso.datetime(),
  grants: z.object({ incoming: grantsSchema, outgoing: grantsSchema }),
  /**
   * Set when the device is here because it is a member of this mesh (mesh.ts), not because
   * it paired with this one: the mesh's member list keeps the record and its incoming grants.
   * A cns older than meshes refuses the whole record, so it never lets a mesh member in. It
   * is older than `needs` too, so `needs` leaves mesh out: listing it would only make 2.4.0,
   * which knows meshes, refuse mesh records.
   */
  mesh: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/).optional(),
  /**
   * Set on a mesh's record for the cns gateway, which dials this device and is never dialed
   * (mesh.ts). Informational: it changes only whether this device dials the gateway, not what
   * the gateway may do here, so a cns that ignores it only knocks on the relay for nothing.
   */
  gateway: z.literal(true).optional(),
});
export type PairedPeer = z.infer<typeof pairedPeerSchema>;

/** A saved paired device: its record, the alias it is saved under and its key's fingerprint. */
export type PeerEntry = { name: string; fingerprint: string } & PairedPeer;

/**
 * A saved record this cns cannot use, with the key it names when that is a valid one. A
 * mesh saves no record of its own beside it for that device (planMesh): what this cns
 * cannot read may be what narrows the device's access, as in a newer cns's record.
 */
export class UnreadablePeer extends Error {
  constructor(message: string, readonly publicKey?: PublicKey) { super(message); }
}

function entryFor(name: string, content: string): PeerEntry {
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new UnreadablePeer(`Saved peer ${name} is not a paired-device record. Remove it with cns peer remove ${name}, then pair again.`); }
  const record = parsed as { publicKey?: unknown; needs?: unknown } | null;
  const key = publicKeySchema.safeParse(record?.publicKey).data;
  const missing = [...new Set(needsSchema.safeParse(record?.needs ?? []).data?.filter((feature) => !knownFeatures.has(feature)))];
  if (missing.length) {
    const which = process.platform === "win32" ? "Get-Command cns" : "command -v cns";
    throw new UnreadablePeer(`Saved peer ${name} needs ${missing.length === 1 ? "the feature" : "the features"} ${missing.join(", ")}, which this cns (${CNS_VERSION}) does not have, so it leaves ${name} out: a newer cns saved it. ` +
      `Update cns on this device, then restart its daemon: cns daemon restart. If the newer cns is installed already, ${which} shows which one a shell runs.`, key);
  }
  const peer = pairedPeerSchema.safeParse(parsed);
  if (!peer.success) throw new UnreadablePeer(`Saved peer ${name} is not a valid paired-device record: ${errorMessage(peer.error)}`, key);
  return { name, fingerprint: fingerprint(peer.data.publicKey), ...peer.data };
}

/** The features a record's fields need, as its `needs` lists them. */
function neededFeatures(record: PairedPeer): Feature[] {
  const used = (fields: Record<string, FieldKind>, value: object) => Object.entries(fields)
    .flatMap(([key, kind]) => kind === "base" || kind === "informational" || (value as Record<string, unknown>)[key] === undefined ? [] : [kind]);
  return [...new Set([...used(PEER_FIELDS.record, record), ...used(PEER_FIELDS.grants, record.grants)])].sort();
}

/**
 * A record as it is saved. `needs` is left out when the record needs nothing, so 2.4.0 and
 * older read it as before. The fields of `saved`, the record as it was, that this cns does
 * not know are kept: a newer cns wrote them, and by leaving them out of `needs` it said a
 * cns that does not know them may carry them along.
 */
function recordText(record: PairedPeer, saved?: unknown): string {
  const unknownFields = (value: unknown, known: object) => value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([key]) => !Object.hasOwn(known, key)))
    : {};
  const { version, needs: _needs, ...fields } = record;
  const needs = neededFeatures(record);
  const grants = { ...fields.grants, ...unknownFields((saved as { grants?: unknown } | undefined)?.grants, PEER_FIELDS.grants) };
  return JSON.stringify({ version, ...needs.length ? { needs } : {}, ...fields, grants, ...unknownFields(saved, PEER_FIELDS.record) }, null, 2) + "\n";
}

const reportInvalid = (name: string, error: unknown) => console.error(`cns: skipping saved peer ${name}: ${errorMessage(error)}`);

/**
 * Every saved paired device, sorted by name. A file
 * that cannot be read as a peer is reported and skipped, so one bad file never stops
 * the others from working; `getPeer` by name stays strict.
 */
export function listPeers(report: (name: string, error: unknown) => void = reportInvalid): PeerEntry[] {
  return peerNames().flatMap((name) => {
    try {
      const content = readPeerFile(name);
      return content === undefined ? [] : [entryFor(name, content)];
    } catch (error) {
      report(name, error);
      return [];
    }
  });
}

export function getPeer(name: string): PeerEntry | undefined {
  const content = readPeerFile(name);
  return content === undefined ? undefined : entryFor(name, content);
}

/** The key the file saved as `name` names, also when this cns cannot use the record; undefined when it names none. */
export function savedKey(name: string): PublicKey | undefined {
  try { return getPeer(name)?.publicKey; } catch (error) { return error instanceof UnreadablePeer ? error.publicKey : undefined; }
}

/**
 * Keep a removed device out (docs/adr/0010-removing-a-lost-device.md): no mesh gives the device
 * with fingerprint `fp` a record here again (planMesh), until this device pairs with it directly
 * (savePairedPeer). A fingerprint, so that a device never seen here can be kept out too.
 */
export function revokeDevice(fp: string, publicKey?: PublicKey): void {
  try { revokedFiles.create(fp, JSON.stringify({ version: 1, ...publicKey ? { publicKey } : {}, revokedAt: new Date().toISOString() }) + "\n"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}

/** The fingerprints of the devices removed here (revokeDevice). */
export function revokedDevices(): Set<string> {
  return new Set(revokedFiles.names());
}

/** The paired device with this key, under whatever alias it was saved. */
export function findPairedPeer(publicKey: PublicKey): PeerEntry | undefined {
  // Called for every connection: bad files are reported by listings, not here.
  for (const entry of listPeers(() => {})) if (entry.publicKey === publicKey) return entry;
  return undefined;
}

/** Save a newly paired device. The alias must be free, and the key must not be saved under another alias. */
export function savePairedPeer(name: string, peer: Omit<PairedPeer, "version">): void {
  peerFile(name);
  const existing = findPairedPeer(peer.publicKey);
  if (existing) throw new Error(`This device is already paired as ${existing.name}.`);
  const record: PairedPeer = pairedPeerSchema.parse({ version: 2, ...peer });
  // Pairing with a removed device again is the way back for it (revokeDevice); a mesh's record is
  // not. Looked up first, so that a revoked directory that cannot be read stops the pairing; the
  // entry goes only once the pairing is saved, so a pairing that fails leaves the device revoked.
  const fp = fingerprint(record.publicKey);
  const back = record.mesh === undefined && revokedFiles.exists(fp);
  createPeerFile(name, recordText(record));
  if (back) revokedFiles.remove(fp);
}

/** Change a paired device's record, for example its grants or addresses. Fields this cns does not know stay as they were. */
export function updatePairedPeer(name: string, change: (peer: PairedPeer) => PairedPeer): PairedPeer {
  const content = readPeerFile(name);
  if (content === undefined) throw new Error(`Unknown peer: ${name}`);
  const { name: _name, fingerprint: _fingerprint, ...current } = entryFor(name, content);
  const updated = pairedPeerSchema.parse(change(current));
  if (updated.publicKey !== current.publicKey) throw new Error("A paired device's key cannot change; pair with the new device instead.");
  rewritePeerFile(name, recordText(updated, JSON.parse(content)));
  return updated;
}

/** What a paired device says it can be reached at, as it arrives over a link: at most 16 valid addresses. */
export const advertisedSchema = z.array(addressSchema).max(16);

/**
 * A paired device's saved addresses once it has said where it can be reached now.
 * What it advertises replaces what it advertised before: a daemon advertises its
 * listening IP addresses and its relay's dial address, so those are dropped when it no
 * longer lists them. Kept as well are the address this device just reached it at, which
 * may be a port forward or a proxy the device does not know about, and saved hostnames,
 * which only a person adds. Direct addresses come first, relays last, at most 16 with room kept for relays.
 */
export function learnAddresses(saved: readonly string[], advertised: readonly string[], dialed?: string): string[] {
  const learnedByDaemon = (url: string) => {
    if (isRelayAddress(url)) return true;
    try { return isIP(new URL(url).hostname.replace(/^\[|\]$/g, "")) !== 0; } catch { return true; }
  };
  const kept = saved.filter((url) => url === dialed || !learnedByDaemon(url));
  // The same address written two ways, such as with and without a trailing slash, is kept once.
  const seen = new Set<string>();
  const all = [...advertised, ...kept].filter((url) => {
    const key = new URL(url).href;
    return !seen.has(key) && !!seen.add(key);
  });
  // Over the limit, direct addresses give way: the relay is what still works after a move.
  const relays = all.filter(isRelayAddress).slice(0, 4);
  return [...all.filter((url) => !isRelayAddress(url)).slice(0, 16 - relays.length), ...relays];
}

/** The paired device a command names: the identity to expect and every address to try. */
export function resolvePeer(name: string): { name: string; publicKey: PublicKey; outgoing: Permission[]; addresses: string[] } {
  const entry = getPeer(name);
  if (!entry) throw new Error(`No paired device is saved as ${name}. Pair with it first: cns pair. cns peers lists the paired devices.`);
  return { name, publicKey: entry.publicKey, outgoing: entry.grants.outgoing, addresses: entry.addresses };
}
