import os from "node:os";
import { errorMessage } from "../errors.js";
import { ensureIdentity, fingerprint, loadIdentity, newKeyPair, type PublicKey } from "../identity.js";
import { mintBotToken, startAsBot } from "../mesh-token.js";
import { applyMeshes, endMesh, firstList, lastVersion, listMeshes, listsFor, MAX_MESHES, nextList, openLists, readMesh, removeMesh, signList, writeMesh, type Member, type MeshState } from "../mesh.js";
import { meshFiles, peerNamePattern } from "../peer-files.js";
import { DEFAULT_INVITE_MS, MAX_INVITE_MS, suggestedName } from "../pairing.js";
import { botTokenForCode, hostCode, MAX_WRONG_CODES, PairingCodeError, parseCode } from "../pairing-code.js";
import { builtInRelay } from "../relay-config.js";
import { describeGrants, expandGrants, getPeer, listPeers, resolvePeer, revokedDevices, savePairedPeer, type Permission } from "../peers.js";
import { heldSecrets } from "../secrets.js";
import { connectDevice } from "./connect-device.js";
import { connectControl } from "./daemon.js";
import { unpair } from "./pairing-cli.js";

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
export function adminName(state: MeshState): string {
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
export async function settle(options: StateOption, self: PublicKey): Promise<boolean> {
  let control: Awaited<ReturnType<typeof connectControl>>;
  try { control = await connectControl(options.state); }
  catch { applyMeshes(self); return false; }
  try {
    await control.remote.meshChanged();
    return true;
  } catch (error) {
    applyMeshes(self);
    console.error(`The running daemon did not take the change (${errorMessage(error)}). Restart it so it does: cns daemon restart.`);
    return false;
  } finally { control.close(); }
}

/** `cns mesh create NAME`: start a mesh that this device runs, with only this device in it. */
export async function createMesh(name: string, options: StateOption): Promise<void> {
  checkRoom(name);
  const { identity } = ensureIdentity();
  const list = firstList(name, { key: identity.publicKey, name: suggestedName(os.hostname()) }, Date.now(), lastVersion(name));
  writeMesh({ name, admin: identity.publicKey, allow: [], signed: signList(list, identity) });
  await settle(options, identity.publicKey);
  console.log(`Created the mesh ${name}, run by this device. Add devices paired with this one: cns mesh add ${name} DEVICE.`);
}

/**
 * `cns mesh add NAME DEVICE...`: put paired devices in the mesh, or change the limit of ones in it.
 * With --gateway, DEVICE is the cns gateway: members let it in and never dial it or share secrets
 * with it, and unless --limit says otherwise it may use on them at most what it may use here.
 */
export async function addMembers(name: string, devices: string[], options: StateOption & { limit?: string; gateway?: boolean }): Promise<void> {
  const { identity } = ensureIdentity();
  const state = adminOf(name, identity.publicKey);
  const limit = options.limit === undefined ? undefined : grantsFrom(options.limit);
  if (options.gateway && devices.length !== 1) throw new Error("Add the gateway on its own: cns mesh add NAME GATEWAY --gateway.");
  const added: Member[] = devices.map((device) => {
    const entry = getPeer(device);
    if (!entry) throw new Error(`No paired device is saved as ${device}. Pair with it first: cns pair.`);
    if (entry.mesh !== undefined) throw new Error(`${device} is here as a member of the mesh ${entry.mesh}. A mesh takes only devices paired with its admin directly, which they join through.`);
    if (options.gateway) return { key: entry.publicKey, name: device, limit: limit ?? entry.grants.incoming, gateway: true };
    // The gateway has no address and lets this device use nothing; as a plain member, members would dial it and share secrets with it.
    if (!entry.addresses.length && !entry.grants.outgoing.length) console.error(`${device} has no address and lets this device use nothing, as the cns gateway does. If it is the gateway, add it with --gateway instead.`);
    return { key: entry.publicKey, name: device, ...entry.addresses.length ? { addresses: entry.addresses } : {}, ...limit ? { limit } : {} };
  });
  const keys = new Set(added.map((member) => member.key));
  const list = nextList(state.list, (members) => [...members.filter((member) => !keys.has(member.key)), ...added], Date.now());
  writeMesh({ ...state, signed: signList(list, identity) });
  const live = await settle(options, identity.publicKey);
  if (options.gateway) {
    console.log(`The mesh ${name} lists the gateway as ${devices[0]} (version ${list.version}). It may use at most ${describeGrants(added[0]!.limit ?? [])} on each member, within what that member allows members.`);
    console.log("Connectors approved for all devices reach the members once the gateway lists its devices again (list_peers). Members on a cns from before 2.6.0 cannot read this list and leave the mesh: upgrade them, then run cns mesh join there again.");
  } else {
    console.log(`The mesh ${name} lists ${devices.join(", ")} (version ${list.version})${limit ? `, each limited to ${describeGrants(limit)} on other members` : ""}.`);
    console.log(`On each, run: cns mesh join ${name} --via DEVICE, where DEVICE is its name for this device.`);
  }
  if (!live) console.log("Start this device's daemon so members get the new list: cns up.");
}

/** Refuse BOT as a new bot's name in `state`: a member, or a device saved here, has it. */
function checkBotName(state: MeshState, bot: string): void {
  if (!peerNamePattern.test(bot)) throw new Error("Names contain 1-64 letters, numbers, underscores or hyphens and start with a letter or number.");
  if (state.list.members.some((member) => member.name === bot)) throw new Error(`The mesh ${state.name} already lists a member named ${bot}. Choose another name, or check the existing member with cns mesh list ${state.name}.`);
  const peer = getPeer(bot);
  if (peer) {
    const mesh = peer.mesh ?? listMeshes().find((state) => state.list.members.some((member) => member.key === peer.publicKey))?.name;
    if (mesh) throw new Error(`${bot} is saved here for a member of the mesh ${mesh}. Choose another name.`);
    throw new Error(`${bot} is still paired with this device (fingerprint ${peer.fingerprint}). If this is the old bot, run cns peer remove ${bot}, then retry. Otherwise choose another name.`);
  }
}

/**
 * `cns mesh token NAME BOT --allow GRANTS`: a token that makes a machine nobody sits at a
 * member of the mesh, as BOT (mesh-token.ts). The token goes to stdout, once, so it can be
 * piped into a secret store; this device keeps only the bot's public key.
 *
 * With --code, the token goes instead to the machine that types the short code this shows,
 * with `cns mesh join --code CODE`, through the relay as a pairing invite does
 * (pairing-code.ts). Nothing is saved here until a machine proves it knows the code, so a
 * code that expires or is typed wrong three times leaves the mesh as it was.
 */
export async function botToken(name: string, bot: string, options: StateOption & { allow?: string; limit?: string; code?: boolean; expires?: string }): Promise<void> {
  const { identity } = ensureIdentity();
  const state = adminOf(name, identity.publicKey);
  if (options.allow === undefined) throw new Error("Say what other members may use on the bot: --allow none, shell, files, sessions, all, or permissions.");
  const allow = grantsFrom(options.allow);
  const limit = options.limit === undefined ? undefined : grantsFrom(options.limit);
  checkBotName(state, bot);
  // Check what can fail before a code is shown.
  let byCode: { relay: string; minutes: number } | undefined;
  if (options.code) {
    const minutes = options.expires === undefined ? DEFAULT_INVITE_MS / 60_000 : Number(options.expires);
    if (!(minutes > 0 && minutes * 60_000 <= MAX_INVITE_MS)) throw new Error(`--expires takes minutes, up to ${MAX_INVITE_MS / 60_000}.`);
    const relay = builtInRelay();
    if (!relay) throw new Error("Codes go through the relay, which is off here (CNS_RELAY=off). Run cns mesh token without --code to print the token instead.");
    byCode = { relay, minutes };
  } else if (options.expires !== undefined) throw new Error("--expires goes with --code: a printed token does not expire.");
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
  const save = () => {
    savePairedPeer(bot, { publicKey: keys.publicKey, addresses: [], pairedAt: new Date().toISOString(), grants: { incoming: [], outgoing: [] } });
    writeMesh({ ...state, signed });
  };
  const about = `${bot} (fingerprint ${fingerprint(keys.publicKey)}), a member of ${name} (version ${list.version}). Members may use there: ${describeGrants(allow)}${limit ? `; it may use at most ${describeGrants(limit)} on them` : ""}.`;
  const after = [
    `It may use nothing on this device; cns peer grant ${bot} GRANTS changes that. To revoke it and free the name: cns mesh remove ${name} ${bot} --unpair.`,
  ];
  if (!byCode) {
    save();
    const live = await settle(options, identity.publicKey);
    console.log(token);
    console.error([
      `Token for ${about}`,
      `Token length: ${token.length} characters, including the prefix. Anyone who has it can act as ${bot}. This device keeps no copy: store it as a secret now.`,
      `On the bot's machine: CNS_TOKEN=<token> cns up, so members reach it; any cns command there reaches them.`,
      ...after,
      ...live ? [] : ["Start this device's daemon so members get the new list and the bot can reach this device: cns up."],
    ].join("\n"));
    return;
  }
  let saved = false;
  let hosted: Awaited<ReturnType<typeof hostCode>>;
  try {
    hosted = await hostCode(byCode.relay, token, {
      wrong: (tries) => console.error(`A machine typed a wrong code (${tries} of ${MAX_WRONG_CODES} tries).`),
      deliver: () => {
        // The admin may have changed the mesh in another terminal while the code waited.
        const now = readMesh(name);
        if (now?.admin !== state.admin || now.list.version !== state.list.version) throw new Error(`The mesh ${name} changed while the code waited, so ${bot} was not added. Run cns mesh token again for a new code.`);
        checkBotName(now, bot);
        save();
        saved = true;
      },
    });
  } catch (error) {
    throw new Error(`Cannot get a code from the relay (${errorMessage(error)}). Run cns mesh token without --code to print the token instead.`, { cause: error });
  }
  const expiry = `${byCode.minutes} minute${byCode.minutes === 1 ? "" : "s"}`;
  console.log(`Code: ${hosted.code}`);
  console.error(`On the bot's machine, run: cns mesh join --code ${hosted.code}\nWaiting for it (the code works once and expires in ${expiry})...`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new PairingCodeError("expired", `The code expired unused, so ${bot} was not added. Run cns mesh token again for a new code.`)), byCode.minutes * 60_000);
  });
  try { await Promise.race([hosted.delivered, expired]); }
  catch (error) {
    if (!saved) {
      process.exitCode = 3;
      throw error instanceof PairingCodeError && error.code === "wrong" ? new Error(`${error.message} ${bot} was not added.`) : error;
    }
    // Saved, then the exchange failed: the token may not have reached the machine.
    console.error(`${bot} was added, but the token may not have reached the machine (${errorMessage(error)}). If that machine does not say it joined, run: cns mesh remove ${name} ${bot} --unpair.`);
  } finally {
    clearTimeout(timer);
    hosted.close();
  }
  const live = await settle(options, identity.publicKey);
  console.error([
    `Sent the token for ${about}`,
    `This device keeps no copy, and the code no longer works.`,
    ...after,
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
    if (member.key === identity.publicKey) throw new Error(`This device runs the mesh ${name}, so it stays in it. To end the mesh once the others are out, run: cns mesh delete ${name}.`);
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
    if (options.unpair) { await unpair(peer.name, peer.publicKey, options.state); console.log(`Removed ${peer.name}.`); }
    else console.log(`Still paired with this device: ${peer.name}. To unpair: cns peer remove ${peer.name}.`);
  }
  if (!live) console.log("Start this device's daemon so members get the new list: cns up.");
}

/** `cns mesh join NAME --via ADMIN`: take part in a mesh that a device paired with this one runs. With --code, become a bot instead (joinByCode). */
export async function joinMesh(name: string | undefined, options: StateOption & { via?: string; allow?: string; code?: string[] }): Promise<void> {
  if (options.code !== undefined) { await joinByCode(name, { ...options, code: options.code }); return; }
  if (name === undefined || options.via === undefined) throw new Error("Say which mesh and its admin: cns mesh join NAME --via DEVICE. For a code from cns mesh token --code: cns mesh join --code CODE.");
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

/**
 * `cns mesh join --code CODE`: make this machine the bot whose token the admin's
 * `cns mesh token NAME BOT --code` sends, as CNS_TOKEN would. The code brings the mesh, the
 * bot's name and what members may use here, as the admin chose them.
 */
async function joinByCode(name: string | undefined, options: { via?: string; allow?: string; code: string[] }): Promise<void> {
  if (name !== undefined || options.via !== undefined || options.allow !== undefined) {
    throw new Error("With --code, give only the code: it brings the mesh, this machine's name in it and what members may use here, as the admin chose them. cns mesh allow changes that later.");
  }
  // Check what can fail before the code is used up and the admin adds the bot.
  const code = parseCode(options.code, "bot");
  const existing = loadIdentity();
  if (existing) {
    throw new Error(`This machine is already a cns device (fingerprint ${existing.fingerprint}), and a bot token would replace it, so the code was not used. To put this device in the mesh as it is, pair it with the mesh's admin (cns pair), then run cns mesh join NAME --via ADMIN. To run a bot beside it, set CNS_CONFIG_DIR to an empty directory first.`);
  }
  const relay = builtInRelay();
  if (!relay) {
    process.exitCode = 3;
    throw new PairingCodeError("relay", "Codes go through the relay, which is off here (CNS_RELAY=off). On the admin, run cns mesh token without --code and give the token to this machine in CNS_TOKEN.");
  }
  let text: string;
  try { text = await botTokenForCode(relay, code); }
  catch (error) { if (error instanceof PairingCodeError) process.exitCode = 3; throw error; }
  const { token } = startAsBot(text, "code");
  const { list, keys } = token;
  const self = list.members.find((member) => member.key === keys.publicKey)!;
  const here = new Map(listPeers(() => {}).map((peer) => [peer.publicKey, peer.name]));
  const admin = here.get(list.admin) ?? "the admin";
  const others = list.members.filter((member) => member.key !== keys.publicKey && member.key !== list.admin).map((member) => here.get(member.key) ?? member.name);
  console.log(`Joined the mesh ${list.mesh} as ${self.name} (fingerprint ${fingerprint(keys.publicKey)}), run by ${admin}. Other members: ${others.length ? others.join(", ") : "none yet"}.`);
  console.log(`Members may use here: ${describeGrants(token.allow)}, as the admin chose; cns mesh allow ${list.mesh} GRANTS changes it.`);
  console.log("Start it so members reach it: cns up.");
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

/** The members of a mesh other than this device, its admin, by the names cns mesh remove takes. */
function otherMembers(state: MeshState, self: PublicKey): string[] {
  return state.list.members.filter((member) => member.key !== self).map((member) => member.name);
}

/** How the admin ends its mesh: the members go first, then the mesh. */
function howToDelete(name: string, others: readonly string[]): string {
  return others.length ? `cns mesh remove ${name} ${others.join(" ")}, then cns mesh delete ${name}` : `cns mesh delete ${name}`;
}

/**
 * `cns mesh leave NAME`: forget a mesh here, and its members with it. The device that runs
 * the mesh cannot leave it, since nobody else could then change it: it deletes it (deleteMesh).
 */
export async function leaveMesh(name: string, options: StateOption): Promise<void> {
  if (!meshFiles.exists(name)) throw new Error(`This device has no mesh named ${name}. cns mesh list shows its meshes.`);
  const { identity } = ensureIdentity();
  let state: MeshState | undefined;
  try { state = readMesh(name); } catch { /* An unreadable mesh is forgotten all the same. */ }
  if (state?.admin === identity.publicKey) {
    throw new Error(`This device runs the mesh ${name}, so it cannot leave it. To end the mesh, run: ${howToDelete(name, otherMembers(state, identity.publicKey))}.`);
  }
  removeMesh(name);
  await settle(options, identity.publicKey);
  console.log(`Left the mesh ${name}.${state ? ` ${adminName(state)} still lists this device; to have the other members drop it too, run there: cns mesh remove ${name} DEVICE.` : ""}`);
}

/**
 * `cns mesh delete NAME`: on the device that runs it, end a mesh with no member left but
 * this device. The members are removed first, each by name (cns mesh remove), so that
 * deleting a mesh never takes a device out of it that its person did not mean to. The
 * mesh's secrets held here go with it.
 */
export async function deleteMesh(name: string, options: StateOption): Promise<void> {
  const { identity } = ensureIdentity();
  const self = identity.publicKey;
  const state = requireMesh(name);
  if (state.admin !== self) throw new Error(`Only the device that runs a mesh deletes it, and ${adminName(state)} runs ${name}. To take this device out of it, run: cns mesh leave ${name}.`);
  const others = otherMembers(state, self);
  if (others.length) {
    throw new Error(`The mesh ${name} still has ${others.length === 1 ? "a member" : `${others.length} members`}: ${others.join(", ")}. Remove ${others.length === 1 ? "it" : "them"} first: ${howToDelete(name, others)}.`);
  }
  const secrets = new Set(heldSecrets(self, [state]).filter(({ record }) => record.value !== undefined).map(({ record }) => `${record.name} ${record.device ?? ""}`)).size;
  endMesh(state);
  await settle(options, self);
  console.log(`Deleted the mesh ${name}.${secrets ? ` Its ${secrets === 1 ? "secret" : `${secrets} secrets`} went with it.` : ""}`);
}

/** `cns mesh list [NAME]`: the meshes this device is in, with their members. */
export function listMeshesCommand(name: string | undefined, options: { json?: boolean }): void {
  const { identity } = ensureIdentity();
  const states = name === undefined ? listMeshes() : [requireMesh(name)];
  const here = new Map(listPeers(() => {}).map((peer) => [peer.publicKey, peer.name]));
  const revoked = revokedDevices();
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
      gateway: member.gateway === true,
      limit: member.limit ?? null,
      // Removed here (cns peer remove): it gets no record here from this mesh, and lists it signs are not taken.
      revoked: revoked.has(fingerprint(member.key)),
    })),
  }));
  if (options.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { console.error("This device is in no mesh. Start one with cns mesh create NAME, or join one with cns mesh join NAME --via DEVICE."); return; }
  for (const row of rows) {
    console.log(`${row.name}: run by ${row.admin}, version ${row.version}${row.allow ? `; members may use here: ${describeGrants(row.allow)}` : ""}`);
    for (const member of row.members) {
      console.log(`  ${member.name}${member.admin ? " (admin)" : member.gateway ? " (gateway)" : ""}${member.revoked ? " (revoked)" : ""}\t${member.fingerprint}${member.limit ? `\tlimited to ${describeGrants(member.limit)}` : ""}`);
    }
  }
}
