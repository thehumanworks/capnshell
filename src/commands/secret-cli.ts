import { errorMessage } from "../errors.js";
import { ensureIdentity, type Identity, type PublicKey } from "../identity.js";
import { listMeshes, readMesh, type MeshState } from "../mesh.js";
import { getPeer, listPeers } from "../peers.js";
import { heldSecrets, keepSecret, MAX_SECRETS, MAX_VALUE_BYTES, openSecret, sealSecret, secretNamePattern, type HeldSecret } from "../secrets.js";
import { secureReady } from "../secure.js";
import { versionOrder } from "../version.js";
import { connectControl } from "./daemon.js";

interface StateOption { state?: string }
interface DeviceOption { device?: string }

/** This device's identity, with libsodium loaded for sealing and opening. */
async function setup(): Promise<Identity> {
  await secureReady();
  return ensureIdentity().identity;
}

/** The mesh `name`, which this device must be a member of. */
function memberOf(name: string, self: PublicKey): MeshState {
  const state = readMesh(name);
  if (!state) throw new Error(`This device has no mesh named ${name}. cns mesh list shows its meshes.`);
  if (!state.list.members.some((member) => member.key === self)) throw new Error(`This device is no longer listed in the mesh ${name}. Ask its admin to add it again: cns mesh add ${name} DEVICE.`);
  return state;
}

function checkName(name: string): void {
  if (!secretNamePattern.test(name)) throw new Error("Secret names are environment variable names: letters, digits and underscores, up to 128, not starting with a digit.");
}

/** The member `name` names: this device's name for a device, or the admin's name for a member, as cns mesh list shows. */
function memberKey(state: MeshState, name: string): PublicKey {
  const key = getPeer(name)?.publicKey ?? state.list.members.find((member) => member.name === name)?.key;
  if (key === undefined || !state.list.members.some((member) => member.key === key)) throw new Error(`${name} is not a member of the mesh ${state.name}. cns mesh list ${state.name} shows its members.`);
  return key;
}

/** What this device calls a member. */
function nameOf(state: MeshState, key: PublicKey, self: PublicKey): string {
  if (key === self) return "this device";
  return listPeers(() => {}).find((peer) => peer.publicKey === key)?.name ?? state.list.members.find((member) => member.key === key)?.name ?? "a former member";
}

/** The secrets named `name` in a mesh, not removed, set for `device` alone, or for the whole mesh when `device` is undefined. */
function matching(held: readonly HeldSecret[], state: MeshState, name: string, device: PublicKey | undefined): HeldSecret[] {
  return held.filter(({ record }) => record.mesh === state.name && record.admin === state.admin && record.name === name && record.device === device && record.value !== undefined);
}

/** The value for `set`: typed at a hidden prompt at a terminal, else all of stdin less one final line break. Never an argument, so it stays out of ps and shell history. */
async function readValue(name: string): Promise<Uint8Array> {
  let value: Uint8Array;
  if (process.stdin.isTTY) value = await promptHidden(`Value for ${name} (hidden): `);
  else {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
      size += (chunk as Buffer).length;
      if (size > MAX_VALUE_BYTES + 2) throw new Error(`A secret's value holds at most ${MAX_VALUE_BYTES} bytes.`);
    }
    let text = Buffer.concat(chunks);
    if (text.at(-1) === 0x0a) text = text.subarray(0, text.at(-2) === 0x0d ? -2 : -1);
    value = text;
  }
  if (value.length === 0) throw new Error("The value is empty; nothing was saved. Type it at the prompt, or pipe it in, such as: cns secret set MESH NAME < file.");
  if (value.length > MAX_VALUE_BYTES) throw new Error(`A secret's value holds at most ${MAX_VALUE_BYTES} bytes.`);
  return value;
}

/** Read a line at the terminal without showing it. Ctrl-C cancels. */
function promptHidden(question: string): Promise<Uint8Array> {
  const input = process.stdin;
  return new Promise((resolve, reject) => {
    const typed: number[] = [];
    const finish = (error?: Error) => {
      input.off("data", onData);
      try { input.setRawMode(false); } catch { /* The terminal has closed. */ }
      input.pause();
      process.stderr.write("\n");
      if (error) reject(error); else resolve(Uint8Array.from(typed));
    };
    const onData = (data: Buffer) => {
      for (const byte of data) {
        if (byte === 0x03 || (byte === 0x04 && typed.length === 0)) return finish(new Error("Cancelled; nothing was saved."));
        if (byte === 0x0d || byte === 0x0a) return finish();
        if (byte === 0x7f || byte === 0x08) {
          // Remove the last character, with every byte of it.
          while (typed.length && ((typed.pop()! & 0xc0) === 0x80));
          continue;
        }
        typed.push(byte);
      }
    };
    process.stderr.write(question);
    input.setRawMode(true);
    input.on("data", onData);
    input.resume();
  });
}

/**
 * Have the running daemon offer linked members what changed, through the same call that
 * passes on mesh lists. Returns what to tell the person, if anything.
 */
async function share(options: StateOption): Promise<string | undefined> {
  let control: Awaited<ReturnType<typeof connectControl>>;
  try { control = await connectControl(options.state); }
  catch { return "This device's daemon is not running, so no member gets it yet. Start it: cns up."; }
  try {
    const { version } = await control.remote.status();
    await control.remote.meshChanged();
    if (versionOrder(version) === "older") return `The running daemon is cns ${version}, which does not pass secrets on. Restart it: cns stop, then cns up.`;
    return undefined;
  } catch (error) {
    return `The running daemon did not take the change (${errorMessage(error)}). Restart it: cns stop, then cns up.`;
  } finally { control.close(); }
}

/** `cns secret set MESH NAME [--device DEVICE]`: set a secret for every member of a mesh, or for one. */
export async function setSecret(mesh: string, name: string, options: StateOption & DeviceOption): Promise<void> {
  checkName(name);
  const identity = await setup();
  const self = identity.publicKey;
  const state = memberOf(mesh, self);
  const device = options.device === undefined ? undefined : memberKey(state, options.device);
  const held = heldSecrets(self, [state]);
  const mine = held.find(({ record }) => record.owner === self && record.name === name && record.device === device);
  const other = matching(held, state, name, device).find(({ record }) => record.owner !== self);
  const scope = device === undefined ? "" : ` --device ${options.device}`;
  if (other) {
    const owner = nameOf(state, other.record.owner, self);
    throw new Error(`${name} in ${mesh}${device === undefined ? "" : ` for ${options.device}`} was set by ${owner}, and only ${owner} changes it. On ${owner}, run: cns secret set ${mesh} ${name}${scope}, or cns secret rm ${mesh} ${name}${scope} there first.`);
  }
  if (!mine && held.length >= MAX_SECRETS) throw new Error(`This device keeps ${MAX_SECRETS} secrets of the mesh ${mesh}, as many as it may. Remove one first: cns secret rm ${mesh} NAME.`);
  const value = await readValue(name);
  const now = Date.now();
  // Versions only go up. Seconds since 1970 keep them going up even if this device lost its copy.
  const version = Math.max((mine?.record.version ?? 0) + 1, Math.floor(now / 1000));
  keepSecret(sealSecret(identity, { mesh, admin: state.admin, name, ...device === undefined ? {} : { device }, version, setAt: new Date(now).toISOString() }, value));
  value.fill(0);
  const readers = device === undefined ? `every member of ${mesh}, now and later` : `${options.device} and this device only`;
  console.log(`${mine ? "Changed" : "Set"} ${name} in the mesh ${mesh}, readable by ${readers}.`);
  const hint = await share(options);
  console.log(hint ?? "Members linked now get it within seconds; others when they next link to any member.");
}

/** `cns secret get MESH NAME [--device DEVICE]`: print a secret's value on stdout. */
export async function getSecret(mesh: string, name: string, options: DeviceOption): Promise<void> {
  checkName(name);
  const identity = await setup();
  const self = identity.publicKey;
  const state = memberOf(mesh, self);
  const held = heldSecrets(self, [state]);
  // Without --device, what this device reads: one set for it alone comes before the mesh's.
  const device = options.device === undefined ? undefined : memberKey(state, options.device);
  const found = device !== undefined ? matching(held, state, name, device) : (() => {
    const own = matching(held, state, name, self);
    return own.length ? own : matching(held, state, name, undefined);
  })();
  if (found.length > 1) {
    const owners = found.map(({ record }) => nameOf(state, record.owner, self)).join(" and ");
    throw new Error(`${name} in ${mesh} was set by both ${owners}. Remove one: on that device, run cns secret rm ${mesh} ${name}${device === undefined ? "" : ` --device ${options.device}`}.`);
  }
  if (!found.length) {
    if (device !== undefined && device !== self) throw new Error(`This device holds no ${name} set for ${options.device} in ${mesh}. A secret set for one member is readable only there and on the device that set it.`);
    throw new Error(`This device holds no secret ${name} in ${mesh}. cns secret list ${mesh} shows the ones here. If it was set just now, check that this device's daemon runs: cns up.`);
  }
  const value = openSecret(identity, found[0]!);
  process.stdout.write(value);
  if (process.stdout.isTTY) process.stdout.write("\n");
  value.fill(0);
}

/** `cns secret rm MESH NAME [--device DEVICE]`: remove a secret this device set, on every member. */
export async function removeSecret(mesh: string, name: string, options: StateOption & DeviceOption): Promise<void> {
  checkName(name);
  const identity = await setup();
  const self = identity.publicKey;
  const state = memberOf(mesh, self);
  const device = options.device === undefined ? undefined : memberKey(state, options.device);
  const held = heldSecrets(self, [state]);
  const found = matching(held, state, name, device);
  const mine = found.find(({ record }) => record.owner === self);
  const scope = device === undefined ? "" : ` --device ${options.device}`;
  if (!mine) {
    if (found.length) {
      const owner = nameOf(state, found[0]!.record.owner, self);
      throw new Error(`${name} in ${mesh} was set by ${owner}, and only ${owner} removes it. On ${owner}, run: cns secret rm ${mesh} ${name}${scope}.`);
    }
    throw new Error(`This device holds no secret ${name}${device === undefined ? "" : ` for ${options.device}`} in ${mesh}. cns secret list ${mesh} shows the ones here.`);
  }
  const now = Date.now();
  const version = Math.max(mine.record.version + 1, Math.floor(now / 1000));
  keepSecret(sealSecret(identity, { mesh, admin: state.admin, name, ...device === undefined ? {} : { device }, version, setAt: new Date(now).toISOString() }));
  console.log(`Removed ${name} from the mesh ${mesh}. Members drop it when they get this change; one that read it before keeps what it read.`);
  const hint = await share(options);
  if (hint) console.log(hint);
}

/** `cns secret list [MESH]`: the secrets this device holds, by name, never values. */
export async function listSecrets(mesh: string | undefined, options: { json?: boolean }): Promise<void> {
  const identity = await setup();
  const self = identity.publicKey;
  const states = mesh === undefined ? listMeshes() : [memberOf(mesh, self)];
  const rows = heldSecrets(self, states).filter(({ record }) => record.value !== undefined).map(({ record, state }) => ({
    mesh: record.mesh,
    name: record.name,
    for: record.device === undefined ? null : nameOf(state, record.device, self),
    setBy: nameOf(state, record.owner, self),
    version: record.version,
    setAt: record.setAt,
  })).sort((a, b) => a.mesh.localeCompare(b.mesh) || a.name.localeCompare(b.name) || (a.for ?? "").localeCompare(b.for ?? ""));
  if (options.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  if (!rows.length) { console.error(`This device holds no secrets${mesh === undefined ? "" : ` in ${mesh}`}. Set one with: cns secret set MESH NAME.`); return; }
  const table = [["MESH", "NAME", "READ BY", "SET BY", "SET (UTC)"], ...rows.map((row) => [row.mesh, row.name, row.for ?? "all members", row.setBy, row.setAt.slice(0, 16).replace("T", " ")])];
  const widths = table[0]!.map((_, column) => Math.max(...table.map((cells) => cells[column]!.length)));
  for (const cells of table) console.log(cells.map((cell, column) => column === cells.length - 1 ? cell : cell.padEnd(widths[column]!)).join("  "));
}
