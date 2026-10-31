import { randomBytes } from "node:crypto";
import path from "node:path";
import { newWebSocketRpcSession, RpcTarget, type RpcStub } from "capnweb";
import type { ControlConnection } from "../src/commands/daemon.js";
import { closeSocket, forkShell, openSocket } from "../src/connect.js";
import { errorMessage } from "../src/errors.js";
import { RefusingShell } from "../src/refusing-shell.js";
import {
  MAX_FILE_CHUNK_BYTES, MAX_GLOB_RESULTS, MAX_TIMEOUT_MS, MAX_WRITE_BYTES,
  type DirectoryEntry, type ExecSink, type FileStat, type ShellApi, type ShellInfo,
} from "../src/shell.js";
import { plain } from "../src/terminal.js";
import { targetLabel, type Target } from "./target.js";

/** The largest file read whole over cns, for read and edit. */
export const MAX_READ_BYTES = 32 * 1024 * 1024;
/** Commands up to this long are sent as they are; longer ones are uploaded as a script. */
const MAX_INLINE_COMMAND = 8192;
/** File chunks requested at once. */
const READ_CONCURRENCY = 4;
const HANDSHAKE_MS = 10_000;
/** How long past its timeout a command may take to report it before it is abandoned here. */
const TIMEOUT_GRACE_MS = 5_000;

/** A system error from the host, such as ENOENT, which means the host answered. */
const isSystemError = (error: unknown) => /^E[A-Z]+\b/.test(errorMessage(error));

const posix = path.posix;

/** Part of a file, as readChunk returns it. */
export interface FileChunk { data: Buffer; size: number; eof: boolean }
/** One POSIX shell word. */
export const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

type OnData = (data: Buffer, stream: "stdout" | "stderr") => void;

/** Receives exec output; Cap'n Web passes it by reference. */
class DataSink extends RpcTarget implements ExecSink {
  #onData: OnData;
  constructor(onData: OnData) {
    super();
    this.#onData = onData;
  }
  output(stream: "stdout" | "stderr", data: Uint8Array) { this.#onData(Buffer.from(data), stream); }
}

export interface ExecOptions {
  onData: OnData;
  signal?: AbortSignal;
  /** Seconds, as Pi's bash tool takes it. */
  timeout?: number;
}

/**
 * A cns peer the tools can run on: its shell over one connection, which this
 * process never offers its own shell or files back on. Once the connection
 * breaks, every call fails; nothing falls back to this machine.
 */
export class Host {
  readonly target: Target;
  readonly label: string;
  readonly info: ShellInfo;
  /** The peer's home directory; `~` in tool paths means this. */
  readonly home: string;
  cwd: string;
  #shell: RpcStub<ShellApi>;
  #release: () => void;
  #fork: () => Promise<RpcStub<ShellApi>>;
  #verify?: () => Promise<boolean>;
  #lost: string | undefined;
  #closed = false;
  #lostListeners = new Set<(reason: string) => void>();
  #scripts: Promise<string> | undefined;

  /**
   * `fork` returns a shell of the host's own for one command, which releasing kills;
   * `verify` checks whether the host is still there after a call fails.
   */
  constructor(target: Target, info: ShellInfo, shell: RpcStub<ShellApi>, options: {
    release: () => void;
    fork: () => Promise<RpcStub<ShellApi>>;
    verify?: () => Promise<boolean>;
  }) {
    this.target = target;
    this.label = targetLabel(target);
    this.info = info;
    this.home = info.cwd;
    this.cwd = info.cwd;
    this.#shell = shell;
    this.#release = options.release;
    this.#fork = options.fork;
    this.#verify = options.verify;
  }

  /** Why the connection broke, once it has. */
  get lost() { return this.#lost; }

  markLost(reason: string) {
    if (this.#lost || this.#closed) return;
    this.#lost = reason;
    for (const listener of this.#lostListeners) listener(reason);
  }

  onLost(listener: (reason: string) => void) { this.#lostListeners.add(listener); }

  /** `p1: build-box (Linux, Bash)`. */
  describe() {
    const platform = this.info.platform === "darwin" ? "macOS" : this.info.platform === "linux" ? "Linux" : this.info.platform;
    return `${this.label}: ${this.info.hostname} (${platform}, ${this.info.shell})`;
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#release();
  }

  /** A path on the host: `~` is its home, and relative paths start at `base`. */
  resolve(value: string, base = this.cwd): string {
    if (value === "~") return this.home;
    if (value.startsWith("~/")) return posix.join(this.home, value.slice(2));
    return posix.resolve(base, value);
  }

  async #call<T>(call: (shell: RpcStub<ShellApi>) => Promise<T>): Promise<T> {
    if (this.#closed) throw new Error(`The connection to ${this.label} is closed.`);
    if (this.#lost) throw new Error(lostMessage(this));
    try {
      return await call(this.#shell);
    } catch (error) {
      if (!this.#lost && !this.#closed && !isSystemError(error) && this.#verify && !(await this.#verify().catch(() => false))) {
        this.markLost(errorMessage(error));
      }
      if (this.#lost) throw new Error(lostMessage(this));
      throw error;
    }
  }

  stat(file: string): Promise<FileStat> { return this.#call((shell) => plain(shell.stat(file))); }

  /** Whether a path exists, as Pi's existsSync answers: any system error means no. */
  async exists(file: string): Promise<boolean> {
    try {
      await this.stat(file);
      return true;
    } catch (error) {
      if (this.#lost || !isSystemError(error)) throw error;
      return false;
    }
  }

  access(file: string, write = false): Promise<void> { return this.#call(async (shell) => { await shell.access(file, { write }); }); }
  readdir(directory: string): Promise<DirectoryEntry[]> { return this.#call((shell) => plain(shell.readdir(directory))); }
  mkdir(directory: string): Promise<void> { return this.#call(async (shell) => { await shell.mkdir(directory); }); }

  glob(pattern: string, cwd: string, options: { ignore: string[]; limit: number; directories?: boolean }): Promise<string[]> {
    const limit = Math.max(1, Math.min(MAX_GLOB_RESULTS, Math.floor(options.limit)));
    return this.#call((shell) => plain(shell.glob(pattern, cwd, { ignore: options.ignore, limit, directories: options.directories ?? false })));
  }

  /** Up to MAX_FILE_CHUNK_BYTES of a file from `offset`, and the file's size then. */
  async readChunk(file: string, offset = 0): Promise<FileChunk> {
    const chunk = await this.#call((shell) => plain(shell.readFile(file, { offset })));
    return { data: Buffer.from(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength), size: chunk.size, eof: chunk.eof };
  }

  /**
   * A whole file of up to MAX_READ_BYTES, starting from its `first` chunk if one
   * was read already. A file that changes size while it is read is read again.
   */
  async readWhole(file: string, first?: FileChunk): Promise<Buffer> {
    for (let attempt = 0; attempt < 3; attempt++, first = undefined) {
      const head = first ?? await this.readChunk(file);
      if (head.size > MAX_READ_BYTES) {
        throw new Error(`${file} is ${head.size} bytes; cns reads files of up to ${MAX_READ_BYTES} bytes whole. Use bash with head, tail or sed.`);
      }
      const offsets: number[] = [];
      for (let offset = head.data.byteLength; offset < head.size; offset += MAX_FILE_CHUNK_BYTES) offsets.push(offset);
      const chunks = [head.data];
      let changed = false;
      for (let index = 0; index < offsets.length && !changed; index += READ_CONCURRENCY) {
        const batch = await Promise.all(offsets.slice(index, index + READ_CONCURRENCY).map((offset) => this.readChunk(file, offset)));
        for (const chunk of batch) {
          if (chunk.size !== head.size) changed = true;
          chunks.push(chunk.data);
        }
      }
      const data = chunks.length === 1 ? head.data : Buffer.concat(chunks);
      if (!changed && data.byteLength === head.size) return data;
    }
    throw new Error(`${file} kept changing while it was read.`);
  }

  async writeWhole(file: string, data: Uint8Array): Promise<void> {
    if (data.byteLength > MAX_WRITE_BYTES) {
      throw new Error(`cns writes files of up to ${MAX_WRITE_BYTES} bytes; ${file} would be ${data.byteLength}.`);
    }
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    await this.#call(async (shell) => { await shell.writeFile(file, bytes); });
  }

  /** Run a short command whose output does not matter, and return its exit code. */
  async #quietly(command: string): Promise<number | null> {
    const fork = await this.#call(() => this.#fork());
    try {
      const result = await this.#call(() => plain(fork.exec(new DataSink(() => {}), command, { cwd: this.home })));
      return result.exitCode;
    } finally {
      fork[Symbol.dispose]();
    }
  }

  /** Where long commands are uploaded: a directory in the host's home that only its user can read. */
  #scriptDirectory(): Promise<string> {
    this.#scripts ??= (async () => {
      const directory = posix.join(this.home, ".cns", "scripts");
      // An absolute path cannot be taken for an option, and BSD chmod has no `--`.
      const code = await this.#quietly(`umask 077 && mkdir -p ${quote(directory)} && chmod 700 ${quote(directory)}`);
      if (code !== 0) throw new Error(`Cannot create ${directory} on ${this.label} for a long command (exit ${code}).`);
      return directory;
    })();
    this.#scripts.catch(() => { this.#scripts = undefined; });
    return this.#scripts;
  }

  /** Upload a command too long to send as one; sourcing the script removes it first. */
  async #upload(command: string): Promise<string> {
    const script = posix.join(await this.#scriptDirectory(), `pi-${randomBytes(8).toString("hex")}.sh`);
    await this.writeWhole(script, new TextEncoder().encode(`rm -f -- ${quote(script)}\n${command}\n`));
    return script;
  }

  /**
   * Run a command as Pi's BashOperations do: stream its output, abort with
   * "aborted", time out with "timeout:<seconds>", and report a signal as 128 + its
   * number. Each command gets its own fork of the shell; releasing it kills the
   * command. An abort or timeout settles here at once, whatever the host does.
   * Commands too long to send are uploaded as a script that removes itself.
   */
  async exec(command: string, cwd: string, { onData, signal, timeout }: ExecOptions): Promise<{ exitCode: number | null }> {
    if (signal?.aborted) throw new Error("aborted");
    const timeoutMs = timeout && timeout > 0 ? Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.round(timeout * 1000))) : 0;
    let settled = false;
    let fork: RpcStub<ShellApi> | undefined;
    let script: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs) timer = setTimeout(() => reject(new Error(`timeout:${timeout}`)), Math.min(MAX_TIMEOUT_MS, timeoutMs + TIMEOUT_GRACE_MS));
    });
    stopped.catch(() => {});
    const race = <T>(work: Promise<T>) => Promise.race([work, stopped]);
    let succeeded = false;
    try {
      let run = command;
      if (command.length > MAX_INLINE_COMMAND) {
        script = await race(this.#upload(command));
        run = `. ${quote(script)}`;
      }
      const forking = this.#call(() => this.#fork());
      // A fork that arrives after an abort is released at once.
      forking.then((arrived) => { if (settled) arrived[Symbol.dispose](); else fork = arrived; }, () => {});
      const shell = await race(forking);
      const sink = new DataSink((data, stream) => { if (!settled) onData(data, stream); });
      const result = await race(this.#call(() => plain(shell.exec(sink, run, { cwd, timeoutMs }))));
      if (signal?.aborted) throw new Error("aborted");
      if (result.timedOut) throw new Error(`timeout:${timeout}`);
      succeeded = true;
      return { exitCode: result.exitCode ?? (result.signalNumber ? 128 + result.signalNumber : null) };
    } catch (error) {
      if (signal?.aborted) throw new Error("aborted");
      throw error;
    } finally {
      settled = true;
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      // Releasing the fork kills the command if it still runs.
      fork?.[Symbol.dispose]();
      // A script removes itself once it starts; one that never started would stay.
      if (script && !succeeded && !this.#lost && !this.#closed) void this.#quietly(`rm -f -- ${quote(script)}`).catch(() => {});
    }
  }
}

export function lostMessage(host: Host): string {
  return `The connection to ${host.label} (${host.info.hostname}) was lost: ${host.lost}. Nothing runs on this machine instead. Attach again, or detach to use this machine.`;
}

/** Check what the peer is before it is used: a POSIX shell with cns file operations. */
async function checked(host: Host): Promise<Host> {
  try {
    if (host.info.platform === "win32") {
      throw new Error(`${host.label} is a Windows peer. Pi's tools resolve paths as POSIX paths, so attaching to Windows is not supported yet; use /cns run.`);
    }
    // Older cns versions have no file operations.
    try { await host.stat(host.home); }
    catch (error) {
      if (error instanceof TypeError || /is not a function/.test(errorMessage(error))) {
        throw new Error(`${host.label} runs an older cns without file operations; update cns there.`);
      }
      throw error;
    }
    return host;
  } catch (error) {
    host.close();
    throw error;
  }
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not answer.`)), HANDSHAKE_MS); }),
  ]).finally(() => clearTimeout(timer));
}

/** Connect to a listener directly, offering it nothing but the handshake. */
export async function connectUrl(target: Extract<Target, { kind: "url" }>, signal: AbortSignal): Promise<Host> {
  const socket = await openSocket(target.url, signal);
  const shell = newWebSocketRpcSession<ShellApi>(socket, new RefusingShell());
  const release = () => {
    shell[Symbol.dispose]();
    closeSocket(socket, "Pi detached");
  };
  let info: ShellInfo;
  try { info = await withTimeout(plain(shell.info()), target.url); }
  catch (error) {
    release();
    throw error;
  }
  const host = new Host(target, info, shell, {
    release,
    async fork() {
      const fork = await forkShell(shell);
      if (!fork) throw new Error(`${target.url} runs a cns without fork; update it.`);
      return fork;
    },
  });
  shell.onRpcBroken((error) => host.markLost(errorMessage(error) || "the connection closed"));
  return checked(host);
}

/** Use a peer connected to this machine's daemon, through its control connection. */
export async function connectPeer(control: ControlConnection, target: Extract<Target, { kind: "peer" }>): Promise<Host> {
  let shell: RpcStub<ShellApi>;
  try { shell = await control.controller.shell(target.id); }
  catch (error) {
    if (/is not a function/.test(errorMessage(error))) {
      throw new Error("The running daemon's cns cannot share a peer's shell; restart it with this version (/cns stop, then /cns listen).");
    }
    throw error;
  }
  let info: ShellInfo;
  try { info = await withTimeout(plain(shell.info()), target.id); }
  catch (error) {
    shell[Symbol.dispose]();
    throw error;
  }
  // Peer IDs are never reused while the daemon runs, so a peer that left stays gone.
  const verify = async () => (await control.controller.peers()).some((peer) => peer.id === target.id && peer.info.pid === info.pid);
  // The daemon's shell is already a fork, which cannot fork again: ask the daemon for another.
  const host = new Host(target, info, shell, { release: () => shell[Symbol.dispose](), fork: () => control.controller.shell(target.id), verify });
  control.remote.onRpcBroken(() => host.markLost("the local daemon stopped"));
  return checked(host);
}
