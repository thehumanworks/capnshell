import { z } from "zod";
import { errorMessage } from "./errors.js";
import { verify, type Identity, type PublicKey } from "./identity.js";
import { meshFiles, peerNamePattern, removePeerFile, validatePeerUrl } from "./peer-files.js";
import { expandGrants, grantsSchema, listPeers, publicKeySchema, savePairedPeer, updatePairedPeer, type PairedPeer, type PeerEntry, type Permission } from "./peers.js";

/**
 * A mesh: devices that all reach each other because one device, the mesh's admin, lists
 * them, instead of each pair of them pairing.
 *
 * The admin is the device that ran `cns mesh create`. It adds devices it is paired with
 * (`cns mesh add`), and removes them, by signing a new version of the member list with its
 * identity. A device takes part once its person runs `cns mesh join NAME --via ADMIN`, which
 * fetches the list from the admin over their pairing, so the admin's key is one this
 * device's person already confirmed. Each member decides what other members may use on it
 * (`cns mesh allow`), and the admin can narrow that for one member (`--limit`), never widen it.
 *
 * A member turns the list into paired-device records tagged with the mesh (planMesh), so
 * commands, links and grants work as for any paired device. A device paired directly keeps
 * its pairing. Daemons pass the newest list to each other over their links: a list is taken
 * only when its admin signed it and its version is newer than the one held, so any member
 * can carry it but none can change it. A device removed from the list drops the mesh's
 * records when it hears of it, and the others drop its record, which ends its links.
 */

export const MESH_PROTOCOL = "cns-mesh-list-1";
export const MAX_MEMBERS = 64;
const MAX_LIST_CHARS = 64 * 1024;
/** Meshes a device makes or joins, which is also how many lists it offers or takes in one exchange. */
export const MAX_MESHES = 8;

const nameSchema = z.string().regex(peerNamePattern, "Names contain 1-64 letters, numbers, underscores or hyphens and start with a letter or number.");
const addressSchema = z.string().max(2048).refine((value) => { try { validatePeerUrl(value); return true; } catch { return false; } });
const memberSchema = z.strictObject({
  key: publicKeySchema,
  /** The admin's name for it, which members call it by unless they use that name already. */
  name: nameSchema,
  /** Where the admin has reached it: hints members dial first, before the relay. */
  addresses: z.array(addressSchema).max(16).optional(),
  /** The most it may use on any member, whatever that member allows. */
  limit: grantsSchema.optional(),
});
export type Member = z.infer<typeof memberSchema>;
const listSchema = z.strictObject({
  v: z.literal(1),
  mesh: nameSchema,
  admin: publicKeySchema,
  version: z.int().positive(),
  issuedAt: z.iso.datetime(),
  members: z.array(memberSchema).min(1).max(MAX_MEMBERS),
}).superRefine((list, context) => {
  if (new Set(list.members.map((member) => member.key)).size !== list.members.length) context.addIssue({ code: "custom", message: "A device is listed twice." });
  if (new Set(list.members.map((member) => member.name)).size !== list.members.length) context.addIssue({ code: "custom", message: "A name is listed twice." });
  if (!list.members.some((member) => member.key === list.admin)) context.addIssue({ code: "custom", message: "The admin is not a member." });
});
export type MemberList = z.infer<typeof listSchema>;
/** A member list as it is kept and sent: its JSON text and the admin's signature over it. */
export const signedListSchema = z.strictObject({ text: z.string().max(MAX_LIST_CHARS), sig: z.string().regex(/^[A-Za-z0-9_-]{86}$/) });
export type SignedList = z.infer<typeof signedListSchema>;

const signedBytes = (text: string) => Buffer.from(`${MESH_PROTOCOL}\0${text}`, "utf8");

/** Sign a member list as its admin. */
export function signList(list: MemberList, identity: Identity): SignedList {
  if (list.admin !== identity.publicKey) throw new Error("Only the mesh's admin signs its member list.");
  const text = JSON.stringify(listSchema.parse(list));
  return { text, sig: Buffer.from(identity.sign(signedBytes(text))).toString("base64url") };
}

/** The member list a signed list carries, once its admin's signature checks out; with `admin`, it must be that admin's. */
export function openList(value: unknown, admin?: PublicKey): MemberList {
  const signed = signedListSchema.safeParse(value);
  if (!signed.success) throw new Error("Not a mesh member list.");
  let body: unknown;
  try { body = JSON.parse(signed.data.text); } catch { throw new Error("Not a mesh member list."); }
  const list = listSchema.safeParse(body);
  if (!list.success) throw new Error(`Not a valid mesh member list: ${errorMessage(list.error)}`);
  if (admin !== undefined && list.data.admin !== admin) throw new Error("The member list is another admin's.");
  if (!verify(list.data.admin, signedBytes(signed.data.text), Buffer.from(signed.data.sig, "base64url"))) throw new Error("The member list's signature is not its admin's.");
  return list.data;
}

/** A mesh as this device keeps it. */
export interface MeshState {
  name: string;
  /** The admin's key, fixed when this device made or joined the mesh. */
  admin: PublicKey;
  /** What members may use here. The admin's is empty: members reach it through their pairings with it, as they joined. */
  allow: Permission[];
  signed: SignedList;
  list: MemberList;
}
const meshFileSchema = z.strictObject({ version: z.literal(1), admin: publicKeySchema, allow: grantsSchema, list: signedListSchema });

/** The first list of a new mesh, with only its admin in it. */
export function firstList(mesh: string, admin: { key: PublicKey; name: string; addresses?: string[] }, now: number): MemberList {
  return listSchema.parse({ v: 1, mesh, admin: admin.key, version: 1, issuedAt: new Date(now).toISOString(), members: [{ key: admin.key, name: admin.name, ...admin.addresses?.length ? { addresses: admin.addresses } : {} }] });
}

/** The next version of a list, with `change` applied to its members. */
export function nextList(list: MemberList, change: (members: Member[]) => Member[], now: number): MemberList {
  return listSchema.parse({ ...list, version: list.version + 1, issuedAt: new Date(now).toISOString(), members: change(list.members.map((member) => ({ ...member }))) });
}

/** What a member may use here: what this device allows members, within that member's limit. */
export function memberGrants(allow: readonly Permission[], limit?: readonly Permission[]): Permission[] {
  const allowed = expandGrants(allow);
  return limit ? allowed.filter((permission) => limit.includes(permission)) : allowed;
}

/** The changes that bring this device's paired-device records in line with a mesh's member list. */
export interface MeshPlan {
  create: Array<{ name: string; record: Omit<PairedPeer, "version"> }>;
  update: Array<{ name: string; incoming: Permission[] }>;
  remove: Array<{ name: string; publicKey: PublicKey }>;
}

/**
 * What to save, change and remove so this device's records match `list`, given every record
 * it has now. Members get a record tagged with the mesh, named as the admin names them or,
 * when that name is taken here, name-2 and so on, granted memberGrants. A device this one
 * paired with directly, or knows through another mesh, keeps its record. When this device
 * is not in the list, as after the admin removed it, every record of the mesh goes. Records
 * are between members: the admin is paired with each of them directly.
 */
export function planMesh({ self, mesh, allow, list, records, now }: { self: PublicKey; mesh: string; allow: readonly Permission[]; list: MemberList; records: readonly PeerEntry[]; now: number }): MeshPlan {
  const plan: MeshPlan = { create: [], update: [], remove: [] };
  // Every member is paired with the admin directly, as it joined through that pairing, so the
  // admin keeps no records for its mesh and nobody keeps one for the admin. A device the list
  // does not hold keeps none.
  const members = self !== list.admin && list.members.some((member) => member.key === self) ? list.members.filter((member) => member.key !== self && member.key !== list.admin) : [];
  const keys = new Set(members.map((member) => member.key));
  for (const record of records) if (record.mesh === mesh && !keys.has(record.publicKey)) plan.remove.push({ name: record.name, publicKey: record.publicKey });
  const taken = new Set(records.map((record) => record.name));
  for (const member of members) {
    const incoming = memberGrants(allow, member.limit);
    const existing = records.find((record) => record.publicKey === member.key);
    if (existing) {
      if (existing.mesh !== mesh) continue;
      const current = existing.grants.incoming;
      if (current.length !== incoming.length || current.some((permission, index) => permission !== incoming[index])) plan.update.push({ name: existing.name, incoming });
      continue;
    }
    let name = member.name;
    for (let n = 2; taken.has(name); n++) name = `${member.name.slice(0, 60)}-${n}`;
    taken.add(name);
    plan.create.push({ name, record: { publicKey: member.key, addresses: member.addresses ?? [], pairedAt: new Date(now).toISOString(), grants: { incoming, outgoing: [] }, mesh } });
  }
  return plan;
}

/** The member lists among `offered` whose admin signed them; anything else is ignored. */
export function openLists(offered: unknown): Array<{ signed: SignedList; list: MemberList }> {
  if (!Array.isArray(offered)) return [];
  return offered.slice(0, MAX_MESHES).flatMap((value) => {
    try { return [{ signed: signedListSchema.parse(value), list: openList(value) }]; } catch { return []; }
  });
}

/**
 * The lists among `offered` that are newer than this device's for a mesh it is in, signed
 * by that mesh's admin, as the states to keep. Anything else offered, such as an older
 * version, another admin's list or one for a mesh this device is not in, is ignored.
 */
export function newerLists(states: readonly MeshState[], offered: unknown): MeshState[] {
  const newer = new Map<string, MeshState>();
  for (const { signed, list } of openLists(offered)) {
    const state = states.find((candidate) => candidate.name === list.mesh && candidate.admin === list.admin);
    if (!state || list.version <= (newer.get(list.mesh) ?? state).list.version) continue;
    newer.set(list.mesh, { ...state, signed, list });
  }
  return [...newer.values()];
}

/**
 * The meshes this device should leave, having heard from `from` what it offers: a mesh's
 * admin offers each device the list of every mesh it has that device in (listsFor), so a
 * mesh it runs and did not offer has dropped this device, or ended.
 */
export function droppedBy(from: PublicKey, self: PublicKey, states: readonly MeshState[], offered: unknown): string[] {
  if (from === self) return [];
  const lists = openLists(offered).map(({ list }) => list);
  return states.filter((state) => state.admin === from && !lists.some((list) => list.mesh === state.name && list.admin === from)).map((state) => state.name);
}

/** The lists to offer a device: those of the meshes it is a member of, so nobody else learns who is in them. */
export function listsFor(peer: PublicKey, states: readonly MeshState[]): SignedList[] {
  return states.filter((state) => state.list.members.some((member) => member.key === peer)).slice(0, MAX_MESHES).map((state) => state.signed);
}

/** This device's state for the mesh `name`, if it made or joined one by that name. */
export function readMesh(name: string): MeshState | undefined {
  const content = meshFiles.read(name);
  if (content === undefined) return undefined;
  const file = meshFileSchema.parse(JSON.parse(content));
  return { name, admin: file.admin, allow: file.allow, signed: file.list, list: openList(file.list, file.admin) };
}

/**
 * Every mesh this device made or joined. One that cannot be read throws rather than being
 * left out, so that nothing acts on part of them: a device that offered a mesh's members
 * every list but one would tell them they had been dropped from it (droppedBy).
 */
export function listMeshes(): MeshState[] {
  return meshFiles.names().flatMap((name) => {
    try { const state = readMesh(name); return state ? [state] : []; }
    catch (error) { throw new Error(`The mesh ${name} saved here cannot be read: ${errorMessage(error)} cns mesh leave ${name} forgets it.`, { cause: error }); }
  });
}

/** Save this device's state for a mesh, replacing what it had. */
export function writeMesh(state: Pick<MeshState, "name" | "admin" | "allow" | "signed">): void {
  const content = JSON.stringify(meshFileSchema.parse({ version: 1, admin: state.admin, allow: expandGrants(state.allow), list: state.signed }), null, 2) + "\n";
  if (meshFiles.exists(state.name)) meshFiles.rewrite(state.name, content);
  else meshFiles.create(state.name, content);
}

/** Forget a mesh here. Its records go at the next applyMeshes. */
export function removeMesh(name: string): void {
  if (meshFiles.exists(name)) meshFiles.remove(name);
}

/**
 * Bring this device's records in line with every mesh's list (planMesh), and say what
 * changed. Records of a mesh this device no longer has go first. A device dropped from one
 * mesh may be in another, which can take it only once the first has let go of its record,
 * so a pass that removed records is followed by one more.
 */
export function applyMeshes(self: PublicKey, now = Date.now()): MeshPlan {
  const states = listMeshes();
  const total: MeshPlan = { create: [], update: [], remove: [] };
  const kept = new Set(states.map((state) => state.name));
  for (const record of listPeers(() => {})) {
    if (record.mesh === undefined || kept.has(record.mesh)) continue;
    removePeerFile(record.name);
    total.remove.push({ name: record.name, publicKey: record.publicKey });
  }
  for (let pass = 0; pass < 2; pass++) {
    let removed = false;
    for (const state of states) {
      const plan = planMesh({ self, mesh: state.name, allow: state.allow, list: state.list, records: listPeers(() => {}), now });
      for (const { name } of plan.remove) removePeerFile(name);
      for (const { name, incoming } of plan.update) updatePairedPeer(name, (peer) => ({ ...peer, grants: { ...peer.grants, incoming } }));
      for (const { name, record } of plan.create) savePairedPeer(name, record);
      total.create.push(...plan.create);
      total.update.push(...plan.update);
      total.remove.push(...plan.remove);
      removed ||= plan.remove.length > 0;
    }
    if (!removed) break;
  }
  return total;
}
