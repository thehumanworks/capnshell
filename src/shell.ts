import { spawn, type ChildProcess } from "node:child_process";
import os from "node:os";
import { RpcTarget } from "capnweb";
import treeKill from "tree-kill";
import {
  accessPath, globFiles, makeDirectory, readDirectory, readFileChunk, statPath, writeWholeFile,
  type AccessOptions, type GlobOptions, type ReadFileOptions,
} from "./files.js";
import { bash, commandSchema, optionsSchema, powershell, powershellArgs, type RunOptions } from "./platform.js";
import {
  MAX_PTYS, NamedPty, openUnnamedPty, ptyOptionsSchema, PtyRegistry,
  type PtyOptions, type PtySession, type PtySessionInfo, type PtySessionOptions, type PtySink,
} from "./pty.js";

export { MAX_TIMEOUT_MS, type RunOptions } from "./platform.js";
export {
  MAX_DIRECTORY_ENTRIES, MAX_FILE_CHUNK_BYTES, MAX_GLOB_RESULTS, MAX_WRITE_BYTES,
  type AccessOptions, type DirectoryEntry, type FileChunk, type FileKind, type FileStat, type GlobOptions, type ReadFileOptions,
} from "./files.js";
export {
  MAX_NAMED_PTYS, MAX_PTY_BACKLOG_BYTES, MAX_PTY_INPUT_BYTES, MAX_SCREEN_HISTORY, sessionNameSchema,
  type AttachOptions, type CaptureOptions, type KeysOptions, type PtyExit, type PtyOptions, type PtyScreen,
  type PtySessionInfo, type PtySessionOptions, type PtySink, type PtyWait, type WaitOptions,
  NamedPty, PtyAttachment, PtyRegistry, PtySession,
} from "./pty.js";

export const MAX_OUTPUT_BYTES = 1024 * 1024;
/** Forks per shell that have not been released. */
export const MAX_FORKS = 32;
/** Commands running at once per shell. */
export const MAX_COMMANDS = 4;
/** Bytes per exec sink call at most. */
export const MAX_EXEC_CHUNK_BYTES = 64 * 1024;

export interface ShellInfo {
  platform: NodeJS.Platform;
  name: string;
  shell: "PowerShell" | "Bash";
  hostname: string;
  cwd: string;
  pid: number;
}
export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Signal numbers differ across operating systems; report the executor's value. */
  signalNumber: number | null;
  timedOut: boolean;
  truncated: boolean;
  elapsedMs: number;
}
/** How an exec command ended; its output went to the sink. */
export type ExecResult = Omit<RunResult, "stdout" | "stderr" | "truncated">;
/** Receives a command's output as it is produced. Each call is awaited before the next: acknowledging is the flow control. */
export interface ExecSink {
  output(stream: "stdout" | "stderr", data: Uint8Array): void | Promise<void>;
}

function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") {
    treeKill(child.pid, "SIGKILL", (error) => { if (error) child.kill(); });
  } else {
    // The detached spawn gives this command its own POSIX process group.
    // Signal the group atomically rather than racing a userspace PID-tree walk.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) child.kill("SIGKILL");
    }
  }
}

// Only these prototype methods are exported. Internal state uses JS #private fields.
/** This machine, as a peer's handshake describes it. */
export function localShellInfo(): ShellInfo {
  return {
    platform: process.platform,
    name: process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : process.env.WSL_DISTRO_NAME ? "wsl" : process.platform,
    shell: process.platform === "win32" ? "PowerShell" : "Bash",
    hostname: os.hostname(),
    cwd: os.homedir(),
    pid: process.pid,
  };
}

export class ShellApi extends RpcTarget {
  #children = new Set<ChildProcess>();
  #ptys = new Set<PtySession>();
  #forks = new Set<ShellApi>();
  #registry: PtyRegistry;
  #closed = false;
  /** Set on forks, which close with their parent and cannot fork again. */
  #onClose?: () => void;

  /** Named PTY sessions live in the registry, shared by this process's connections. */
  constructor(registry = new PtyRegistry()) {
    super();
    this.#registry = registry;
  }

  info(): ShellInfo { return localShellInfo(); }

  /** Start a command in a fresh noninteractive shell and resolve with how it ended once it has closed. */
  #start(command: string, options: RunOptions) {
    if (this.#closed) throw new Error("This shell session is closed.");
    // RPC callers are not necessarily TypeScript: validate at the trust boundary.
    // Stay below Windows' command-line limit after UTF-16/base64 encoding.
    commandSchema.parse(command);
    const { timeoutMs, cwd } = optionsSchema.parse(options);
    if (this.#children.size >= MAX_COMMANDS) throw new Error("Too many simultaneous commands.");

    const windows = process.platform === "win32";
    const executable = windows ? powershell() : bash;
    const args = windows ? powershellArgs(command, false) : ["--noprofile", "--norc", "-c", command];
    const started = Date.now();
    const child = spawn(executable, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: !windows,
    });
    this.#children.add(child);
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs) : undefined;
    const ended = new Promise<ExecResult>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        this.#children.delete(child);
      };
      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("close", (exitCode, signal) => {
        cleanup();
        resolve({
          exitCode,
          signal,
          signalNumber: signal ? os.constants.signals[signal] ?? null : null,
          timedOut,
          elapsedMs: Date.now() - started,
        });
      });
    });
    return { child, ended };
  }

  async run(command: string, options: RunOptions = {}): Promise<RunResult> {
    const { child, ended } = this.#start(command, options);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let remaining = MAX_OUTPUT_BYTES;
    let truncated = false;
    // Keep draining after the shared cap; max-buffer helpers usually kill the
    // process instead, which would change the shell's exit status and semantics.
    const capture = (chunks: Buffer[], data: Buffer) => {
      const length = Math.min(remaining, data.length);
      if (length) chunks.push(data.subarray(0, length));
      remaining -= length;
      if (length < data.length) truncated = true;
    };
    child.stdout.on("data", (data) => capture(stdout, data));
    child.stderr.on("data", (data) => capture(stderr, data));
    const result = await ended;
    return { ...result, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), truncated };
  }

  /**
   * Run a command as `run` does, but push its output to `sink` as it is produced,
   * in chunks of up to MAX_EXEC_CHUNK_BYTES, without an output cap. Each `output`
   * call is awaited before more is read, so a slow caller slows the command rather
   * than growing this process's memory. A sink that fails kills the command.
   */
  async exec(sink: ExecSink, command: string, options: RunOptions = {}): Promise<ExecResult> {
    if (!sink || (typeof sink !== "object" && typeof sink !== "function")) throw new Error("An exec sink is required.");
    const { child, ended } = this.#start(command, options);
    let pending = Promise.resolve();
    let waiting = 0;
    let failure: unknown;
    const forward = (stream: "stdout" | "stderr", data: Buffer) => {
      if (failure !== undefined) return;
      waiting++;
      child.stdout.pause();
      child.stderr.pause();
      pending = pending.then(async () => {
        for (let offset = 0; offset < data.length && failure === undefined; offset += MAX_EXEC_CHUNK_BYTES) {
          await sink.output(stream, new Uint8Array(data.buffer, data.byteOffset + offset, Math.min(MAX_EXEC_CHUNK_BYTES, data.length - offset)));
        }
      }).catch((error: unknown) => {
        if (failure !== undefined) return;
        failure = error ?? new Error("The exec sink failed.");
        killTree(child);
      }).finally(() => {
        if (--waiting === 0 && failure === undefined) {
          child.stdout.resume();
          child.stderr.resume();
        }
      });
    };
    child.stdout.on("data", (data: Buffer) => forward("stdout", data));
    child.stderr.on("data", (data: Buffer) => forward("stderr", data));
    const result = await ended;
    await pending;
    if (failure !== undefined) throw failure;
    return result;
  }

  /** Describe a file or directory; a system error such as ENOENT is thrown when there is none. */
  async stat(path: string) {
    if (this.#closed) throw new Error("This shell session is closed.");
    return statPath(path);
  }

  /** Resolve when the path is readable, and writable with `{ write: true }`. */
  async access(path: string, options: AccessOptions = {}) {
    if (this.#closed) throw new Error("This shell session is closed.");
    return accessPath(path, options);
  }

  async readdir(path: string) {
    if (this.#closed) throw new Error("This shell session is closed.");
    return readDirectory(path);
  }

  /** Create a directory and its missing parents. */
  async mkdir(path: string) {
    if (this.#closed) throw new Error("This shell session is closed.");
    return makeDirectory(path);
  }

  /** Absolute paths of the files under `cwd` that match a glob pattern. */
  async glob(pattern: string, cwd: string, options: GlobOptions = {}) {
    if (this.#closed) throw new Error("This shell session is closed.");
    return globFiles(pattern, cwd, options);
  }

  /** Up to MAX_FILE_CHUNK_BYTES of a file from `offset`; read a larger file in several calls. */
  async readFile(path: string, options: ReadFileOptions = {}) {
    if (this.#closed) throw new Error("This shell session is closed.");
    return readFileChunk(path, options);
  }

  /** Replace a file's contents atomically with up to MAX_WRITE_BYTES. */
  async writeFile(path: string, data: Uint8Array) {
    if (this.#closed) throw new Error("This shell session is closed.");
    return writeWholeFile(path, data);
  }

  /**
   * Start a program on a pseudo-terminal so interactive CLIs and TUIs render. Output
   * and the final status are pushed to the caller's sink; the returned session takes
   * input, resizes, renders its screen on request and hangs up. Release the session
   * when done with it: that also hangs up and frees its screen.
   */
  openPty(sink: PtySink, options: PtyOptions = {}): PtySession {
    if (this.#closed) throw new Error("This shell session is closed.");
    if (!sink || (typeof sink !== "object" && typeof sink !== "function")) throw new Error("A PTY sink is required.");
    const parsed = ptyOptionsSchema.parse(options);
    // Sessions count until released, because their screens remain capturable.
    if (this.#ptys.size >= MAX_PTYS) throw new Error("Too many PTY sessions; release finished ones first.");
    const session = openUnnamedPty(sink, parsed, (released) => this.#ptys.delete(released));
    this.#ptys.add(session);
    return session;
  }

  /**
   * Start a named PTY session without a viewer. It belongs to this process rather
   * than the connection, so later connections can reach it with ptySession(name).
   */
  startPtySession(name: string, options: PtySessionOptions = {}): NamedPty {
    if (this.#closed) throw new Error("This shell session is closed.");
    return new NamedPty(this.#registry, name, this.#registry.start(name, options));
  }

  /** A handle on a named session. Releasing the handle leaves the session running. */
  ptySession(name: string): NamedPty {
    if (this.#closed) throw new Error("This shell session is closed.");
    return new NamedPty(this.#registry, name, this.#registry.get(name));
  }

  ptySessions(): PtySessionInfo[] {
    if (this.#closed) throw new Error("This shell session is closed.");
    return this.#registry.list();
  }

  /**
   * Another shell on this peer with its own command limit, sharing its named sessions.
   * Releasing the fork kills the commands it started and closes its unnamed PTYs, so a
   * caller can cancel a run without closing the connection.
   */
  fork(): ShellApi {
    if (this.#closed) throw new Error("This shell session is closed.");
    // One level only, so MAX_FORKS bounds what a connection can hold.
    if (this.#onClose) throw new Error("A forked shell cannot fork; fork the original shell.");
    if (this.#forks.size >= MAX_FORKS) throw new Error("Too many forked shells; release some first.");
    const fork = new ShellApi(this.#registry);
    fork.#onClose = () => this.#forks.delete(fork);
    this.#forks.add(fork);
    return fork;
  }

  [Symbol.dispose]() {
    if (this.#closed) return;
    this.#closed = true;
    for (const child of this.#children) killTree(child);
    for (const pty of this.#ptys) pty[Symbol.dispose]();
    for (const fork of this.#forks) fork[Symbol.dispose]();
    this.#onClose?.();
  }
}
