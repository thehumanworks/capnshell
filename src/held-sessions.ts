/**
 * The daemon's named sessions, each in a holder process of its own (holder.ts), so that they
 * outlive the daemon. The daemon keeps a Cap'n Web stub per holder instead of a session, and
 * hands its callers handles that forward to the holder and that their shell revokes, as it
 * revokes NamedPty handles. A new daemon adopts the holders that still run before it accepts
 * links, so a reconnecting `cns shell` finds its session with the same pid and start time, and
 * removes the records of holders that are gone, as after a reboot.
 *
 * Paired devices never reach a holder: their calls go through the daemon's grant checks
 * (granted-shell.ts) as before. A holder answers only a caller with its record's token, and
 * its socket and record are in a private directory beside the daemon's state.
 */
import { spawn, spawnSync } from "node:child_process";
import { lstat, readdir, readFile, unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { RpcSession, RpcTarget, type RpcStub } from "capnweb";
import { z } from "zod";
import { checkPrivateDirectory, isPrivateFile, makePrivateDirectory } from "./config.js";
import { errorMessage, printable, strictlyPrintable } from "./errors.js";
import { HOLDER_PROTOCOL, holderRecordSchema, holderSocket, LineTransport, type HolderApi, type HolderRecord, type HolderStart } from "./holder.js";
import {
  FINISHED_SESSION_MS, MAX_NAMED_PTYS, programOptionsSchema, revocable, sessionNameSchema,
  type AttachOptions, type CaptureOptions, type HandleScope, type KeysOptions, type NamedPty, type PtyAttachment, type PtyExit,
  type PtySessionInfo, type PtySessionOptions, type PtySink, type SessionHandle, type SessionHost, type WaitOptions,
} from "./pty.js";
import { selfInvocation } from "./runtime.js";
import { CNS_VERSION } from "./version.js";

/**
 * Whether this platform runs sessions in holders. Windows keeps them in the daemon, as before:
 * a holder there needs a named pipe that only this user may open, which Bun's sockets cannot
 * restrict, and it has not been tried there.
 */
export const HOLDERS = process.platform !== "win32";

/** Where a daemon's holders keep their records and sockets: a private directory beside its state file. */
export function holderDirectory(state: string): string {
  return path.join(path.dirname(state), `${path.basename(state, ".json")}-sessions`);
}

/** The longest path a Unix socket takes, in bytes: sun_path holds 104 on macOS and 108 on Linux, with the NUL that ends it. */
const SOCKET_PATH_MAX = (process.platform === "darwin" ? 104 : 108) - 1;

/**
 * Why a daemon whose holders would live in `dir` keeps its named sessions itself, as before
 * holders: their sockets' paths would be too long to listen at. Undefined when they fit.
 */
export function socketsTooLong(dir: string): string | undefined {
  const example = holderSocket(dir, "0".repeat(16));
  const bytes = Buffer.byteLength(example);
  if (bytes <= SOCKET_PATH_MAX) return undefined;
  return `Named sessions run in this daemon and end when it stops or restarts: a socket of theirs, such as ${printable(example)}, ` +
    `would be ${bytes} bytes long, over the ${SOCKET_PATH_MAX} this system allows. A shorter --state path lets them outlive the daemon.`;
}

/**
 * Whether the daemon's holders outlive it, as `cns status --json` reports in daemon.keepsSessions.
 * A daemon `cns daemon --service` runs under a systemd unit whose KillMode is not `process`, as the
 * units of older releases of cns and its Nix modules are, has them stopped with it. A daemon
 * started any other way stops alone, whatever unit the shell that started it runs in.
 */
export function keepsSessions(service: boolean, { platform = process.platform, cgroup = ownCgroup, killMode = unitKillMode }: {
  platform?: NodeJS.Platform; cgroup?: () => string | undefined; killMode?: (unit: string, user: boolean) => string | undefined;
} = {}): boolean {
  if (platform === "win32") return false;
  if (!service || platform !== "linux") return true;
  const group = cgroup();
  const unit = group && /\/([^/\n]+\.service)$/m.exec(group)?.[1];
  if (!unit) return true;
  return killMode(unit, group.includes("/user@")) === "process";
}

function ownCgroup(): string | undefined {
  try { return readFileSync("/proc/self/cgroup", "utf8"); } catch { return undefined; }
}

function unitKillMode(unit: string, user: boolean): string | undefined {
  const shown = spawnSync("systemctl", [...user ? ["--user"] : [], "show", unit, "--property=KillMode", "--value"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 });
  return shown.status === 0 ? shown.stdout.trim() : undefined;
}

interface Held {
  record: HolderRecord;
  main: RpcStub<HolderApi>;
  /** The daemon's own handle on the session, to list and kill it. */
  base: RpcStub<NamedPty>;
  exited: Promise<PtyExit>;
  /** The program has ended. */
  done?: boolean;
  /** The connection to the holder broke: it ended, or let go of this daemon. */
  lost?: boolean;
  /** Resolves once the connection is gone, broken or closed. */
  gone: Promise<void>;
  close(): void;
}

/** What any record must hold, whatever its protocol, for the daemon to act on it. */
const looseRecordSchema = z.object({ protocol: z.int(), name: sessionNameSchema, pid: z.int().positive(), socket: z.string() });

/** Whether a connection failed because nothing listens there: the holder is gone. */
const gone = (error: unknown) => error instanceof Error && "code" in error && (error.code === "ECONNREFUSED" || error.code === "ENOENT");

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error instanceof Error && "code" in error && error.code === "ESRCH"); }
}

/** A holder that did not answer in time, as a stopped process does not. */
class NoAnswer extends Error {
  constructor() { super("The session's holder did not answer."); }
}

/** `promise`, or a rejection after `ms`, so that a holder that stopped answering holds up nothing. */
function within<T>(promise: PromiseLike<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new NoAnswer()), ms); });
  return Promise.race([Promise.resolve(promise), late]).finally(() => clearTimeout(timer));
}

/**
 * Whether something listens at a holder's socket, without speaking to it: false when nothing
 * does, so the holder is gone; undefined when that cannot be told in time.
 */
function listening(socket: string, timeoutMs = 3000): Promise<boolean | undefined> {
  return new Promise((resolve) => {
    const connection = net.connect(socket);
    const timer = setTimeout(() => finish(undefined), timeoutMs);
    function finish(answer: boolean | undefined) { clearTimeout(timer); connection.destroy(); resolve(answer); }
    connection.once("connect", () => finish(true)).once("error", (error) => finish(gone(error) ? false : undefined));
  });
}

/** Connect to a holder with its record's token. It answers with its protocol, or closes on a caller without the token. */
export async function connectHolder(record: Pick<HolderRecord, "socket" | "token">, timeoutMs = 3000): Promise<{ main: RpcStub<HolderApi>; close(): void }> {
  const socket = net.connect(record.socket);
  socket.setEncoding("utf8");
  try {
    const rest = await new Promise<string>((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => finish(new Error("The session's holder did not answer.")), timeoutMs);
      const onData = (chunk: string) => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        let protocol: unknown;
        try { protocol = (JSON.parse(buffer.slice(0, end)) as { protocol?: unknown }).protocol; } catch { /* Refused below. */ }
        if (protocol !== HOLDER_PROTOCOL) finish(new Error(`The session's holder answered with protocol ${strictlyPrintable(String(protocol)).slice(0, 20)}, not ${HOLDER_PROTOCOL}.`));
        else finish(undefined, buffer.slice(end + 1));
      };
      const onClose = () => finish(new Error("The session's holder refused the connection."));
      function finish(error?: Error, rest = "") {
        clearTimeout(timer);
        socket.off("data", onData).off("error", finish).off("close", onClose);
        if (error) reject(error); else resolve(rest);
      }
      socket.on("data", onData).once("error", finish).once("close", onClose);
      socket.once("connect", () => socket.write(`${JSON.stringify({ token: record.token })}\n`));
    });
    const main = new RpcSession<HolderApi>(new LineTransport(socket, rest)).getRemoteMain() as unknown as RpcStub<HolderApi>;
    return { main, close: () => { main[Symbol.dispose](); socket.destroy(); } };
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/** Start a holder for a session and return its record once it runs the program. */
export function startHolder(start: HolderStart, startMs = 10_000, { file, args } = selfInvocation(["daemon", "hold", start.name])): Promise<HolderRecord> {
  // Its own session and process group, so that nothing that ends the daemon's ends it.
  const child = spawn(file, args, { detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"] });
  return new Promise<HolderRecord>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`The session's holder did not start within ${startMs / 1000} seconds.`)), startMs);
    const onMessage = (message: { ready?: unknown; error?: unknown }) => {
      if (typeof message?.error === "string") finish(new Error(message.error));
      else {
        const record = holderRecordSchema.safeParse(message?.ready);
        finish(record.success ? undefined : new Error("The session's holder sent no record."), record.data);
      }
    };
    const onExit = (code: number | null) => finish(new Error(`The session's holder exited as it started (${code}).`));
    function finish(error?: Error, record?: HolderRecord) {
      clearTimeout(timer);
      child.off("message", onMessage).off("error", finish).off("exit", onExit);
      if (child.connected) child.disconnect();
      child.unref();
      if (error) { if (child.exitCode === null) child.kill("SIGKILL"); reject(error); } else resolve(record!);
    }
    child.on("message", onMessage).once("error", finish).once("exit", onExit);
    child.send(start);
  });
}

export class HeldSessions implements SessionHost {
  #dir: string;
  #say: (message: string) => void;
  #finishedMs: number;
  #max: number;
  #killMs: number;
  #startMs: number;
  #held = new Map<string, Held>();
  /** Sessions whose holder this daemon cannot reach, such as one a newer cns runs, by name: their names stay taken. */
  #unreachable = new Map<string, string>();
  #starting = new Set<string>();
  /** Sessions being killed, by name: each name stays taken until its holder has gone, so that no two holders run sessions of one name. */
  #ending = new Map<string, Held>();
  #closed = false;
  #adopted: (record: HolderRecord, exited: Promise<PtyExit>) => void;

  /**
   * `adopted` hears of each session adopted while its program runs, for the audit log: a session
   * that outlived the daemon that started it ends under this one. A holder that has not answered
   * a kill within `killMs` is killed itself.
   */
  constructor(dir: string, say: (message: string) => void = () => {}, {
    finishedMs = FINISHED_SESSION_MS, adopted = () => {}, max = MAX_NAMED_PTYS, killMs = 5000, startMs = 10_000,
  }: {
    finishedMs?: number; adopted?: (record: HolderRecord, exited: Promise<PtyExit>) => void; max?: number; killMs?: number; startMs?: number;
  } = {}) {
    this.#dir = dir;
    this.#say = say;
    this.#finishedMs = finishedMs;
    this.#adopted = adopted;
    this.#max = max;
    this.#killMs = killMs;
    this.#startMs = startMs;
  }

  /** Every session's name, running or finished. */
  get names(): string[] { return [...this.#held.keys(), ...this.#unreachable.keys()].sort(); }
  /** The sessions whose program still runs, by name and holder pid: none for those this daemon cannot reach. */
  get kept(): Array<{ name: string; pid?: number }> {
    const held = [...this.#held].filter(([, one]) => !one.done).map(([name, one]) => ({ name, pid: one.record.pid }));
    return [...held, ...[...this.#unreachable.keys()].map((name) => ({ name }))].sort((a, b) => a.name < b.name ? -1 : 1);
  }
  /** The names of the sessions whose program still runs, for the daemon to name what keeps running when it stops. */
  get running(): string[] { return this.kept.map(({ name }) => name); }
  /** Every session this daemon reaches, running or finished, by name and holder pid. */
  get holders(): Array<{ name: string; pid: number }> {
    return [...this.#held].map(([name, held]) => ({ name, pid: held.record.pid })).sort((a, b) => a.name < b.name ? -1 : 1);
  }

  /** Adopt the sessions whose holders still run, and remove the records of holders that are gone. */
  async adopt(): Promise<void> {
    makePrivateDirectory(this.#dir);
    checkPrivateDirectory(this.#dir);
    const files = (await readdir(this.#dir)).filter((file) => file.endsWith(".json"));
    await Promise.all(files.map((file) => this.#adoptOne(path.join(this.#dir, file))));
  }

  async #adoptOne(file: string) {
    let found: z.infer<typeof looseRecordSchema>;
    let raw: unknown;
    let socket: string;
    try {
      if (!isPrivateFile(await lstat(file))) throw new Error("it is not a private file of this user");
      raw = JSON.parse(await readFile(file, "utf8"));
      found = looseRecordSchema.parse(raw);
      // Its socket by name in this directory, however the record spells the directory: a record
      // never makes the daemon reach or remove anything else.
      const base = path.basename(found.socket);
      if (!/^[\w-][\w.-]*$/.test(base)) throw new Error("its socket's name is not one a holder gives");
      socket = path.join(this.#dir, base);
    } catch (error) { this.#say(`Ignored ${printable(file)}: ${printable(errorMessage(error))}.`); return; }
    const { name, pid, protocol } = found;
    const remove = () => Promise.all([file, socket].map((leftover) => unlink(leftover).catch(() => {})));
    /** Names the pid to kill only once its socket answered and the pid runs: a pid alone may be another process by now. */
    const unreachable = (why: string, answered: boolean | undefined) => {
      const confirmed = answered && processExists(pid);
      // Peers read it, when they ask for the session.
      const message = `${why} ${confirmed ? `It keeps running; kill ${pid} ends it.` : `Its name stays taken while its record, ${strictlyPrintable(file)}, is there.`}`;
      this.#unreachable.set(name, message);
      this.#say(message);
    };
    if (protocol !== HOLDER_PROTOCOL) {
      // Nothing listens: its holder has gone, as after a reboot.
      const answered = await listening(socket);
      if (answered === false) { await remove(); return; }
      unreachable(`The session ${name} runs in a holder (pid ${pid}) of another cns, protocol ${protocol}, which cns ${CNS_VERSION} cannot reach: run the daemon from that cns to reach it.`, answered);
      return;
    }
    const parsed = holderRecordSchema.safeParse(raw);
    if (!parsed.success) { this.#say(`Ignored ${printable(file)}: ${printable(errorMessage(parsed.error))}.`); return; }
    const record = { ...parsed.data, socket };
    let connection: Awaited<ReturnType<typeof connectHolder>>;
    try { connection = await connectHolder(record); }
    catch (error) {
      if (gone(error)) { await remove(); return; }
      unreachable(`Cannot reach the holder of the session ${name} (pid ${pid}): ${strictlyPrintable(errorMessage(error))}`, await listening(socket));
      return;
    }
    const kept = this.#held.get(name);
    if (kept || this.#closed) {
      connection.close();
      if (kept) this.#say(`Two holders run a session named ${name}, pids ${kept.record.pid} and ${pid}: this daemon reaches the first. kill ${pid} ends the other.`);
      return;
    }
    const held = this.#keep(record, connection);
    // Only one that still runs: a finished one's end was heard by the daemon it ended under, or by none.
    try { if ((await within(held.base.info(), 3000)).running) this.#adopted(record, held.exited); } catch { /* Gone already, or not answering. */ }
  }

  #keep(record: HolderRecord, connection: { main: RpcStub<HolderApi>; close(): void }): Held {
    const { main } = connection;
    const exited = Promise.resolve(main.exited());
    const gone = Promise.withResolvers<void>();
    const held: Held = { record, main, base: main.handle(), exited, gone: gone.promise, close: () => { connection.close(); gone.resolve(); } };
    exited.then(() => { held.done = true; }, () => {});
    this.#held.set(record.name, held);
    // The holder ended, or this daemon lost it: the session is gone from here.
    main.onRpcBroken(() => {
      held.lost = true;
      if (this.#held.get(record.name) === held) this.#held.delete(record.name);
      held.close();
    });
    return held;
  }

  async startSession(name: string, options: PtySessionOptions, owner: string | null, scope?: HandleScope): Promise<SessionHandle> {
    sessionNameSchema.parse(name);
    // Checked here, so that nothing starts for options the holder would refuse.
    const parsed = programOptionsSchema.parse(options);
    if (this.#ending.has(name)) throw new Error(`The PTY session ${name} is still ending. Start it again once it has.`);
    if (this.#held.has(name) || this.#starting.has(name) || this.#unreachable.has(name)) throw new Error(`A PTY session named ${name} already exists. Kill it first.`);
    this.#starting.add(name);
    try {
      // Places that sessions being started or killed take count too, so that starts at once never pass the cap.
      if (this.#held.size + this.#unreachable.size + this.#starting.size + this.#ending.size > this.#max) await this.#evictFinished();
      const record = await startHolder({ dir: this.#dir, name, options: parsed, owner, finishedMs: this.#finishedMs }, this.#startMs);
      // A start that fails leaves no session behind: the caller is told it did not start.
      const abandon = (error: Error) => { try { process.kill(record.pid, "SIGTERM"); } catch { /* Gone. */ } return error; };
      const connection = await connectHolder(record).catch((error: Error) => { throw abandon(error); });
      if (this.#closed) { connection.close(); throw abandon(new Error("The daemon is stopping.")); }
      this.#keep(record, connection);
    } finally { this.#starting.delete(name); }
    return new HeldNamedPty(this, name, this.#held.get(name)!, scope);
  }

  /** Make room by killing the finished session that ended first and has nobody attached, as PtyRegistry does. */
  async #evictFinished() {
    const ended = (info: PtySessionInfo) => Date.parse(info.startedAt) + (info.exit?.elapsedMs ?? 0);
    const finished = (await this.#infos()).filter(([, info]) => !info.running && !info.viewers).sort(([, a], [, b]) => ended(a) - ended(b));
    // Starts at the cap at once each take a session of their own: one that another start is killing is no longer held.
    const oldest = finished.find(([held]) => this.#held.get(held.record.name) === held)?.[0];
    if (!oldest) {
      const unreachable = [...this.#unreachable.keys()];
      const out = unreachable.length ? `, ${unreachable.length} of them in holders this daemon cannot reach (${unreachable.join(", ")}), as its log says` : "";
      throw new Error(`Too many named PTY sessions: all ${this.#max} are running or in use${out}. Kill one first.`);
    }
    await this.kill(oldest.record.name, oldest);
  }

  openSession(name: string, scope?: HandleScope): SessionHandle {
    sessionNameSchema.parse(name);
    const held = this.#held.get(name);
    if (!held) throw new Error(this.#unreachable.get(name) ?? `No PTY session named ${name}.`);
    return new HeldNamedPty(this, name, held, scope);
  }

  /** A handle only reaches the session it was issued for, never a later one with its name. */
  resolve(name: string, held: Held): void {
    if (this.#held.get(name) !== held) throw new Error(`PTY session ${name} no longer exists.`);
  }

  /** Each session's info. One whose holder does not answer within listMs, such as a stopped process, is left out rather than hold up the rest. */
  async list(listMs = 3000): Promise<PtySessionInfo[]> {
    return (await this.#infos(listMs)).map(([, info]) => info);
  }

  async #infos(listMs = 3000): Promise<Array<[Held, PtySessionInfo]>> {
    const held = [...this.#held.values()];
    const infos = await Promise.allSettled(held.map((one) => within(one.base.info(), listMs)));
    return infos.flatMap((info, index) => info.status === "fulfilled" ? [[held[index]!, info.value] as [Held, PtySessionInfo]] : []);
  }

  /**
   * Kill a session. A holder that does not answer in time, such as a stopped one, is killed
   * itself, which ends its program as a closing terminal does. Either way the session's name
   * stays taken until its holder has gone.
   */
  async kill(name: string, held: Held): Promise<PtyExit> {
    this.resolve(name, held);
    this.#held.delete(name);
    this.#ending.set(name, held);
    try {
      return await within(held.base.kill(), this.#killMs);
    } catch (error) {
      // Only a holder this daemon still reaches: once the connection broke, its pid may be another process's.
      if (!(error instanceof NoAnswer) || held.lost) throw error;
      try { process.kill(held.record.pid, "SIGKILL"); } catch { /* Gone. */ }
      await held.gone;
      return {
        exitCode: null, signal: null, signalNumber: null, timedOut: false, elapsedMs: Date.now() - Date.parse(held.record.startedAt),
        error: `The session's holder (pid ${held.record.pid}) did not answer, so the daemon killed it.`,
      };
    } finally {
      if (this.#ending.get(name) === held) this.#ending.delete(name);
      held.close();
    }
  }

  /** End every session this daemon reaches, as cns stop --end-sessions does: those it ended, by name and holder pid, and why any did not end. */
  async endAll(): Promise<{ ended: Array<{ name: string; pid: number }>; failed: string[] }> {
    const all = [...this.#held].sort(([a], [b]) => a < b ? -1 : 1);
    const results = await Promise.allSettled(all.map(([name, held]) => this.kill(name, held)));
    return {
      ended: all.flatMap(([name, held], index) => results[index]!.status === "fulfilled" ? [{ name, pid: held.record.pid }] : []),
      failed: results.flatMap((result, index) => result.status === "rejected" ? [`Could not end ${all[index]![0]}: ${strictlyPrintable(errorMessage(result.reason))}`] : []),
    };
  }

  /** Let go of every holder, leaving its session running for the next daemon. */
  [Symbol.dispose]() {
    this.#closed = true;
    for (const held of [...this.#held.values(), ...this.#ending.values()]) held.close();
    this.#held.clear();
  }
}

/** What a holder's handle and attachment share: input, size and screen, forwarded until the shell that issued them closes. */
class HeldControls<T extends NamedPty | PtyAttachment> extends RpcTarget {
  #inner: RpcStub<T>;
  #scope?: HandleScope;
  #check: () => void;
  #revoked: string | null = null;
  #revocation = Promise.withResolvers<never>();
  constructor(inner: RpcStub<T>, scope: HandleScope | undefined, check: () => void, onRevoke: (reason: string) => void, about?: Parameters<typeof revocable>[2]) {
    super();
    this.#inner = inner;
    this.#scope = scope;
    this.#check = check;
    this.#revocation.promise.catch(() => {});
    revocable(this, (reason) => {
      if (this.#revoked) return;
      this.#revoked = reason;
      scope?.delete(this);
      this.#revocation.reject(new Error(reason));
      onRevoke(reason);
    }, about);
    scope?.add(this);
    calls.set(this, (use) => this.#call(use as never));
  }
  /** Calls end with the reason once revoked, pending ones too. */
  async #call<R>(use: (inner: RpcStub<T>) => PromiseLike<R> | R): Promise<R> {
    if (this.#revoked) throw new Error(this.#revoked);
    this.#check();
    return await Promise.race([use(this.#inner), this.#revocation.promise]);
  }
  write(data: string | Uint8Array) { return this.#call((inner) => (inner as RpcStub<NamedPty>).write(data)); }
  keys(keys: string[], options: KeysOptions = {}) { return this.#call((inner) => (inner as RpcStub<NamedPty>).keys(keys, options)); }
  resize(cols: number, rows: number) { return this.#call((inner) => (inner as RpcStub<NamedPty>).resize(cols, rows)); }
  capture(options: CaptureOptions = {}) { return this.#call((inner) => (inner as RpcStub<NamedPty>).capture(options)); }
  wait(options: WaitOptions) { return this.#call((inner) => (inner as RpcStub<NamedPty>).wait(options)); }
  /** Cap'n Web calls this once the caller releases it: the holder's handle ends its waits, its attachment detaches. */
  [Symbol.dispose]() {
    this.#scope?.delete(this);
    this.#inner[Symbol.dispose]();
  }
}
/** Each HeldControls' #call, for its subclasses; module-private, so that no RPC caller reaches it. */
const calls = new WeakMap<object, <R>(use: (inner: RpcStub<never>) => PromiseLike<R> | R) => Promise<R>>();

/** A handle on a held session, which its shell revokes as it revokes a NamedPty. */
class HeldNamedPty extends HeldControls<NamedPty> implements SessionHandle {
  #sessions: HeldSessions;
  #name: string;
  #held: Held;
  #scope?: HandleScope;
  constructor(sessions: HeldSessions, name: string, held: Held, scope?: HandleScope) {
    const inner = held.main.handle();
    super(inner, scope, () => sessions.resolve(name, held), () => inner[Symbol.dispose](), { exited: () => held.exited, owner: () => held.record.owner });
    this.#sessions = sessions;
    this.#name = name;
    this.#held = held;
    this.#scope = scope;
  }
  #call<R>(use: (inner: RpcStub<NamedPty>) => PromiseLike<R> | R) { return calls.get(this)!(use as never) as Promise<R>; }
  info() { return this.#call((inner) => inner.info()) as Promise<PtySessionInfo>; }
  busy() { return this.#call((inner) => inner.busy()) as Promise<boolean | null>; }
  /** The holder's attachment, which the daemon passes `sink` on to. */
  async attach(sink: PtySink, options: AttachOptions = {}) {
    if (!sink || (typeof sink !== "object" && typeof sink !== "function")) throw new Error("A PTY sink is required.");
    const inner = await this.#call((inner) => inner.attach(sink, options)) as unknown as RpcStub<PtyAttachment>;
    return new HeldAttachment(inner, this.#scope, () => this.#sessions.resolve(this.#name, this.#held));
  }
  async kill(): Promise<PtyExit> {
    await this.#call(() => undefined);
    return await this.#sessions.kill(this.#name, this.#held);
  }
}

/** One caller's attachment to a held session; revoking it detaches the viewer with the reason. */
class HeldAttachment extends HeldControls<PtyAttachment> {
  #inner: RpcStub<PtyAttachment>;
  constructor(inner: RpcStub<PtyAttachment>, scope: HandleScope | undefined, check: () => void) {
    super(inner, scope, check, (reason) => {
      // The sink hears why first, through detached(reason), as from a viewer in the daemon.
      void Promise.resolve(inner.detach(reason)).catch(() => {}).finally(() => inner[Symbol.dispose]());
    });
    this.#inner = inner;
  }
  detach() { void Promise.resolve(this.#inner.detach()).catch(() => {}); }
}
