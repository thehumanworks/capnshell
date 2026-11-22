import os from "node:os";
import { errorMessage } from "../errors.js";
import { ensureIdentity, fingerprint, newKeyPair, type PublicKey } from "../identity.js";
import { mintBotToken } from "../mesh-token.js";
import { applyMeshes, firstList, listMeshes, listsFor, MAX_MESHES, nextList, openLists, readMesh, removeMesh, signList, writeMesh, type Member, type MeshState } from "../mesh.js";
import { meshFiles, peerNamePattern } from "../peer-files.js";
import { suggestedName } from "../pairing.js";
import { describeGrants, expandGrants, getPeer, listPeers, resolvePeer, savePairedPeer, type Permission } from "../peers.js";
import { connectDevice } from "./connect-device.js";
import { connectControl } from "./daemon.js";
import { removePeer } from "./pairing-cli.js";

interface StateOption { state?: string }

/** How long cns mesh join waits for the admin to answer. */
const JOIN_MS = 30_000;

const grantsFrom = (words: readonly string[] | string | undefined): Permission[] =>
  expandGrants((Array.isArray(words) ? words : words === undefined ? [] : [words]).flatMap((word) => word.split(",")).map((word) => word.trim()).filter(Boolean));

function requireMesh(name: string): MeshState {
  const state = readMesh(name);
  if (!state) throw new Error(`This device has no mesh named ${name}. cns mesh list shows its meshes.`);
  return state;
}

/** The mesh `name`, which this device must run. */
function adminOf(name: string, self: PublicKey): MeshState {
  const state = requireMesh(name);
  if (state.admin !== self) throw new Error(`Only the mesh's admin changes who is in it: run this on ${adminName(state)}.`);
  return state;
}

/** What this device calls a mesh's admin. */
function adminName(state: MeshState): string {
  return listPeers(() => {}).find((peer) => peer.publicKey === state.admin && peer.mesh === undefined)?.name ?? `the device with fingerprint ${fingerprint(state.admin)}`;
}

/** Refuse a new mesh where this device already has one by that name, or has as many as it may. */
function checkRoom(name: string): void {
  if (!peerNamePattern.test(name)) throw new Error("Mesh names contain 1-64 letters, numbers, underscores or hyphens and start with a letter or number.");
  if (meshFiles.exists(name)) throw new Error(`This device already has a mesh named ${name}. cns mesh list shows it.`);
  if (listMeshes().length >= MAX_MESHES) throw new Error(`This device is in ${MAX_MESHES} meshes, as many as it may be. Leave one first: cns mesh leave NAME.`);
}

/**
 * Tell the running daemon that the mesh lists saved here changed, so it brings the records in
 * line and offers linked devices the new lists. With no daemon, bring the records in line
 * here; the daemon offers the lists when it starts. Says whether a daemon took the change.
 */
async function settle(options: StateOption, self: PublicKey): Promise<boolean> {
  let control: Awaited<ReturnType<typeof connectControl>>;
  try { control = await connectControl(options.state); }
  catch { applyMeshes(self); return false; }
  try {
    await control.remote.meshChanged();
    return true;
  } catch (error) {
    applyMeshes(self);
    console.error(`The running daemon did not take the change (${errorMessage(error)}). Restart it so it does: cns stop, then cns up.`);
    return false;
  } finally { control.close(); }
}

/** `cns mesh create NAME`: start a mesh that this device runs, with only this device in it. */
export async function createMesh(name: string, options: StateOption): Promise<void> {
  checkRoom(name);
  const { identity } = ensureIdentity();
  const list = firstList(name, { key: identity.publicKey, name: suggestedName(os.hostname()) }, Date.now());
  writeMesh({ name, admin: identity.publicKey, allow: [], signed: signList(list, identity) });
  await settle(options, identity.publicKey);
  console.log(`Created the mesh ${name}, run by this device. Add devices paired with this one: cns mesh add ${name} DEVICE.`);
}

/** `cns mesh add NAME DEVICE...`: put paired devices in the mesh, or change the limit of ones in it. */
export async function addMembers(name: string, devices: string[], options: StateOption & { limit?: string }): Promise<void> {
  const { identity } = ensureIdentity();
  const state = adminOf(name, identity.publicKey);
  const limit = options.limit === undefined ? undefined : grantsFrom(options.limit);
  const added: Member[] = devices.map((device) => {
    const entry = getPeer(device);
    if (!entry) throw new Error(`No paired device is saved as ${device}. Pair with it first: cns pair.`);
    if (entry.mesh !== undefined) throw new Error(`${device} is here as a member of the mesh ${entry.mesh}. A mesh takes only devices paired with its admin directly, which they join through.`);
    return { key: entry.publicKey, name: device, ...entry.addresses.length ? { addresses: entry.addresses } : {}, ...limit ? { limit } : {} };
  });
  const keys = new Set(added.map((member) => member.key));
  const list = nextList(state.list, (members) => [...members.filter((member) => !keys.has(member.key)), ...added], Date.now());
  writeMesh({ ...state, signed: signList(list, identity) });
  const live = await settle(options, identity.publicKey);
  console.log(`The mesh ${name} lists ${devices.join(", ")} (version ${list.version})${limit ? `, each limited to ${describeGrants(limit)} on other members` : ""}.`);
  console.log(`On each, run: cns mesh join ${name} --via DEVICE, where DEVICE is its name for this device.`);
  if (!live) console.log("Start this device's daemon so members get the new list: cns up.");
}

/**
 * `cns mesh token NAME BOT --allow GRANTS`: a token that makes a machine nobody sits at a
 * member of the mesh, as BOT (mesh-token.ts). The token goes to stdout, once, so it can be
 * piped into a secret store; this device keeps only the bot's public key.
 */
export async function botToken(name: string, bot: string, options: StateOption & { allow?: string; limit?: string }): Promise<void> {
  const { identity } = ensureIdentity();
  const state = adminOf(name, identity.publicKey);
  if (options.allow === undefined) throw new Error("Say what other members may use on the bot: --allow none, shell, files, sessions, all, or permissions.");
  const allow = grantsFrom(options.allow);
  const limit = options.limit === undefined ? undefined : grantsFrom(options.limit);
  if (!peerNamePattern.test(bot)) throw new Error("Names contain 1-64 letters, numbers, underscores or hyphens and start with a letter or number.");
  if (state.list.members.some((member) => member.name === bot)) throw new Error(`The mesh ${name} already lists a member named ${bot}. Choose another name, or check the existing member with cns mesh list ${name}.`);
  const peer = getPeer(bot);
  if (peer) {
    const mesh = peer.mesh ?? listMeshes().find((state) => state.list.members.some((member) => member.key === peer.publicKey))?.name;
    if (mesh) throw new Error(`${bot} is saved here for a member of the mesh ${mesh}. Choose another name.`);
    throw new Error(`${bot} is still paired with this device (fingerprint ${peer.fingerprint}). If this is the old bot, run cns peer remove ${bot}, then retry. Otherwise choose another name.`);
  }
  // Where the bot reaches this device: what the running daemon advertises, else the relay alone.
  let addresses: string[] = [];
  try {
    const control = await connectControl(options.state);
    try { addresses = (await control.remote.status()).addresses ?? []; } finally { control.close(); }
  } catch { /* No daemon: the bot finds this device at the relay, once its daemon runs. */ }
  const keys = newKeyPair();
  const list = nextList(state.list, (members) => [...members, { key: keys.publicKey, name: bot, ...limit ? { limit } : {} }], Date.now());
  const signed = signList(list, identity);
  const token = mintBotToken(keys.privateKey, signed, addresses.slice(0, 16), allow);
  savePairedPeer(bot, { publicKey: keys.publicKey, addresses: [], pairedAt: new Date().toISOString(), grants: { incoming: [], outgoing: [] } });
  writeMesh({ ...state, signed });
  const live = await settle(options, identity.publicKey);
  console.log(token);
  console.error([
    `Token for ${bot} (fingerprint ${fingerprint(keys.publicKey)}), a member of ${name} (version ${list.version}). Members may use there: ${describeGrants(allow)}${limit ? `; it may use at most ${describeGrants(limit)} on them` : ""}.`,
    `Token length: ${token.length} characters, including the prefix. Anyone who has it can act as ${bot}. This device keeps no copy: store it as a secret now.`,
    `On the bot's machine: CNS_TOKEN=<token> cns up, so members reach it; any cns command there reaches them.`,
    `It may use nothing on this device; cns peer grant ${bot} GRANTS changes that. To revoke it and free the name: cns mesh remove ${name} ${bot} --unpair.`,
    ...live ? [] : ["Start this device's daemon so members get the new list and the bot can reach this device: cns up."],
  ].join("\n"));
}

/** `cns mesh remove NAME DEVICE... [--unpair]`: membership and direct pairing are separate. */
export async function removeMembers(name: string, devices: string[], options: StateOption & { unpair?: boolean }): Promise<void> {
  const { identity } = ensureIdentity();
  const state = adminOf(name, identity.publicKey);
  const keys = devices.map((device) => {
    const member = state.list.members.find((candidate) => candidate.name === device) ?? state.list.members.find((candidate) => candidate.key === getPeer(device)?.publicKey);
    if (!member) throw new Error(`${device} is not in the mesh ${name}. cns mesh list ${name} shows its members.`);
    if (member.key === identity.publicKey) throw new Error(`This device runs the mesh ${name}. To end the mesh, run: cns mesh leave ${name}.`);
    return member.key;
  });
  const paired = listPeers().filter((peer) => peer.mesh === undefined && keys.includes(peer.publicKey));
  if (options.unpair && paired.length) {
    const others = listMeshes().filter((mesh) => mesh.name !== name);
    for (const peer of paired) {
      const other = others.find((mesh) => mesh.list.members.some((member) => member.key === peer.publicKey));
      if (other) throw new Error(`${peer.name} is also listed in the mesh ${other.name}. Remove it from ${name} without --unpair to keep its pairing.`);
    }
  }
  const list = nextList(state.list, (members) => members.filter((member) => !keys.includes(member.key)), Date.now());
  writeMesh({ ...state, signed: signList(list, identity) });
  const live = await settle(options, identity.publicKey);
  console.log(`Removed ${devices.join(", ")} from the mesh ${name} (version ${list.version}). The other members drop ${keys.length === 1 ? "it" : "them"} when they get this list.`);
  for (const peer of paired) {
    if (options.unpair) await removePeer(peer.name, options, peer.publicKey);
    else console.log(`Still paired with this device: ${peer.name}. To unpair: cns peer remove ${peer.name}.`);
  }
  if (!live) console.log("Start this device's daemon so members get the new list: cns up.");
}

/** `cns mesh join NAME --via ADMIN`: take part in a mesh that a device paired with this one runs. */
export async function joinMesh(name: string, options: StateOption & { via: string; allow?: string }): Promise<void> {
  checkRoom(name);
  const expect = resolvePeer(options.via);
  if (getPeer(options.via)?.mesh !== undefined) throw new Error(`${options.via} is here as a mesh member. Join through the mesh's admin, a device paired with this one directly.`);
  const allow = grantsFrom(options.allow);
  const { identity } = ensureIdentity();
  const connection = await connectDevice(expect, AbortSignal.timeout(JOIN_MS));
  let answer: unknown;
  try {
    answer = await (connection.remote as unknown as { meshes(offered: unknown): Promise<unknown> }).meshes(listsFor(expect.publicKey, listMeshes()));
  } catch (error) {
    throw new Error(`${options.via} did not answer with its meshes: ${errorMessage(error)}. Its cns may be older than meshes; upgrade it there.`, { cause: error });
  } finally { connection.close(); }
  const found = openLists(answer).find(({ list }) => list.mesh === name && list.admin === expect.publicKey);
  if (!found?.list.members.some((member) => member.key === identity.publicKey)) {
    throw new Error(`${options.via} runs no mesh ${name} with this device in it. On ${options.via}, run: cns mesh add ${name} DEVICE, where DEVICE is its name for this device.`);
  }
  writeMesh({ name, admin: expect.publicKey, allow, signed: found.signed });
  await settle(options, identity.publicKey);
  const here = new Map(listPeers(() => {}).map((peer) => [peer.publicKey, peer.name]));
  const others = found.list.members.filter((member) => member.key !== identity.publicKey && member.key !== expect.publicKey).map((member) => here.get(member.key) ?? member.name);
  console.log(`Joined the mesh ${name}, run by ${options.via}. Other members: ${others.length ? others.join(", ") : "none yet"}.`);
  console.log(`Members may use here: ${describeGrants(allow)}.${allow.length ? "" : ` To let them, run: cns mesh allow ${name} shell (or files, sessions, all).`}`);
}

/** `cns mesh allow NAME GRANTS...`: what every member of the mesh may use on this device. */
export async function allowMembers(name: string, words: string[], options: StateOption): Promise<void> {
  const { identity } = ensureIdentity();
  const state = requireMesh(name);
  if (state.admin === identity.publicKey) throw new Error(`This device runs the mesh ${name}, so members reach it through their pairings with it: cns peer grant DEVICE GRANTS changes what each may use.`);
  const allow = grantsFrom(words);
  writeMesh({ ...state, allow });
  await settle(options, identity.publicKey);
  console.log(`Members of the mesh ${name} may use here: ${describeGrants(allow)}.`);
}

/** `cns mesh leave NAME`: forget a mesh here, and its members with it; on its admin, end the mesh. */
export async function leaveMesh(name: string, options: StateOption): Promise<void> {
  if (!meshFiles.exists(name)) throw new Error(`This device has no mesh named ${name}. cns mesh list shows its meshes.`);
  const { identity } = ensureIdentity();
  let state: MeshState | undefined;
  try { state = readMesh(name); } catch { /* An unreadable mesh is forgotten all the same. */ }
  removeMesh(name);
  await settle(options, identity.publicKey);
  if (state?.admin === identity.publicKey) console.log(`Ended the mesh ${name}. Its members leave it when they next reach this device.`);
  else console.log(`Left the mesh ${name}.${state ? ` ${adminName(state)} still lists this device; to have the other members drop it too, run there: cns mesh remove ${name} DEVICE.` : ""}`);
}

/** `cns mesh list [NAME]`: the meshes this device is in, with their members. */
export function listMeshesCommand(name: string | undefined, options: { json?: boolean }): void {
  const { identity } = ensureIdentity();
  const states = name === undefined ? listMeshes() : [requireMesh(name)];
  const here = new Map(listPeers(() => {}).map((peer) => [peer.publicKey, peer.name]));
  const rows = states.map((state) => ({
    name: state.name,
    admin: state.admin === identity.publicKey ? "this device" : adminName(state),
    version: state.list.version,
    issuedAt: state.list.issuedAt,
    allow: state.admin === identity.publicKey ? null : state.allow,
    members: state.list.members.map((member) => ({
      name: member.key === identity.publicKey ? "this device" : here.get(member.key) ?? member.name,
      fingerprint: fingerprint(member.key),
      admin: member.key === state.admin,
      limit: member.limit ?? null,
    })),
  }));
  if (options.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { console.error("This device is in no mesh. Start one with cns mesh create NAME, or join one with cns mesh join NAME --via DEVICE."); return; }
  for (const row of rows) {
    console.log(`${row.name}: run by ${row.admin}, version ${row.version}${row.allow ? `; members may use here: ${describeGrants(row.allow)}` : ""}`);
    for (const member of row.members) {
      console.log(`  ${member.name}${member.admin ? " (admin)" : ""}\t${member.fingerprint}${member.limit ? `\tlimited to ${describeGrants(member.limit)}` : ""}`);
    }
  }
}
