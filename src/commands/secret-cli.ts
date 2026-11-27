import { spawn } from "node:child_process";
import os from "node:os";
import { errorMessage } from "../errors.js";
import { ensureIdentity, type Identity, type PublicKey } from "../identity.js";
import { listMeshes, readMesh, type MeshState } from "../mesh.js";
import { peerNamePattern } from "../peer-files.js";
import { getPeer, listPeers } from "../peers.js";
import { bash, powershell, powershellArgs } from "../platform.js";
import { heldSecrets, keepSecret, MAX_SECRETS, MAX_VALUE_BYTES, openSecret, sealSecret, secretNamePattern, type HeldSecret } from "../secrets.js";
import type { SecretsHere } from "../granted-shell.js";
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

/** A secret as a command line names it: NAME, or MESH:NAME to say which mesh it is in. */
export interface SecretRef { mesh?: string; name: string }

/** Read NAME or MESH:NAME. Mesh names hold no colon and secret names are variable names, so one colon separates them. */
export function parseSecretRef(text: string): SecretRef {
  const colon = text.indexOf(":");
  if (colon < 0) { checkName(text); return { name: text }; }
  const mesh = text.slice(0, colon);
  if (!peerNamePattern.test(mesh)) throw new Error(`${text} names no mesh before its colon. Write MESH:NAME, such as home:API_KEY.`);
  checkName(text.slice(colon + 1));
  return { mesh, name: text.slice(colon + 1) };
}

/** What set, get and rm take: [MESH:]NAME in one word, or MESH and NAME as two. */
function refOf(first: string, second: string | undefined): SecretRef {
  if (second === undefined) return parseSecretRef(first);
  checkName(second);
  return { mesh: first, name: second };
}

/** The names --secret, --only and --exclude take: each given once or more, with commas between names. */
function refsOf(flag: string, values: readonly string[]): SecretRef[] {
  const refs = values.flatMap((value) => value.split(",")).map((part) => part.trim()).filter(Boolean).map(parseSecretRef);
  if (!refs.length) throw new Error(`${flag} needs a secret's name: NAME, or MESH:NAME.`);
  return refs;
}

/** Every mesh this device is in and is still listed in. */
function memberMeshes(self: PublicKey): MeshState[] {
  return listMeshes().filter((state) => state.list.members.some((member) => member.key === self));
}

/** The meshes a command looks in: the one it names, else every mesh this device is in. */
function meshesFor(ref: SecretRef, self: PublicKey): MeshState[] {
  return ref.mesh === undefined ? memberMeshes(self) : [memberOf(ref.mesh, self)];
}

/**
 * A secret under one name in one mesh, as a member reads it. `copies` holds one secret,
 * or more when two members set the same name: then nobody reads it until one is removed.
 */
interface Found { state: MeshState; name: string; copies: HeldSecret[] }

/** What this device reads in `states`: for each name in a mesh, the secret set for this device alone, else the mesh's. */
function readable(self: PublicKey, states: readonly MeshState[]): Found[] {
  const held = heldSecrets(self, states);
  return states.flatMap((state) => {
    const names = new Set(held.filter(({ record }) => record.mesh === state.name && record.admin === state.admin && record.value !== undefined
      && (record.device === undefined || record.device === self)).map(({ record }) => record.name));
    return [...names].sort().map((name) => {
      const own = matching(held, state, name, self);
      return { state, name, copies: own.length ? own : matching(held, state, name, undefined) };
    });
  });
}

const sameSecret = (found: Found, ref: SecretRef) => found.name === ref.name && (ref.mesh === undefined || found.state.name === ref.mesh);
const list = (names: readonly string[]) => names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join("");

/** The one secret `ref` names among `found`. `choice` writes the way to name it in one mesh, for when several hold the name. */
function single(found: readonly Found[], ref: SecretRef, choice: (mesh: string) => string, none: () => Error): Found {
  const named = found.filter((secret) => sameSecret(secret, ref));
  if (named.length === 1) return named[0]!;
  if (!named.length) throw none();
  const meshes = named.map((secret) => secret.state.name);
  throw new Error(`${ref.name} is in the meshes ${list(meshes)}. Say which: ${meshes.map(choice).join(", or ")}.`);
}

const noSecret = (ref: SecretRef) => () => new Error(`This device holds no secret ${ref.name}${ref.mesh === undefined ? "" : ` in ${ref.mesh}`}. cns secret list${ref.mesh === undefined ? "" : ` ${ref.mesh}`} shows the ones here. If it was set just now, check that this device's daemon runs: cns up.`);

/** The value of a secret found, which exactly one member must have set. */
function open(identity: Identity, found: Found, scope = ""): Uint8Array {
  const { state, name, copies } = found;
  if (copies.length > 1) {
    const owners = copies.map(({ record }) => nameOf(state, record.owner, identity.publicKey)).join(" and ");
    throw new Error(`${name} in ${state.name} was set by both ${owners}. Remove one: on that device, run cns secret rm ${state.name} ${name}${scope}.`);
  }
  return openSecret(identity, copies[0]!);
}

/** A secret's value as an environment variable holds it: text, without the NUL byte no variable can hold. */
function asVariable(identity: Identity, found: Found): string {
  const value = open(identity, found);
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
    if (text.includes("\0")) throw new Error("NUL");
    return text;
  } catch {
    throw new Error(`${found.name} in ${found.state.name} is not text, so an environment variable cannot hold it. cns secret get ${found.state.name}:${found.name} prints it as it is.`);
  } finally { value.fill(0); }
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
    if (versionOrder(version) === "older") return `The running daemon is cns ${version}, which does not pass secrets on. Restart it: cns daemon restart.`;
    return undefined;
  } catch (error) {
    return `The running daemon did not take the change (${errorMessage(error)}). Restart it: cns daemon restart.`;
  } finally { control.close(); }
}

/** The mesh a new secret goes to: the one named, else the only mesh this device is in. A guess here would hand the value to the wrong members. */
function meshToSet(ref: SecretRef, self: PublicKey): MeshState {
  const states = meshesFor(ref, self);
  if (states.length === 1) return states[0]!;
  if (!states.length) throw new Error("This device is in no mesh, so there is nowhere to set a secret. cns mesh create NAME starts one.");
  const meshes = states.map((state) => state.name);
  throw new Error(`This device is in the meshes ${list(meshes)}. Say which gets ${ref.name}: ${meshes.map((mesh) => `cns secret set ${mesh}:${ref.name}`).join(", or ")}.`);
}

/** `cns secret set [MESH:]NAME [--device DEVICE]`: set a secret for every member of a mesh, or for one. */
export async function setSecret(first: string, second: string | undefined, options: StateOption & DeviceOption): Promise<void> {
  const ref = refOf(first, second);
  const { name } = ref;
  const identity = await setup();
  const self = identity.publicKey;
  const state = meshToSet(ref, self);
  const mesh = state.name;
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

/**
 * The secrets named `ref.name` set for the member `deviceName` alone, or without one, for
 * the whole mesh: one entry for each mesh that holds one. Without a mesh in `ref`, a mesh
 * `deviceName` is not in is passed over.
 */
function setFor(self: PublicKey, ref: SecretRef, deviceName: string | undefined): Found[] {
  const states = meshesFor(ref, self);
  const held = heldSecrets(self, states);
  return states.flatMap((state) => {
    let device: PublicKey | undefined;
    try { device = deviceName === undefined ? undefined : memberKey(state, deviceName); }
    catch (error) { if (ref.mesh !== undefined) throw error; return []; }
    const copies = matching(held, state, ref.name, device);
    return copies.length ? [{ state, name: ref.name, copies }] : [];
  });
}

/** `cns secret get [MESH:]NAME [--device DEVICE]`: print a secret's value on stdout. */
export async function getSecret(first: string, second: string | undefined, options: DeviceOption): Promise<void> {
  const ref = refOf(first, second);
  const identity = await setup();
  const self = identity.publicKey;
  const scope = options.device === undefined ? "" : ` --device ${options.device}`;
  // Without --device, what this device reads: one set for it alone comes before the mesh's.
  const found = options.device === undefined
    ? single(readable(self, meshesFor(ref, self)), ref, (mesh) => `cns secret get ${mesh}:${ref.name}`, noSecret(ref))
    : single(setFor(self, ref, options.device), ref, (mesh) => `cns secret get ${mesh}:${ref.name}${scope}`,
      () => new Error(`This device holds no ${ref.name} set for ${options.device}${ref.mesh === undefined ? "" : ` in ${ref.mesh}`}. A secret set for one member is readable only there and on the device that set it.`));
  const value = open(identity, found, scope);
  process.stdout.write(value);
  if (process.stdout.isTTY) process.stdout.write("\n");
  value.fill(0);
}

/**
 * The variables --secret adds to a command on another device: each secret named, read and
 * opened here, under its own name. The values then cross the encrypted link in the command's
 * options, never in its text.
 */
export async function secretEnv(values: readonly string[]): Promise<Record<string, string>> {
  return variables(await setup(), refsOf("--secret", values), "--secret", noSecret);
}

/** The variables the secrets `refs` name become here. `flag` is what named them, for messages. */
function variables(identity: Identity, refs: readonly SecretRef[], flag: string, none: (ref: SecretRef) => () => Error): Record<string, string> {
  const self = identity.publicKey;
  const all = readable(self, memberMeshes(self));
  const env: Record<string, string> = {};
  const from = new Map<string, string>();
  for (const ref of refs) {
    if (ref.mesh !== undefined) memberOf(ref.mesh, self);
    const found = single(all, ref, (mesh) => `${flag} ${mesh}:${ref.name}`, none(ref));
    const earlier = from.get(found.name);
    if (earlier !== undefined && earlier !== found.state.name) throw new Error(`${flag} names ${found.name} in both ${earlier} and ${found.state.name}, and the variable ${found.name} holds one value. Name one of them.`);
    from.set(found.name, found.state.name);
    env[found.name] = asVariable(identity, found);
  }
  return env;
}

/**
 * This device's mesh secrets for the programs a paired device starts here, such as an agent's
 * through cns mcp or the gateway: their names, and the variables the ones a call names become.
 * Starting a program here could read them anyway, so this gives the device nothing new, and
 * the values never leave this device.
 */
export function secretsHere(identity: Identity): SecretsHere {
  const self = identity.publicKey;
  const summaries = () => readable(self, memberMeshes(self)).map(({ state, name, copies }) => ({
    mesh: state.name, name, readBy: copies[0]!.record.device === undefined ? "all members" : "this device",
    setBy: [...new Set(copies.map(({ record }) => nameOf(state, record.owner, self)))],
  }));
  const none = (ref: SecretRef) => () => {
    const held = summaries().map((secret) => `${secret.mesh}:${secret.name}`);
    return new Error(`This device holds no mesh secret ${ref.name}${ref.mesh === undefined ? "" : ` in ${ref.mesh}`}. ${held.length ? `It holds ${list(held)}.` : "It holds none."}`);
  };
  return { list: summaries, variables: (names) => variables(identity, refsOf("secrets", names), "secrets", none) };
}

/**
 * Variables that tell a shell, a loader, an interpreter or a common tool what to run, or
 * where to send what it sends. Every member of a mesh can set a secret of any name, so
 * setting all of them (`cns secret run` without --only) would let a member that may run
 * nothing on this device choose what a command here runs. One of these that another device
 * set is therefore set only when --only names it. The list cannot name every program's
 * variables: it closes the well-known ways in, and --only is the answer for a mesh with
 * members that are not trusted that far.
 */
const steering = new RegExp(`^(${[
  "PATH", "PATHEXT", "COMSPEC", "PSMODULEPATH", "HOME", "SHELL", "IFS", "ENV", "BASH_ENV", "BASHOPTS", "SHELLOPTS", "PS4", "PROMPT_COMMAND", "CDPATH", "GLOBIGNORE", "ZDOTDIR", "TMPDIR",
  "LD_.+", "DYLD_.+", "NODE_OPTIONS", "NODE_PATH", "NPM_CONFIG_.+", "PYTHON.+", "PERL5.+", "PERLLIB", "RUBYOPT", "RUBYLIB", "GEM_HOME", "GEM_PATH", "BUNDLE_GEMFILE",
  "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "CLASSPATH", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_ASKPASS", "GIT_EXEC_PATH", "GIT_EDITOR", "GIT_PAGER", "GIT_EXTERNAL_DIFF",
  "GIT_PROXY_COMMAND", "GIT_CONFIG.*", "GIT_TEMPLATE_DIR", "GIT_DIR", "GIT_WORK_TREE", "SSH_ASKPASS", "SUDO_ASKPASS", "EDITOR", "VISUAL", "PAGER", "MANPAGER", "LESSOPEN", "LESSCLOSE", "BROWSER",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "FTP_PROXY", "NO_PROXY",
].join("|")})$`, "i");

/**
 * `cns secret run [--only NAMES | --exclude NAMES] -- COMMAND`: run a command on this device
 * with the secrets it reads as environment variables, each under its own name. The command
 * runs as `cns run` runs one on another device: in a fresh Bash (PowerShell on Windows),
 * with this terminal or these pipes as its input and output. Resolves with its exit status.
 */
export async function runWithSecrets(command: string, options: { only?: string[]; exclude?: string[] }): Promise<number> {
  if (options.only && options.exclude) throw new Error("Use --only or --exclude, not both.");
  const identity = await setup();
  const self = identity.publicKey;
  const all = readable(self, memberMeshes(self));
  if (!all.length) throw new Error("This device holds no secrets to run the command with. cns secret list shows the ones here; set one with: cns secret set NAME.");
  const named = (flag: string, values: readonly string[]) => {
    const refs = refsOf(flag, values);
    for (const ref of refs) {
      if (ref.mesh !== undefined) memberOf(ref.mesh, self);
      if (!all.some((secret) => sameSecret(secret, ref))) throw new Error(`${flag} names ${ref.name}${ref.mesh === undefined ? "" : ` in ${ref.mesh}`}, which this device does not hold. cns secret list shows the ones here.`);
    }
    return refs;
  };
  const only = options.only && named("--only", options.only);
  const exclude = options.exclude && named("--exclude", options.exclude);
  const chosen = all.filter((secret) => only ? only.some((ref) => sameSecret(secret, ref)) : !exclude?.some((ref) => sameSecret(secret, ref)));
  // One variable holds one value: a name two meshes hold must be settled by the person, never by an order.
  for (const secret of chosen) {
    const meshes = chosen.filter((other) => other.name === secret.name).map((other) => other.state.name);
    if (meshes.length < 2) continue;
    throw new Error(only
      ? `${secret.name} is in the meshes ${list(meshes)}, and the variable ${secret.name} holds one value. Say which: ${meshes.map((mesh) => `--only ${mesh}:${secret.name}`).join(", or ")}.`
      : `${secret.name} is in the meshes ${list(meshes)}, and the variable ${secret.name} holds one value. Leave all but one out: ${meshes.map((mesh) => `--exclude ${mesh}:${secret.name}`).join(", or ")}.`);
  }
  if (!only) {
    for (const secret of chosen) {
      const owner = secret.copies.find(({ record }) => record.owner !== self)?.record.owner;
      if (owner === undefined || !steering.test(secret.name)) continue;
      const where = `${secret.state.name}:${secret.name}`;
      throw new Error(`${nameOf(secret.state, owner, self)} set ${where}, and the variable ${secret.name} tells programs what to run or where to connect, so it is set only when you name it. Leave it out: --exclude ${where}. To set it, name what the command gets: --only ${where}.`);
    }
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const secret of chosen) env[secret.name] = asVariable(identity, secret);
  return await runLocal(command, env);
}

/** Run `command` in this device's shell with `env`, on this process's own input and output, and resolve with its exit status. */
function runLocal(command: string, env: NodeJS.ProcessEnv): Promise<number> {
  const windows = process.platform === "win32";
  const terminal = !!process.stdin.isTTY;
  const child = spawn(windows ? powershell() : bash, windows ? powershellArgs(command, terminal) : ["--noprofile", "--norc", "-c", command], { env, stdio: "inherit" });
  const handlers = (["SIGINT", "SIGQUIT", "SIGTERM", "SIGHUP"] as const).map((signal) => {
    // At a terminal, Ctrl-C and Ctrl-\ reach the command as well as cns: passing them on would interrupt it twice.
    const handler = () => { if (!(terminal && (signal === "SIGINT" || signal === "SIGQUIT"))) child.kill(signal); };
    // A platform that lacks one of these signals never sends it.
    try { process.on(signal, handler); } catch {}
    return [signal, handler] as const;
  });
  const done = () => { for (const [signal, handler] of handlers) process.off(signal, handler); };
  return new Promise((resolve, reject) => {
    child.once("error", (error) => { done(); reject(new Error(`Could not start the command: ${errorMessage(error)}`)); });
    child.once("exit", (code, signal) => { done(); resolve(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)); });
  });
}

/** `cns secret rm [MESH:]NAME [--device DEVICE]`: remove a secret this device set, on every member. */
export async function removeSecret(first: string, second: string | undefined, options: StateOption & DeviceOption): Promise<void> {
  const ref = refOf(first, second);
  const { name } = ref;
  const identity = await setup();
  const self = identity.publicKey;
  const scope = options.device === undefined ? "" : ` --device ${options.device}`;
  const { state, copies } = single(setFor(self, ref, options.device), ref, (mesh) => `cns secret rm ${mesh}:${name}${scope}`,
    () => new Error(`This device holds no secret ${name}${options.device === undefined ? "" : ` for ${options.device}`}${ref.mesh === undefined ? "" : ` in ${ref.mesh}`}. cns secret list${ref.mesh === undefined ? "" : ` ${ref.mesh}`} shows the ones here.`));
  const mesh = state.name;
  const device = copies[0]!.record.device;
  const mine = copies.find(({ record }) => record.owner === self);
  if (!mine) {
    const owner = nameOf(state, copies[0]!.record.owner, self);
    throw new Error(`${name} in ${mesh} was set by ${owner}, and only ${owner} removes it. On ${owner}, run: cns secret rm ${mesh} ${name}${scope}.`);
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
