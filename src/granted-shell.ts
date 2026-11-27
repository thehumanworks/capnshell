import { RpcTarget } from "capnweb";
import { z } from "zod";
import { describeGrants, type Permission } from "./peers.js";
import { envSchema, MAX_ENV_VARIABLES } from "./platform.js";
import {
  ShellApi, type AttachOptions, type CaptureOptions, type KeysOptions, type NamedPty, type PtyAttachment, type PtySessionOptions, type PtySink,
  type RunOptions, type ShellInfo, type WaitOptions,
} from "./shell.js";

/** A mesh secret this device reads, as a paired device sees it: by name, never its value. */
export interface SecretSummary {
  mesh: string;
  name: string;
  /** "this device" for a secret set for this member alone, else "all members". */
  readBy: string;
  /** Who set it, by this device's name for them; two when two members set the name, and then it cannot be used. */
  setBy: string[];
}
/** This device's mesh secrets, for programs a paired device starts here (secret-cli.ts). */
export interface SecretsHere {
  list(): SecretSummary[];
  /** The variables the secrets `names` name, each NAME or MESH:NAME, as this device reads them. */
  variables(names: string[]): Record<string, string>;
}
const noSecrets: SecretsHere = { list: () => [], variables: () => { throw new Error("This device keeps no mesh secrets."); } };
/** What a call's `secrets` option holds: the names of mesh secrets to set as the program's variables. */
const secretNamesSchema = z.array(z.string().min(1).max(256)).min(1).max(MAX_ENV_VARIABLES);
/** Options that may name secrets, which this device turns into variables before the program starts. */
export type WithSecrets<T> = T & { secrets?: string[] };

/**
 * A peer's view of this device's shell, limited to what this device granted it.
 * Permitted methods delegate to the real ShellApi; every other method, including
 * ones added to ShellApi later, is refused without side effects. Named sessions come
 * back as handles that check each use against the grants: viewing, typing and killing
 * are separate permissions, and the device that started a session may do all three.
 */
/**
 * The grants a peer holds, which the daemon may widen while the peer is connected.
 * It is held privately: nothing a peer can call reaches it.
 */
export interface GrantHolder { current: readonly Permission[] }

export class GrantedShell extends RpcTarget {
  #shell: ShellApi;
  #grants: GrantHolder;
  #peer: string;
  #owner: string | null;
  #addresses: () => string[];
  #meshes: (offered: unknown) => unknown[];
  #secrets: (offered: unknown) => unknown[];
  #secretsHere: SecretsHere;
  /**
   * `owner` is the peer's fingerprint, the owner of the sessions it starts here.
   * `addresses` says where this device can be reached now, which any paired device may ask.
   * `meshes` takes the mesh member lists the peer offers and answers with the ones it is in (mesh.ts).
   * `secrets` takes the mesh secrets the peer offers and answers with the ones it may read (secrets.ts).
   * `secretsHere` opens the ones this device reads for the programs the peer starts here.
   */
  constructor(shell: ShellApi, grants: readonly Permission[] | GrantHolder, peer: string, owner: string | null = null, addresses: () => string[] = () => [], meshes: (offered: unknown) => unknown[] = () => [], secrets: (offered: unknown) => unknown[] = () => [], secretsHere: SecretsHere = noSecrets) {
    super();
    this.#shell = shell;
    this.#grants = Array.isArray(grants) ? { current: [...grants] } : grants as GrantHolder;
    this.#peer = peer;
    this.#owner = owner;
    this.#addresses = addresses;
    this.#meshes = meshes;
    this.#secrets = secrets;
    this.#secretsHere = secretsHere;
  }
  /** Where this device can be reached now, so a paired device can keep its saved record current. It needs no grant. */
  addresses(): string[] { return [...this.#addresses()]; }
  /**
   * Swap mesh member lists: this device keeps any offered list that is newer than its own and
   * signed by that mesh's admin, and answers with the lists of the meshes the peer is in. It
   * needs no grant: a list changes nothing unless its admin signed it.
   */
  meshes(offered: unknown): unknown[] { return this.#meshes(offered); }
  /**
   * Swap mesh secrets: this device keeps any offered secret that is newer than its own, signed
   * by its owner and sealed so that this device can open it, and answers with the secrets the
   * peer may read, sealed to it. It needs no grant: a member is offered only what it may read.
   */
  secrets(offered: unknown): unknown[] { return this.#secrets(offered); }
  /** What the peer may do here right now, so it can show current access rather than what it was granted at pairing. It needs no grant. */
  granted(): Permission[] { return [...this.#grants.current]; }
  /** What the peer may do here, as people read it. */
  get grants(): string { return describeGrants([...this.#grants.current]); }
  #require(...permissions: Permission[]) { require(this.#grants, this.#peer, permissions); }
  info(): ShellInfo { return this.#shell.info(); }
  /**
   * `secrets` names mesh secrets this device reads, which the program gets as variables. A peer
   * that may start a program here could read them here anyway, and their values stay here.
   */
  run(command: string, options?: WithSecrets<RunOptions>) { this.#require("shell"); return this.#shell.run(command, this.#withSecrets(options)); }
  exec(...args: Parameters<ShellApi["exec"]>) { this.#require("shell"); return this.#shell.exec(...args); }
  openPty(...args: Parameters<ShellApi["openPty"]>) { this.#require("shell"); return this.#shell.openPty(...args); }
  /** A fork carries the same grants. */
  fork(): GrantedShell { this.#require("shell"); return new GrantedShell(this.#shell.fork(), this.#grants, this.#peer, this.#owner, this.#addresses, this.#meshes, this.#secrets, this.#secretsHere); }
  /** The mesh secrets this device reads, by name and never by value, which run's and startPtySession's `secrets` take. */
  secretNames(): SecretSummary[] { this.#require("shell"); return this.#secretsHere.list(); }
  /** `options` with the secrets it names opened here and added to its variables. */
  #withSecrets<T extends object>(options: WithSecrets<T> | undefined): T | undefined {
    if (!options || typeof options !== "object" || !("secrets" in options)) return options;
    const { secrets, ...rest } = options;
    if (secrets === undefined) return rest as T;
    const env = envSchema.optional().parse((rest as { env?: unknown }).env) ?? {};
    const variables = this.#secretsHere.variables(secretNamesSchema.parse(secrets));
    const twice = Object.keys(variables).find((name) => Object.hasOwn(env, name));
    if (twice) throw new Error(`${twice} is given both as a variable and as a secret; give it once.`);
    return { ...rest, env: { ...env, ...variables } } as T;
  }
  stat(...args: Parameters<ShellApi["stat"]>) { this.#require("files"); return this.#shell.stat(...args); }
  access(...args: Parameters<ShellApi["access"]>) { this.#require("files"); return this.#shell.access(...args); }
  readdir(...args: Parameters<ShellApi["readdir"]>) { this.#require("files"); return this.#shell.readdir(...args); }
  mkdir(...args: Parameters<ShellApi["mkdir"]>) { this.#require("files"); return this.#shell.mkdir(...args); }
  glob(...args: Parameters<ShellApi["glob"]>) { this.#require("files"); return this.#shell.glob(...args); }
  readFile(...args: Parameters<ShellApi["readFile"]>) { this.#require("files"); return this.#shell.readFile(...args); }
  writeFile(...args: Parameters<ShellApi["writeFile"]>) { this.#require("files"); return this.#shell.writeFile(...args); }
  writeFileAt(...args: Parameters<ShellApi["writeFileAt"]>) { this.#require("files"); return this.#shell.writeFileAt(...args); }
  setModified(...args: Parameters<ShellApi["setModified"]>) { this.#require("files"); return this.#shell.setModified(...args); }
  /** Reading skills needs `skills`, or `files`, which can read the same files anyway. */
  #requireSkills() { if (!this.#grants.current.includes("files")) this.#require("skills"); }
  skills() { this.#requireSkills(); return this.#shell.skills(); }
  skillFiles(...args: Parameters<ShellApi["skillFiles"]>) { this.#requireSkills(); return this.#shell.skillFiles(...args); }
  readSkillFile(...args: Parameters<ShellApi["readSkillFile"]>) { this.#requireSkills(); return this.#shell.readSkillFile(...args); }
  ptySessions() { this.#require("sessions:list"); return this.#shell.ptySessions(); }
  /** Starting a session needs `sessions:create`; the peer then owns it and may view, type into and kill it. */
  startPtySession(name: string, options?: WithSecrets<PtySessionOptions>) {
    this.#require("sessions:create");
    return new GrantedNamedPty(this.#shell.startPtySession(name, this.#withSecrets(options)), this.#grants, this.#peer, this.#owner);
  }
  /**
   * A handle on a session, whose every use is checked: info, capture, wait and attach need
   * `sessions:view`, typing `sessions:control`, killing `sessions:kill`, or owning the session.
   */
  ptySession(...args: Parameters<ShellApi["ptySession"]>) {
    // A device with no session permission at all learns nothing, not even whether the name exists.
    const any = (["sessions:view", "sessions:control", "sessions:kill", "sessions:create"] as const).some((permission) => this.#grants.current.includes(permission));
    if (!any) this.#require("sessions:view");
    return new GrantedNamedPty(this.#shell.ptySession(...args), this.#grants, this.#peer, this.#owner);
  }
  /** Closing the view closes the shell behind it: its commands end and its handles are revoked. */
  [Symbol.dispose]() { this.#shell[Symbol.dispose](); }
}

function require(grants: GrantHolder, peer: string, permissions: readonly Permission[]) {
  const missing = permissions.filter((permission) => !grants.current.includes(permission));
  if (missing.length) throw new Error(`Permission denied: ${missing.join(", ")} not granted to ${peer}.`);
}

/** Session permissions a session's owner holds whatever its grants say. */
const OWNER_PERMISSIONS = new Set<Permission>(["sessions:view", "sessions:control", "sessions:kill"]);

/** A named session as a paired device sees it: each use is checked against its grants. */
class GrantedNamedPty extends RpcTarget {
  #inner: NamedPty;
  #grants: GrantHolder;
  #peer: string;
  #owner: string | null;
  constructor(inner: NamedPty, grants: GrantHolder, peer: string, owner: string | null) {
    super();
    this.#inner = inner;
    this.#grants = grants;
    this.#peer = peer;
    this.#owner = owner;
  }
  /** Throw unless the peer holds `permission` for this session, by grant or by owning it. */
  #check(permission: Permission) {
    // Grants first: only a device without the grant pays for looking up the session's owner.
    if (this.#grants.current.includes(permission)) return;
    if (this.#owner !== null && OWNER_PERMISSIONS.has(permission) && this.#inner.info().owner === this.#owner) return;
    require(this.#grants, this.#peer, [permission]);
  }
  info() { this.#check("sessions:view"); return this.#inner.info(); }
  busy() { this.#check("sessions:view"); return this.#inner.busy(); }
  write(data: string | Uint8Array) { this.#check("sessions:control"); return this.#inner.write(data); }
  keys(keys: string[], options?: KeysOptions) { this.#check("sessions:control"); return this.#inner.keys(keys, options); }
  resize(cols: number, rows: number) { this.#check("sessions:control"); return this.#inner.resize(cols, rows); }
  capture(options?: CaptureOptions) { this.#check("sessions:view"); return this.#inner.capture(options); }
  wait(options: WaitOptions) { this.#check("sessions:view"); return this.#inner.wait(options); }
  /** Attaching needs `sessions:view`; without `sessions:control` the viewer cannot type, resize or answer the program's queries. */
  attach(sink: PtySink, options: AttachOptions = {}) {
    this.#check("sessions:view");
    let control = true;
    try { this.#check("sessions:control"); } catch { control = false; }
    const attachment = this.#inner.attach(sink, control ? options : {});
    return new GrantedAttachment(attachment, () => this.#check("sessions:control"), () => this.#check("sessions:view"));
  }
  /** Killing needs `sessions:kill`, unless the peer started the session. */
  kill() { this.#check("sessions:kill"); return this.#inner.kill(); }
  [Symbol.dispose]() { this.#inner[Symbol.dispose](); }
}

/** An attachment as a paired device sees it: typing needs `sessions:control`. */
class GrantedAttachment extends RpcTarget {
  #inner: PtyAttachment;
  #control: () => void;
  #view: () => void;
  constructor(inner: PtyAttachment, control: () => void, view: () => void) {
    super();
    this.#inner = inner;
    this.#control = control;
    this.#view = view;
  }
  write(data: string | Uint8Array) { this.#control(); return this.#inner.write(data); }
  keys(keys: string[], options?: KeysOptions) { this.#control(); return this.#inner.keys(keys, options); }
  resize(cols: number, rows: number) { this.#control(); return this.#inner.resize(cols, rows); }
  capture(options?: CaptureOptions) { this.#view(); return this.#inner.capture(options); }
  wait(options: WaitOptions) { this.#view(); return this.#inner.wait(options); }
  detach() { this.#inner.detach(); }
  [Symbol.dispose]() { this.#inner[Symbol.dispose](); }
}

// Refuse anything ShellApi gains later that this class does not know about.
for (const name of Object.getOwnPropertyNames(ShellApi.prototype)) {
  if (name === "constructor" || Object.prototype.hasOwnProperty.call(GrantedShell.prototype, name)) continue;
  Object.defineProperty(GrantedShell.prototype, name, {
    value: function refuse(): never { throw new Error(`Permission denied: ${name} is not available to peers.`); },
    writable: true, configurable: true, enumerable: false,
  });
}
