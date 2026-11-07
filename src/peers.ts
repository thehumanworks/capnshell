import { z } from "zod";
import { createPeerFile, isPairedEntry, peerFile, peerNames, readPeerFile, rewritePeerFile, validatePeerUrl } from "./aliases.js";
import { errorMessage } from "./errors.js";
import { fingerprint, type PublicKey } from "./identity.js";

/**
 * Paired devices, saved under an alias in the peers directory beside plain address
 * aliases. Trust is keyed by the device's public key; the alias is only this user's
 * name for it. Grants are directional: `incoming` is what this device lets the peer
 * do here, enforced here; `outgoing` is what the peer said it lets this device do,
 * kept for display and enforced there.
 */

export const PERMISSIONS = ["shell", "files", "sessions:list", "sessions:create", "sessions:view", "sessions:control", "sessions:kill"] as const;
export type Permission = typeof PERMISSIONS[number];
export const PRESETS: Record<"shell" | "files" | "sessions" | "all", readonly Permission[]> = {
  shell: ["shell"],
  files: ["files"],
  sessions: ["sessions:list", "sessions:create", "sessions:view", "sessions:control", "sessions:kill"],
  all: PERMISSIONS,
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
  return `${message} To allow it, run ${where}: cns peer grant ${match[2]} ${grantWords(missing)}`;
}

const base64url = /^[A-Za-z0-9_-]+$/;
export const publicKeySchema = z.string().regex(base64url).refine((value) => Buffer.from(value, "base64url").length === 32, "A public key is 32 bytes.");
const addressSchema = z.string().max(2048).refine((value) => { try { validatePeerUrl(value); return true; } catch { return false; } }, "A peer address is a ws:// or wss:// URL.");
export const pairedPeerSchema = z.strictObject({
  version: z.literal(2),
  publicKey: publicKeySchema,
  /** Where this device has reached the peer; tried in order. */
  addresses: z.array(addressSchema).max(16),
  pairedAt: z.iso.datetime(),
  grants: z.strictObject({ incoming: grantsSchema, outgoing: grantsSchema }),
});
export type PairedPeer = z.infer<typeof pairedPeerSchema>;

export type PeerEntry =
  | { name: string; kind: "paired"; fingerprint: string } & PairedPeer
  | { name: string; kind: "address"; url: string };

function entryFor(name: string, content: string): PeerEntry {
  if (!isPairedEntry(content)) return { name, kind: "address", url: validatePeerUrl(content.trim()) };
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { throw new Error(`Saved peer ${name} is not valid JSON.`); }
  const peer = pairedPeerSchema.safeParse(parsed);
  if (!peer.success) throw new Error(`Saved peer ${name} is not a valid paired-device record: ${errorMessage(peer.error)}`);
  return { name, kind: "paired", fingerprint: fingerprint(peer.data.publicKey), ...peer.data };
}

const reportInvalid = (name: string, error: unknown) => console.error(`cns: skipping saved peer ${name}: ${errorMessage(error)}`);

/**
 * Every saved peer, address aliases and paired devices alike, sorted by name. A file
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

/** The paired device with this key, under whatever alias it was saved. */
export function findPairedPeer(publicKey: PublicKey): (PeerEntry & { kind: "paired" }) | undefined {
  // Called for every connection: bad files are reported by listings, not here.
  for (const entry of listPeers(() => {})) if (entry.kind === "paired" && entry.publicKey === publicKey) return entry;
  return undefined;
}

/** Save a newly paired device. The alias must be free, and the key must not be saved under another alias. */
export function savePairedPeer(name: string, peer: Omit<PairedPeer, "version">): void {
  peerFile(name);
  const existing = findPairedPeer(peer.publicKey);
  if (existing) throw new Error(`This device is already paired as ${existing.name}.`);
  const record: PairedPeer = pairedPeerSchema.parse({ version: 2, ...peer });
  createPeerFile(name, JSON.stringify(record, null, 2) + "\n");
}

/** Change a paired device's record, for example its grants or addresses. */
export function updatePairedPeer(name: string, change: (peer: PairedPeer) => PairedPeer): PairedPeer {
  const entry = getPeer(name);
  if (!entry) throw new Error(`Unknown peer: ${name}`);
  if (entry.kind !== "paired") throw new Error(`${name} is a saved address, not a paired device.`);
  const { name: _name, kind: _kind, fingerprint: _fingerprint, ...current } = entry;
  const updated = pairedPeerSchema.parse(change(current));
  if (updated.publicKey !== current.publicKey) throw new Error("A paired device's key cannot change; pair with the new device instead.");
  rewritePeerFile(name, JSON.stringify(updated, null, 2) + "\n");
  return updated;
}

/** Whether a name is saved, without throwing where saved peers are unsupported. */
export function isSavedPeer(name: string): boolean {
  try { return getPeer(name) !== undefined; } catch { return false; }
}

/** What `--peer NAME` or a positional NAME means: an address to dial and, for a paired device, the identity to expect. */
export function resolvePeer(name: string): { url: string; peer?: { name: string; publicKey: PublicKey; outgoing: Permission[]; addresses: string[] } } {
  const entry = getPeer(name);
  if (!entry) throw new Error(`Unknown peer alias: ${name}`);
  if (entry.kind === "address") return { url: entry.url };
  if (!entry.addresses.length) throw new Error(`Paired device ${name} has no saved address. Add one with cns peer address ${name} ws://HOST:PORT`);
  return { url: entry.addresses[0]!, peer: { name, publicKey: entry.publicKey, outgoing: entry.grants.outgoing, addresses: entry.addresses } };
}
