import { randomBytes } from "node:crypto";
import { RpcTarget } from "capnweb";
import { z } from "zod";
import { clip, type AuditEntry, type AuditLog } from "./audit.js";
import { errorMessage } from "./errors.js";
import { portSchema, type ForwardSink, type PortForward } from "./forward.js";
import { describeGrants, type Grant, type LanCard, type Permission } from "./peers.js";
import { envSchema, MAX_ENV_VARIABLES } from "./platform.js";
import { programExited, sessionOwner, type SessionAttachment, type SessionHandle, type SessionHost } from "./pty.js";
import {
  ShellApi, type AttachOptions, type CaptureOptions, type KeysOptions, type PtySessionOptions, type PtySink,
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

/** Writes an entry to the audit log; the shell adds who made it. */
type Recorder = (entry: Omit<AuditEntry, "peer" | "fingerprint">) => void;
/** How many files being read or written in parts a shell remembers, so that each is one entry (#part). */
const MAX_PARTS = 64;

/** A value a peer sent, as the audit log keeps it. */
const text = (value: unknown) => typeof value === "string" ? value : "(invalid)";
/** The name of an environment variable, as envSchema allows it. */
const variableName = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/**
 * What the audit log keeps of a program's options: where it ran, the program a session runs, the
 * mesh secrets it got here by name, and the names of the variables the caller gave it, which hold
 * the secrets cns run --secret opened there. Never a variable's value.
 */
function program(options: unknown): Partial<AuditEntry> {
  if (!options || typeof options !== "object") return {};
  const { cwd, command, secrets, env } = options as { cwd?: unknown; command?: unknown; secrets?: unknown; env?: unknown };
  const names = secretNamesSchema.safeParse(secrets);
  const variables = env && typeof env === "object" ? Object.keys(env).filter((name) => variableName.test(name)).slice(0, MAX_ENV_VARIABLES) : [];
  return {
    ...typeof cwd === "string" ? { cwd } : {}, ...typeof command === "string" ? { command } : {},
    ...names.success ? { secrets: names.data } : {}, ...variables.length ? { variables } : {},
  };
}
/** How a command or a program ended, for its entry. */
const ended = (exit: { exitCode: number | null; signal: string | null; timedOut: boolean }): Partial<AuditEntry> => ({
  end: new Date().toISOString(), exitCode: exit.exitCode, ...exit.signal ? { signal: exit.signal } : {}, ...exit.timedOut ? { timedOut: true } : {},
});

interface AuditedOptions<T> {
  /** What the entry adds once the call has settled, such as how a command ended. */
  after?: (result: Awaited<T>) => Partial<AuditEntry> | Promise<Partial<AuditEntry>>;
  /** Record only a failure. */
  quiet?: boolean;
  /** Also record the start, once the call is under way, so that what never ends leaves a trace. */
  starts?: boolean;
}

/** What a failure's entry keeps of a value: little, so that refusals cannot cheaply push older entries out. */
const FAILED_FIELD = 512;
/** As many of `names` as fit in FAILED_FIELD characters, with "..." after them when some did not. */
function fewNames(names: string[]): string[] {
  let length = 0;
  const kept = names.filter((name) => (length += name.length + 2) <= FAILED_FIELD);
  return kept.length < names.length ? [...kept, "..."] : kept;
}

/**
 * Do `call` and record `entry` once it has settled, with what `after` says of its result, or with
 * why it failed. A call that throws at once still throws at once, and recording never fails a call.
 */
function audited<T>(record: Recorder, given: Pick<AuditEntry, "action" | "target"> & Partial<AuditEntry>, call: () => T,
  { after = () => ({}), quiet = false, starts = false }: AuditedOptions<T> = {}): T {
  const start = new Date().toISOString();
  // A start line and the line that ends it share an id, which pairs them.
  const entry = starts ? { ...given, id: randomBytes(6).toString("base64url") } : given;
  const failed = (error: unknown) => {
    const { target, cwd, command, secrets, variables } = entry;
    record({
      start, ...entry, target: clip(target, FAILED_FIELD), ...cwd === undefined ? {} : { cwd: clip(cwd, FAILED_FIELD) },
      ...command === undefined ? {} : { command: clip(command, FAILED_FIELD) }, ...secrets ? { secrets: fewNames(secrets) } : {},
      ...variables ? { variables: fewNames(variables) } : {}, error: clip(errorMessage(error), FAILED_FIELD),
    });
  };
  const settled = (result: Awaited<T>) => {
    if (quiet) return;
    try {
      const more = after(result);
      if (more instanceof Promise) void more.then((more) => record({ start, ...entry, ...more }), () => {});
      else record({ start, ...entry, ...more });
    } catch { /* The call worked; only its entry is lost. */ }
  };
  let result: T;
  try { result = call(); }
  catch (error) { failed(error); throw error; }
  if (starts) record({ start, ...entry, phase: "start" });
  if (!(result instanceof Promise)) { settled(result as Awaited<T>); return result; }
  return result.then((value: Awaited<T>) => { settled(value); return value; }, (error: unknown) => { failed(error); throw error; }) as T;
}

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
export interface GrantHolder { current: readonly Grant[] }

export class GrantedShell extends RpcTarget {
  #shell: ShellApi<SessionHost>;
  #grants: GrantHolder;
  #peer: string;
  #owner: string | null;
  #addresses: () => string[];
  #meshes: (offered: unknown) => unknown[];
  #secrets: (offered: unknown) => unknown[];
  #secretsHere: SecretsHere;
  #audit: AuditLog;
  #lan: () => LanCard[];
  /** Where each file read or written in parts here goes on next, by action and path (#part). */
  #parts = new Map<string, number>();
  /**
   * `owner` is the peer's fingerprint, the owner of the sessions it starts here.
   * `addresses` says where this device can be reached now, which any paired device may ask.
   * `meshes` takes the mesh member lists the peer offers and answers with the ones it is in (mesh.ts).
   * `secrets` takes the mesh secrets the peer offers and answers with the ones it may read (secrets.ts).
   * `secretsHere` opens the ones this device reads for the programs the peer starts here.
   * `audit` takes an entry for each command, terminal, session, file and skill file the peer uses (audit.ts).
   * `lan` says which network cards this device has on which local networks, for cns wake (wake.ts).
   */
  constructor(shell: ShellApi<SessionHost>, grants: readonly Grant[] | GrantHolder, peer: string, owner: string | null = null, addresses: () => string[] = () => [], meshes: (offered: unknown) => unknown[] = () => [], secrets: (offered: unknown) => unknown[] = () => [], secretsHere: SecretsHere = noSecrets, audit: AuditLog = () => {}, lan: () => LanCard[] = () => []) {
    super();
    this.#shell = shell;
    this.#grants = Array.isArray(grants) ? { current: [...grants] } : grants as GrantHolder;
    this.#peer = peer;
    this.#owner = owner;
    this.#addresses = addresses;
    this.#meshes = meshes;
    this.#secrets = secrets;
    this.#secretsHere = secretsHere;
    this.#audit = audit;
    this.#lan = lan;
  }
  /** Write an entry this peer made; recording never fails a call. */
  #record: Recorder = (entry) => {
    try { this.#audit({ ...entry, peer: this.#peer, fingerprint: this.#owner }); } catch { /* Lost; the audit log reports why. */ }
  };
  /**
   * Read or write part of a file, recorded unless it goes on where the last such call on the same
   * file ended, so that a file read or copied in parts is one entry. `next` is how far the call
   * went, or undefined when nothing follows. A failure is always recorded.
   */
  #part<T>(action: "file.read" | "file.write" | "skill.read", target: string, options: unknown, call: () => Promise<T>, next: (result: T) => number | undefined): Promise<T> {
    const offset = (options as { offset?: unknown } | undefined)?.offset;
    const at = typeof offset === "number" ? offset : 0;
    const key = `${action}\0${target}`;
    const goesOn = at > 0 && this.#parts.get(key) === at;
    this.#parts.delete(key);
    return audited(this.#record, { action, target }, call, { quiet: goesOn }).then((result) => {
      const length = next(result);
      if (length !== undefined) this.#parts.set(key, at + length);
      if (this.#parts.size > MAX_PARTS) this.#parts.delete(this.#parts.keys().next().value!);
      return result;
    });
  }
  /** Where this device can be reached now, so a paired device can keep its saved record current. It needs no grant. */
  addresses(): string[] { return [...this.#addresses()]; }
  /**
   * This device's network cards on local networks, each a MAC address and an IPv4 address with its
   * prefix, so that a paired device can have another one on the same network wake this one while
   * it sleeps (cns wake). The daemon answers only over a standing link from a device it grants
   * something (peer.ts), and none otherwise.
   */
  lan(): LanCard[] { return this.#lan(); }
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
  granted(): Grant[] { return [...this.#grants.current]; }
  /** What the peer may do here, as people read it. */
  get grants(): string { return describeGrants([...this.#grants.current]); }
  #require(...permissions: Permission[]) { require(this.#grants, this.#peer, permissions); }
  info(): ShellInfo { return this.#shell.info(); }
  /**
   * `secrets` names mesh secrets this device reads, which the program gets as variables. A peer
   * that may start a program here could read them here anyway, and their values stay here.
   */
  /** A command is recorded when it starts and again when it ends. */
  run(command: string, options?: WithSecrets<RunOptions>) {
    return audited(this.#record, { action: "run", target: text(command), ...program(options) },
      () => { this.#require("shell"); return this.#shell.run(command, this.#withSecrets(options)); }, { after: ended, starts: true });
  }
  exec(...args: Parameters<ShellApi["exec"]>) {
    return audited(this.#record, { action: "run", target: text(args[1]), ...program(args[2]) },
      () => { this.#require("shell"); return this.#shell.exec(...args); }, { after: ended, starts: true });
  }
  /** A terminal is recorded when it starts and again once its program has ended. */
  openPty(...args: Parameters<ShellApi["openPty"]>) {
    const { command, ...options } = program(args[1]);
    return audited(this.#record, { action: "terminal", target: command ?? "(login shell)", ...options },
      () => { this.#require("shell"); return this.#shell.openPty(...args); }, { after: (session) => programExited(session).then(ended), starts: true });
  }
  /** A fork carries the same grants, and records to the same audit log. */
  fork(): GrantedShell { this.#require("shell"); return new GrantedShell(this.#shell.fork(), this.#grants, this.#peer, this.#owner, this.#addresses, this.#meshes, this.#secrets, this.#secretsHere, this.#audit, this.#lan); }
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
  mkdir(...args: Parameters<ShellApi["mkdir"]>) {
    return audited(this.#record, { action: "file.mkdir", target: text(args[0]) }, () => { this.#require("files"); return this.#shell.mkdir(...args); });
  }
  glob(...args: Parameters<ShellApi["glob"]>) { this.#require("files"); return this.#shell.glob(...args); }
  readFile(...args: Parameters<ShellApi["readFile"]>) {
    return this.#part("file.read", text(args[0]), args[1], () => { this.#require("files"); return this.#shell.readFile(...args); }, (chunk) => chunk.eof ? undefined : chunk.data.byteLength);
  }
  writeFile(...args: Parameters<ShellApi["writeFile"]>) {
    return audited(this.#record, { action: "file.write", target: text(args[0]) }, () => { this.#require("files"); return this.#shell.writeFile(...args); });
  }
  writeFileAt(...args: Parameters<ShellApi["writeFileAt"]>) {
    const [file, data, options] = args;
    return this.#part("file.write", text(file), options, () => { this.#require("files"); return this.#shell.writeFileAt(...args); },
      () => data instanceof Uint8Array ? data.byteLength : undefined);
  }
  setModified(...args: Parameters<ShellApi["setModified"]>) { this.#require("files"); return this.#shell.setModified(...args); }
  /** Reading skills needs `skills`, or `files`, which can read the same files anyway. */
  #requireSkills() { if (!this.#grants.current.includes("files")) this.#require("skills"); }
  skills() { this.#requireSkills(); return this.#shell.skills(); }
  skillFiles(...args: Parameters<ShellApi["skillFiles"]>) { this.#requireSkills(); return this.#shell.skillFiles(...args); }
  readSkillFile(...args: Parameters<ShellApi["readSkillFile"]>) {
    const [name, file, options] = args;
    return this.#part("skill.read", `${text(name)}/${text(file)}`, options, () => { this.#requireSkills(); return this.#shell.readSkillFile(...args); },
      (chunk) => chunk.eof ? undefined : chunk.data.byteLength);
  }
  ptySessions() { this.#require("sessions:list"); return this.#shell.ptySessions(); }
  /**
   * Starting a session needs `sessions:create`; the peer then owns it and may view, type into and
   * kill it. Its end is recorded too, as this peer's, whoever ends it.
   */
  startPtySession(name: string, options?: WithSecrets<PtySessionOptions>) {
    return audited(this.#record, { action: "session.start", target: text(name), ...program(options) }, () => {
      this.#require("sessions:create");
      const start = new Date().toISOString();
      const granted = (session: SessionHandle) => {
        try { void programExited(session).then((exit) => this.#record({ start, action: "session.end", target: name, ...ended(exit) }), () => {}); }
        catch { /* Its end goes unrecorded; the session works all the same. */ }
        return new GrantedNamedPty(session, this.#grants, this.#peer, this.#owner, name, this.#record);
      };
      // A daemon's sessions start in holder processes of their own (held-sessions.ts), which takes a moment.
      const session = this.#shell.startPtySession(name, this.#withSecrets(options));
      return session instanceof Promise ? session.then(granted) : granted(session);
    });
  }
  /**
   * A handle on a session, whose every use is checked: info, capture, wait and attach need
   * `sessions:view`, typing `sessions:control`, killing `sessions:kill`, or owning the session.
   */
  ptySession(...args: Parameters<ShellApi["ptySession"]>) {
    // A device with no session permission at all learns nothing, not even whether the name exists.
    const any = (["sessions:view", "sessions:control", "sessions:kill", "sessions:create"] as const).some((permission) => this.#grants.current.includes(permission));
    if (!any) this.#require("sessions:view");
    return new GrantedNamedPty(this.#shell.ptySession(...args), this.#grants, this.#peer, this.#owner, text(args[0]), this.#record);
  }
  /**
   * cns forward to `port` on localhost here needs `shell`, which reaches every port anyway, or the
   * port word for it, such as `port:5432`; each connection is checked again. A forward is recorded
   * when it starts and when it ends, with its connections and bytes each way, never per connection.
   */
  forward(port: number) {
    let inner: PortForward;
    return audited(this.#record, { action: "port.forward", target: `localhost:${Number.isInteger(port) ? port : "(invalid)"}` }, () => {
      const valid = portSchema.parse(port);
      const check = () => { if (!this.#grants.current.includes("shell")) require(this.#grants, this.#peer, [`port:${valid}`]); };
      check();
      inner = this.#shell.forward(valid);
      return new GrantedForward(inner, check);
    }, { starts: true, after: () => inner.ended.then((stats) => ({ end: new Date().toISOString(), ...stats })) });
  }
  /** Closing the view closes the shell behind it: its commands end and its handles are revoked. */
  [Symbol.dispose]() { this.#shell[Symbol.dispose](); }
}

/** A forward as a paired device holds it: each connection checks the grant again. */
class GrantedForward extends RpcTarget {
  #inner: PortForward;
  #check: () => void;
  constructor(inner: PortForward, check: () => void) {
    super();
    this.#inner = inner;
    this.#check = check;
  }
  connect(sink: ForwardSink) { this.#check(); return this.#inner.connect(sink); }
  [Symbol.dispose]() { this.#inner[Symbol.dispose](); }
}

function require(grants: GrantHolder, peer: string, permissions: readonly Grant[]) {
  const missing = permissions.filter((permission) => !grants.current.includes(permission));
  if (missing.length) throw new Error(`Permission denied: ${missing.join(", ")} not granted to ${peer}.`);
}

/** Session permissions a session's owner holds whatever its grants say. */
const OWNER_PERMISSIONS = new Set<Permission>(["sessions:view", "sessions:control", "sessions:kill"]);

/** A named session as a paired device sees it: each use is checked against its grants. */
class GrantedNamedPty extends RpcTarget {
  #inner: SessionHandle;
  #grants: GrantHolder;
  #peer: string;
  #owner: string | null;
  #name: string;
  #record: Recorder;
  constructor(inner: SessionHandle, grants: GrantHolder, peer: string, owner: string | null, name: string, record: Recorder) {
    super();
    this.#inner = inner;
    this.#grants = grants;
    this.#peer = peer;
    this.#owner = owner;
    this.#name = name;
    this.#record = record;
  }
  /** Throw unless the peer holds `permission` for this session, by grant or by owning it. */
  #check(permission: Permission) {
    // Grants first: only a device without the grant pays for looking up the session's owner.
    if (this.#grants.current.includes(permission)) return;
    if (this.#owner !== null && OWNER_PERMISSIONS.has(permission) && sessionOwner(this.#inner) === this.#owner) return;
    require(this.#grants, this.#peer, [permission]);
  }
  info() { this.#check("sessions:view"); return this.#inner.info(); }
  busy() { this.#check("sessions:view"); return this.#inner.busy(); }
  write(data: string | Uint8Array) { this.#check("sessions:control"); return this.#inner.write(data); }
  keys(keys: string[], options?: KeysOptions) { this.#check("sessions:control"); return this.#inner.keys(keys, options); }
  resize(cols: number, rows: number) { this.#check("sessions:control"); return this.#inner.resize(cols, rows); }
  capture(options?: CaptureOptions) { this.#check("sessions:view"); return this.#inner.capture(options); }
  wait(options: WaitOptions) { this.#check("sessions:view"); return this.#inner.wait(options); }
  /**
   * Attaching needs `sessions:view`; without `sessions:control` the viewer cannot type, resize or
   * answer the program's queries. Each attach is recorded; what is typed through it never is.
   */
  attach(sink: PtySink, options: AttachOptions = {}) {
    return audited(this.#record, { action: "session.attach", target: this.#name }, () => {
      this.#check("sessions:view");
      let control = true;
      try { this.#check("sessions:control"); } catch { control = false; }
      const attachment = this.#inner.attach(sink, control ? options : {});
      const granted = (inner: SessionAttachment) => new GrantedAttachment(inner, () => this.#check("sessions:control"), () => this.#check("sessions:view"));
      return attachment instanceof Promise ? attachment.then(granted) : granted(attachment);
    });
  }
  /** Killing needs `sessions:kill`, unless the peer started the session. */
  kill() { return audited(this.#record, { action: "session.kill", target: this.#name }, () => { this.#check("sessions:kill"); return this.#inner.kill(); }); }
  [Symbol.dispose]() { this.#inner[Symbol.dispose](); }
}

/** An attachment as a paired device sees it: typing needs `sessions:control`. */
class GrantedAttachment extends RpcTarget {
  #inner: SessionAttachment;
  #control: () => void;
  #view: () => void;
  constructor(inner: SessionAttachment, control: () => void, view: () => void) {
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
